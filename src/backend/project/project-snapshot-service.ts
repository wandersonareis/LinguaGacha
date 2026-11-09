import { createHash } from "node:crypto";
import path from "node:path";
import type { AppMetadataService } from "../app/app-metadata-service";
import type { AppPathService } from "../app/app-path-service";
import type { AppSettingService } from "../app/app-setting-service";
import type { ProjectDatabase } from "../database/database-operations";
import type { LogManager } from "../log/log-manager";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";
import { normalize_project_snapshot_limit } from "../../domain/setting";
import { resolve_project_file_identity } from "./project-file-lock";

export const PROJECT_SNAPSHOT_REASONS = [
  "manual",
  "before-agent-apply",
  "before-workspace-run",
  "before-batch-translation",
  "before-project-migration",
  "before-restore",
] as const;

export type ProjectSnapshotReason = (typeof PROJECT_SNAPSHOT_REASONS)[number];

export type ProjectSnapshot = Readonly<{
  file: string; // 快照目录内的稳定文件名。
  created_at: string; // ISO 时间，列表按它倒序。
  reason: ProjectSnapshotReason;
  app_version: string;
  size: number;
}>;

export type ProjectSnapshotDescription = Readonly<{
  directory: string;
  limit: number;
  latest: ProjectSnapshot | null;
  count: number;
}>;

type SnapshotManifest = {
  project_path: string;
  project_identity: string;
  snapshots: ProjectSnapshot[];
};

const MANIFEST_FILE = "manifest.json";
const BACKUP_ROOT = ["backups", "projects"] as const;
const FILE_SUFFIX = ".lg";

/**
 * 工程自动快照。写入 `userdata/backups/projects/<nome>-<hash8>/`，
 * 用 `VACUUM INTO` 生成包含 WAL 的一致性副本，并在保留数量超出后删除最旧的快照。
 *
 * 该服务不取得运行门禁；调用方必须已在项目写或 Agent 写租约内。
 */
export class ProjectSnapshotService {
  private readonly queues = new Map<string, Promise<void>>(); // 同一工程的 manifest 写入串行。
  private readonly round_snapshots = new Map<string, string>(); // 每轮 workspace_run 只备份一次。

  public constructor(
    private readonly paths: Pick<AppPathService, "get_user_data_path">,
    private readonly database: Pick<ProjectDatabase, "export_snapshot">,
    private readonly settings: Pick<AppSettingService, "read_setting">,
    private readonly metadata: Pick<AppMetadataService, "read_version_or_default">,
    private readonly log_manager: Pick<LogManager, "warning">,
    private readonly native_fs: NativeFs = default_native_fs,
    private readonly enabled = true,
  ) {}

  /** 当前保留数量；0 表示用户明确关闭自动快照。 */
  public current_limit(): number {
    return this.enabled
      ? normalize_project_snapshot_limit(this.settings.read_setting()["project_snapshot_limit"])
      : 0;
  }

  /** 创建快照；关闭时返回 null。失败抛出 project.snapshot_failed，调用方应中止风险操作。 */
  public async create(
    project_path: string,
    reason: ProjectSnapshotReason,
  ): Promise<ProjectSnapshot | null> {
    if (!this.enabled) return null;
    const limit = this.current_limit();
    if (limit <= 0) return null;
    const directory = this.directory(project_path);
    const created_at = new Date().toISOString();
    const file = `${created_at.replace(/[:.]/g, "-")}_${reason}${FILE_SUFFIX}`;
    const target_path = path.join(directory, file);
    const temporary_path = `${target_path}.tmp`;
    try {
      this.native_fs.make_dir(directory);
      await this.database.export_snapshot(project_path, temporary_path);
      this.native_fs.rename(temporary_path, target_path);
    } catch (error) {
      this.remove_best_effort(temporary_path);
      throw new AppError("project.snapshot_failed", {
        message:
          "The project could not be backed up, so the operation was cancelled to protect your translations.",
        cause: error,
        diagnostic_context: { operation: "create_snapshot", reason },
      });
    }
    const snapshot: ProjectSnapshot = {
      file,
      created_at,
      reason,
      app_version: this.metadata.read_version_or_default(),
      size: this.native_fs.stat(target_path).size,
    };
    await this.serialize(directory, async () => {
      await this.write_manifest(project_path, directory, limit);
    });
    return snapshot;
  }

  /** 每个 Agent 轮次只备份一次脚本前状态；workspace_apply 仍会单独备份。 */
  public async create_for_round(
    project_path: string,
    round_id: string | null,
    reason: ProjectSnapshotReason,
  ): Promise<ProjectSnapshot | null> {
    if (round_id === null) return await this.create(project_path, reason);
    const key = resolve_project_file_identity(project_path, this.native_fs);
    if (this.round_snapshots.get(key) === round_id) return null;
    const snapshot = await this.create(project_path, reason);
    if (snapshot !== null) this.round_snapshots.set(key, round_id);
    return snapshot;
  }

  /** 读取当前工程快照，manifest 丢失时回退到目录扫描。 */
  public async list(project_path: string): Promise<ProjectSnapshot[]> {
    const directory = this.directory(project_path);
    const manifest = this.read_manifest(directory);
    const snapshots = new Map(
      (manifest?.snapshots ?? []).map((snapshot) => [snapshot.file, snapshot]),
    );
    if (this.native_fs.exists(directory)) {
      for (const entry of this.native_fs.read_dirents(directory)) {
        if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX) || snapshots.has(entry.name))
          continue;
        const file_path = path.join(directory, entry.name);
        const stat = this.native_fs.stat(file_path);
        snapshots.set(entry.name, {
          file: entry.name,
          created_at: new Date(stat.mtimeMs).toISOString(),
          reason: read_reason(entry.name),
          app_version: "",
          size: stat.size,
        });
      }
    }
    return [...snapshots.values()]
      .filter((snapshot) => this.native_fs.exists(path.join(directory, snapshot.file)))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  /** 提供给工作区 project_meta.json 的 Agent 可读摘要。 */
  public async describe(project_path: string): Promise<ProjectSnapshotDescription> {
    const snapshots = await this.list(project_path);
    return {
      directory: this.directory(project_path),
      limit: this.current_limit(),
      latest: snapshots[0] ?? null,
      count: snapshots.length,
    };
  }

  /** 快照版本必须与当前应用一致；旧版本快照仍可用完整 `.lg` 手动恢复。 */
  public is_compatible(snapshot: ProjectSnapshot): boolean {
    return (
      snapshot.app_version === "" ||
      snapshot.app_version === this.metadata.read_version_or_default()
    );
  }

  /** 校验 Agent/UI 传入的文件名，只允许本工程快照目录中的直接文件名。 */
  public resolve(
    project_path: string,
    file: unknown,
  ): { snapshot: ProjectSnapshot; file_path: string } {
    if (
      typeof file !== "string" ||
      file === "" ||
      path.basename(file) !== file ||
      !file.endsWith(FILE_SUFFIX) ||
      file.includes("\0") ||
      file.startsWith(".")
    ) {
      throw new AppError("request.validation_failed");
    }
    const directory = this.directory(project_path);
    const file_path = path.join(directory, file);
    if (!this.native_fs.exists(file_path)) {
      throw new AppError("project.snapshot_not_found");
    }
    const manifest = this.read_manifest(directory);
    const snapshot = manifest?.snapshots.find((entry) => entry.file === file) ?? {
      file,
      created_at: new Date(this.native_fs.stat(file_path).mtimeMs).toISOString(),
      reason: read_reason(file),
      app_version: "",
      size: this.native_fs.stat(file_path).size,
    };
    return { snapshot, file_path };
  }

  /** 快照目录按工程路径身份稳定寻址，工程移动后旧备份仍保留在原目录。 */
  public directory(project_path: string): string {
    const identity = resolve_project_file_identity(project_path, this.native_fs);
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
    const base =
      sanitize_name(path.basename(project_path, path.extname(project_path))) || "project";
    return this.paths.get_user_data_path(...BACKUP_ROOT, `${base}-${hash}`);
  }

  private async write_manifest(
    project_path: string,
    directory: string,
    limit: number,
  ): Promise<void> {
    const manifest = this.read_manifest(directory) ?? {
      project_path,
      project_identity: resolve_project_file_identity(project_path, this.native_fs),
      snapshots: [],
    };
    const snapshots = await this.list(project_path);
    const kept = snapshots.slice(0, limit);
    const kept_names = new Set(kept.map((snapshot) => snapshot.file));
    for (const snapshot of snapshots) {
      if (!kept_names.has(snapshot.file))
        this.remove_best_effort(path.join(directory, snapshot.file));
    }
    const next_manifest: SnapshotManifest = {
      project_path,
      project_identity: manifest.project_identity,
      snapshots: kept,
    };
    try {
      this.native_fs.write_file_atomic(
        path.join(directory, MANIFEST_FILE),
        JSON.stringify(next_manifest, null, 2),
      );
    } catch (error) {
      this.report_warning("write_manifest", error);
    }
  }

  private read_manifest(directory: string): SnapshotManifest | null {
    const manifest_path = path.join(directory, MANIFEST_FILE);
    if (!this.native_fs.exists(manifest_path)) return null;
    try {
      const value: unknown = JSON.parse(this.native_fs.read_text_file(manifest_path));
      if (typeof value !== "object" || value === null) return null;
      const record = value as Record<string, unknown>;
      if (!Array.isArray(record["snapshots"])) return null;
      const snapshots = record["snapshots"].filter(is_project_snapshot);
      return {
        project_path: typeof record["project_path"] === "string" ? record["project_path"] : "",
        project_identity:
          typeof record["project_identity"] === "string" ? record["project_identity"] : "",
        snapshots,
      };
    } catch (error) {
      this.report_warning("read_manifest", error);
      return null;
    }
  }

  /** manifest 读改写按目录串行，避免同一工程并发覆盖。 */
  private async serialize(directory: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(directory) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(directory, next);
    try {
      await next;
    } finally {
      if (this.queues.get(directory) === next) this.queues.delete(directory);
    }
  }

  private remove_best_effort(target_path: string): void {
    try {
      this.native_fs.unlink(target_path, { force: true });
    } catch (error) {
      this.report_warning("remove_snapshot", error);
    }
  }

  private report_warning(operation: string, error: unknown): void {
    this.log_manager.warning("工程快照维护失败。", {
      source: "project_snapshot",
      context: { operation },
      error,
      targets: { window: false },
    });
  }
}

function sanitize_name(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
}

function read_reason(file: string): ProjectSnapshotReason {
  const match =
    /_(before-agent-apply|before-workspace-run|before-batch-translation|before-project-migration|before-restore|manual)\.lg$/u.exec(
      file,
    );
  return (match?.[1] as ProjectSnapshotReason | undefined) ?? "manual";
}

function is_project_snapshot(value: unknown): value is ProjectSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["file"] === "string" &&
    typeof record["created_at"] === "string" &&
    typeof record["reason"] === "string" &&
    typeof record["app_version"] === "string" &&
    typeof record["size"] === "number"
  );
}
