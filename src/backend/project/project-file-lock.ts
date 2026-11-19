import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import lockfile from "proper-lockfile";
import { acquire_no_delete_guard, type FileLockGuard } from "../../native/file-lock";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

type ProjectLockLocation = "user_data" | "temp";

type ProjectLockCandidate = Readonly<{
  location: ProjectLockLocation;
  target: string; // proper-lockfile 的身份路径，不要求真实存在。
  lockfile_path: string; // 实际创建的 .lock 目录，使用哈希身份。
  parent: string; // 锁目录的父目录。
}>;

type ProjectLockFailure = Readonly<{ location: ProjectLockLocation; error: unknown }>;

type ProjectFileLockOptions = Readonly<{
  data_root: string; // 应用可写根，参与独占的用户数据位置。
  temp_root?: string; // 测试可注入独立临时根。
  native_fs?: NativeFs;
  on_compromised?: (info: { location: ProjectLockLocation; error: unknown }) => void;
  guard_factory?: (lock_directory: string) => FileLockGuard | null;
  stale?: number; // 测试可注入较短的 stale/update，缩短心跳等待。
  update?: number;
}>;

type AcquiredLock = Readonly<{
  location: ProjectLockLocation;
  release: () => Promise<void>;
  guard: FileLockGuard | null;
}>;

const TEMP_REGISTRY_DIR = "linguagacha-project-locks";
const USER_DATA_REGISTRY_DIR = "project-locks";

/**
 * 同一个 .lg 的运行期独占。锁产物只放在应用数据根和系统临时目录，
 * 两者都不是用户日常清理的目录；不再在工程旁创建可见的锁目录。
 *
 * 不直接锁定 .lg：SQLite 需要持续打开该文件，外部独占句柄会破坏数据库访问。
 */
export class ProjectFileLock {
  private released = false;

  private constructor(
    public readonly identity: string, // 路径身份，供同一实例判断 reload。
    private readonly acquired: readonly AcquiredLock[],
    private readonly compromised: ReadonlySet<ProjectLockLocation>,
  ) {}

  /** 多个可写位置同时持锁，避免权限差异导致两个实例各用一套锁。 */
  public static async acquire(
    project_path: string,
    options: ProjectFileLockOptions,
  ): Promise<ProjectFileLock> {
    const native_fs = options.native_fs ?? default_native_fs;
    const guard_factory = options.guard_factory ?? acquire_no_delete_guard;
    const identity = resolve_project_file_identity(project_path, native_fs);
    const acquired: AcquiredLock[] = [];
    const compromised = new Set<ProjectLockLocation>();
    const failures: ProjectLockFailure[] = [];
    const attempted = new Set<string>();

    for (const candidate of build_candidates(identity, options)) {
      const lockfile_path = path.resolve(candidate.lockfile_path);
      if (attempted.has(lockfile_path)) continue;
      attempted.add(lockfile_path);
      try {
        native_fs.make_dir(candidate.parent);
      } catch (error) {
        failures.push({ location: candidate.location, error });
        continue;
      }
      try {
        const release = await lockfile.lock(candidate.target, {
          realpath: false,
          lockfilePath: candidate.lockfile_path,
          retries: 0,
          // undefined 会覆盖 proper-lockfile 的默认值，只在显式注入时传入。
          ...(options.stale === undefined ? {} : { stale: options.stale }),
          ...(options.update === undefined ? {} : { update: options.update }),
          // 删除锁目录只记录降级，不抛出；proper-lockfile 默认会 throw 并触发 fatal。
          onCompromised: (error: unknown) => {
            compromised.add(candidate.location);
            options.on_compromised?.({ location: candidate.location, error });
          },
        });
        const guard = guard_factory(candidate.lockfile_path);
        acquired.push({ location: candidate.location, release, guard });
      } catch (error) {
        if (is_lock_conflict(error)) {
          await release_all(acquired);
          throw new AppError("project.in_use", {
            diagnostic_context: { operation: "acquire_project_lock", location: candidate.location },
          });
        }
        failures.push({ location: candidate.location, error });
      }
    }

    if (acquired.length === 0) {
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
    return new ProjectFileLock(identity, acquired, compromised);
  }

  /** 关闭工程会话时释放全部位置，单个失败不影响其它锁的回收。 */
  public async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    const results = await Promise.allSettled(
      this.acquired.map(async (entry) => {
        // 先关掉禁止删除的句柄，否则 rmdir 会因共享模式失败并留下残留锁。
        entry.guard?.close();
        // 已被 proper-lockfile 判定失效的锁不再 release，避免 ENOTACQUIRED。
        if (this.compromised.has(entry.location)) return;
        await entry.release();
      }),
    );
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
  return resolve_project_file(project_path, native_fs);
}

/** 先取真实路径，再按平台归一化，使大小写和链接差异落到同一把锁。 */
function resolve_project_file(project_path: string, native_fs: NativeFs): string {
  const resolved_path = path.resolve(project_path);
  const canonical_path = native_fs.exists(resolved_path)
    ? native_fs.real_path(resolved_path)
    : resolved_path;
  return native_fs.to_identity_path(canonical_path);
}

/** 应用数据根优先，系统临时目录兜底；两者都只是不可见的哈希目录。 */
function build_candidates(
  identity: string,
  options: ProjectFileLockOptions,
): readonly ProjectLockCandidate[] {
  const hash = createHash("sha256").update(identity).digest("hex");
  const temp_root = path.resolve(options.temp_root ?? os.tmpdir());
  const temp_directory = path.join(temp_root, TEMP_REGISTRY_DIR);
  const data_directory = path.join(path.resolve(options.data_root), USER_DATA_REGISTRY_DIR);
  return [
    {
      location: "user_data",
      target: path.join(data_directory, hash),
      lockfile_path: path.join(data_directory, `${hash}.lock`),
      parent: data_directory,
    },
    {
      location: "temp",
      target: path.join(temp_directory, hash),
      lockfile_path: path.join(temp_directory, `${hash}.lock`),
      parent: temp_directory,
    },
  ];
}

/** proper-lockfile 用 ELOCKED 表达目标已被其它进程持有。 */
function is_lock_conflict(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ELOCKED";
}

/** 冲突路径只需尽力回滚，残留锁会在 stale 后自动失效。 */
async function release_all(acquired: readonly AcquiredLock[]): Promise<void> {
  await Promise.allSettled(
    acquired.map(async (entry) => {
      entry.guard?.close();
      await entry.release();
    }),
  );
}
