import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

type ProjectLockLocation = "project" | "temp" | "user_data";

type ProjectLockCandidate = Readonly<{
  location: ProjectLockLocation;
  target: string; // proper-lockfile 的身份路径，不要求真实存在。
  lockfile_path: string; // 实际创建的 .lock 目录；工程旁用点号名，其它位置用哈希。
  parent: string; // 锁目录的父目录。
  create_parent: boolean; // 工程目录不可由打开动作创建。
}>;

type ProjectLockFailure = Readonly<{ location: ProjectLockLocation; error: unknown }>;

type ProjectFileLockOptions = Readonly<{
  data_root: string; // 参与独占的应用可写根，覆盖同实例目录内的再次打开。
  temp_root?: string; // 测试可注入独立临时根。
  native_fs?: NativeFs;
}>;

const TEMP_REGISTRY_DIR = "linguagacha-project-locks";
const USER_DATA_REGISTRY_DIR = "project-locks";

/**
 * 同一个 .lg 的运行期独占。锁产物同时放在工程旁、系统临时目录和应用数据根，
 * 任一可访问位置被占用都视为该工程已被打开。
 *
 * 不直接锁定 .lg：SQLite 需要持续打开该文件，外部独占句柄会破坏数据库访问。
 */
export class ProjectFileLock {
  private released = false;

  private constructor(
    public readonly identity: string, // 路径身份，供同一实例判断 reload。
    private readonly releases: readonly (() => Promise<void>)[],
  ) {}

  /** 多个可写位置同时持锁，避免权限差异导致两个实例各用一套锁。 */
  public static async acquire(
    project_path: string,
    options: ProjectFileLockOptions,
  ): Promise<ProjectFileLock> {
    const native_fs = options.native_fs ?? default_native_fs;
    const { canonical_path, identity } = resolve_project_file(project_path, native_fs);
    const releases: Array<() => Promise<void>> = [];
    const failures: ProjectLockFailure[] = [];
    const attempted = new Set<string>();

    for (const candidate of build_candidates(canonical_path, identity, options)) {
      const lockfile_path = path.resolve(candidate.lockfile_path);
      if (attempted.has(lockfile_path)) continue;
      attempted.add(lockfile_path);
      if (candidate.create_parent) {
        try {
          native_fs.make_dir(candidate.parent);
        } catch (error) {
          failures.push({ location: candidate.location, error });
          continue;
        }
      }
      try {
        releases.push(
          await lockfile.lock(candidate.target, {
            realpath: false,
            lockfilePath: candidate.lockfile_path,
            retries: 0,
          }),
        );
      } catch (error) {
        if (is_lock_conflict(error)) {
          await release_all(releases);
          throw new AppError("project.in_use", {
            diagnostic_context: { operation: "acquire_project_lock", location: candidate.location },
          });
        }
        failures.push({ location: candidate.location, error });
      }
    }

    if (releases.length === 0) {
      throw new AppError("project.lock_unavailable", {
        diagnostic_context: {
          operation: "acquire_project_lock",
          failures: failures.map(
            ({ location, error }) =>
              `${location}: ${error instanceof Error ? error.message : String(error)}`,
          ),
        },
      });
    }
    return new ProjectFileLock(identity, releases);
  }

  /** 关闭工程会话时释放全部位置，单个失败不影响其它锁的回收。 */
  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const results = await Promise.allSettled(this.releases.map((release) => release()));
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to release the project file lock.");
    }
  }
}

/** 返回同一 .lg 的稳定身份，供 reload 判断与锁键复用。 */
export function resolve_project_file_identity(
  project_path: string,
  native_fs: NativeFs = default_native_fs,
): string {
  return resolve_project_file(project_path, native_fs).identity;
}

/** 先取真实路径，再按平台归一化，使大小写和链接差异落到同一把锁。 */
function resolve_project_file(
  project_path: string,
  native_fs: NativeFs,
): { canonical_path: string; identity: string } {
  const resolved_path = path.resolve(project_path);
  const canonical_path = native_fs.exists(resolved_path)
    ? native_fs.real_path(resolved_path)
    : resolved_path;
  return { canonical_path, identity: native_fs.to_identity_path(canonical_path) };
}

/** 三个位置都尝试；工程旁保留可读名称，temp 与应用数据根使用哈希身份。 */
function build_candidates(
  canonical_path: string,
  identity: string,
  options: ProjectFileLockOptions,
): readonly ProjectLockCandidate[] {
  const hash = createHash("sha256").update(identity).digest("hex");
  const temp_root = path.resolve(options.temp_root ?? os.tmpdir());
  const temp_directory = path.join(temp_root, TEMP_REGISTRY_DIR);
  const data_directory = path.join(path.resolve(options.data_root), USER_DATA_REGISTRY_DIR);
  return [
    {
      location: "project",
      target: canonical_path,
      lockfile_path: path.join(
        path.dirname(canonical_path),
        `.${path.basename(canonical_path)}.lock`,
      ),
      parent: path.dirname(canonical_path),
      create_parent: false,
    },
    {
      location: "temp",
      target: path.join(temp_directory, hash),
      lockfile_path: path.join(temp_directory, `${hash}.lock`),
      parent: temp_directory,
      create_parent: true,
    },
    {
      location: "user_data",
      target: path.join(data_directory, hash),
      lockfile_path: path.join(data_directory, `${hash}.lock`),
      parent: data_directory,
      create_parent: true,
    },
  ];
}

/** proper-lockfile 用 ELOCKED 表达目标已被其它进程持有。 */
function is_lock_conflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED";
}

/** 冲突路径只需尽力回滚，残留锁会在 stale 后自动失效。 */
async function release_all(releases: readonly (() => Promise<void>)[]): Promise<void> {
  await Promise.allSettled(releases.map((release) => release()));
}
