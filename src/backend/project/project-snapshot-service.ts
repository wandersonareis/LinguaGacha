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
import {
  PROJECT_SNAPSHOT_ARCHIVE_SUFFIX,
  PROJECT_SNAPSHOT_SUFFIX,
  is_project_snapshot_file,
  project_snapshot_reason_from_file,
  write_project_snapshot_archive,
} from "./project-snapshot-archive";

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
  kind: "full"; // 当前实现只写 full；字段为后续 incremental 预留。
  project_hash: string; // 只覆盖工程表，不含 Agent 聊天/SDK。
  fingerprint: string; // 修订与 updated_at 的廉价指纹。
  anchor: boolean; // 当前任务的保护锚点。
  protect: boolean; // 当前任务的预脚本/预提交保护点。
  task: string | null; // 产生该点的任务身份。
}>;

export type ProjectSnapshotDescription = Readonly<{
  directory: string;
  limit: number;
  latest: ProjectSnapshot | null;
  count: number;
}>;

export type ProjectSnapshotCreateOptions = Readonly<{
  task?: string | null;
  protect?: boolean;
  anchor?: boolean;
  dedup?: boolean;
}>;

type SnapshotManifest = {
  project_path: string;
  project_identity: string;
  snapshots: ProjectSnapshot[];
};

const MANIFEST_FILE = "manifest.json";
const BACKUP_ROOT = ["backups", "projects"] as const;

/**
 * 工程自动快照。写入 `userdata/backups/projects/<nome>-<hash8>/`，
 * 用 `VACUUM INTO` 生成包含 WAL 的一致性副本。
 *
 * 当前使用 full 快照作为恢复点；任务锚点和预脚本保护点不会被普通数量限制删除。
 * 该服务不取得运行门禁；调用方必须已在项目写或 Agent 写租约内。
 */
export class ProjectSnapshotService {
  private readonly queues = new Map<string, Promise<void>>(); // 同一工程的 manifest 写入串行。

  public constructor(
    private readonly paths: Pick<AppPathService, "get_user_data_path">,
    private readonly database: Pick<ProjectDatabase, "export_snapshot" | "read_project_state">,
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

  /** 创建 full 快照；关闭时返回 null。失败抛出 project.snapshot_failed。 */
  public async create(
    project_path: string,
    reason: ProjectSnapshotReason,
    options: ProjectSnapshotCreateOptions = {},
  ): Promise<ProjectSnapshot | null> {
    if (!this.enabled) return null;
    const limit = this.current_limit();
    if (limit <= 0) return null;

    const state = await this.database.read_project_state(project_path);
    const directory = this.directory(project_path);
    this.native_fs.make_dir(directory);

    let created: ProjectSnapshot | null = null;
    await this.serialize(directory, async () => {
      let snapshots = await this.list(project_path);
      snapshots = await this.compact_legacy(project_path, directory, snapshots);
      const task = options.task ?? null;
      // 新任务开始时释放上一个任务的锚点/保护点，旧文件仍进入普通保留池。
      if (task !== null) {
        snapshots = snapshots.map((snapshot) =>
          snapshot.task !== null && snapshot.task !== task
            ? { ...snapshot, anchor: false, protect: false }
            : snapshot,
        );
      }

      const duplicate =
        options.dedup === false
          ? undefined
          : snapshots.find(
              (snapshot) =>
                snapshot.kind === "full" &&
                snapshot.project_hash !== "" &&
                snapshot.project_hash === state.project_hash,
            );
      const has_anchor = snapshots.some(
        (snapshot) => task !== null && snapshot.task === task && snapshot.anchor,
      );
      const anchor = options.anchor === true || (task !== null && !has_anchor);
      const protect = options.protect === true || anchor;

      if (duplicate !== undefined) {
        const promoted: ProjectSnapshot = {
          ...duplicate,
          task: task ?? duplicate.task,
          anchor: duplicate.anchor || anchor,
          protect: duplicate.protect || protect,
        };
        snapshots = snapshots.map((snapshot) =>
          snapshot.file === duplicate.file ? promoted : snapshot,
        );
        await this.write_manifest(project_path, directory, snapshots, limit);
        created = promoted;
        return;
      }

      const created_at = new Date().toISOString();
      const file = `${created_at.replace(/[:.]/g, "-")}_${reason}${PROJECT_SNAPSHOT_ARCHIVE_SUFFIX}`;
      const target_path = path.join(directory, file);
      const temporary_lg_path = `${target_path}.tmp.lg`;
      const temporary_archive_path = `${target_path}.tmp`;
      try {
        await this.database.export_snapshot(project_path, temporary_lg_path);
        await write_project_snapshot_archive(
          this.native_fs,
          temporary_lg_path,
          temporary_archive_path,
        );
        this.native_fs.rename(temporary_archive_path, target_path);
        this.remove_best_effort(temporary_lg_path);
        this.remove_best_effort(temporary_archive_path);
      } catch (error) {
        this.remove_best_effort(temporary_lg_path);
        this.remove_best_effort(temporary_archive_path);
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
        kind: "full",
        project_hash: state.project_hash,
        fingerprint: state.fingerprint,
        anchor,
        protect,
        task,
      };
      snapshots = [snapshot, ...snapshots];
      await this.write_manifest(project_path, directory, snapshots, limit);
      created = snapshot;
    });
    return created;
  }

  /** 每个 workspace_run 前保存 full 预脚本点；同内容去重并保护当前任务。 */
  public create_for_run(
    project_path: string,
    task_token: string,
    reason: ProjectSnapshotReason,
  ): Promise<ProjectSnapshot | null> {
    return this.create(project_path, reason, {
      task: task_token,
      protect: true,
      dedup: true,
    });
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
        if (
          !entry.isFile() ||
          entry.name.startsWith(".") ||
          entry.name.includes(".tmp") ||
          !is_project_snapshot_file(entry.name) ||
          snapshots.has(entry.name)
        )
          continue;
        const file_path = path.join(directory, entry.name);
        const stat = this.native_fs.stat(file_path);
        snapshots.set(entry.name, {
          file: entry.name,
          created_at: new Date(stat.mtimeMs).toISOString(),
          reason:
            (project_snapshot_reason_from_file(entry.name) as ProjectSnapshotReason | null) ??
            "manual",
          app_version: "",
          size: stat.size,
          kind: "full",
          project_hash: "",
          fingerprint: "",
          anchor: false,
          protect: false,
          task: null,
        });
      }
    }
    return [...snapshots.values()]
      .filter((snapshot) => this.native_fs.exists(path.join(directory, snapshot.file)))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  /** 旧版未压缩 `.lg` 在第一次写入快照时转为 `.lg.zip`；失败保留旧文件。 */
  private async compact_legacy(
    project_path: string,
    directory: string,
    snapshots: readonly ProjectSnapshot[],
  ): Promise<ProjectSnapshot[]> {
    let changed = false;
    const next: ProjectSnapshot[] = [];
    for (const snapshot of snapshots) {
      if (!snapshot.file.endsWith(PROJECT_SNAPSHOT_SUFFIX)) {
        next.push(snapshot);
        continue;
      }
      const source_path = path.join(directory, snapshot.file);
      const target_file = `${snapshot.file}.zip`;
      const target_path = path.join(directory, target_file);
      try {
        if (this.native_fs.exists(target_path)) {
          next.push(snapshot);
          continue;
        }
        await write_project_snapshot_archive(this.native_fs, source_path, target_path);
        this.remove_best_effort(source_path);
        next.push({ ...snapshot, file: target_file, size: this.native_fs.stat(target_path).size });
        changed = true;
      } catch (error) {
        this.report_warning("compact_legacy_snapshot", error);
        next.push(snapshot);
      }
    }
    if (changed) await this.write_manifest(project_path, directory, next, this.current_limit());
    return next;
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
      snapshot.app_version === "" || snapshot.app_version === this.metadata.read_version_or_default()
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
      !is_project_snapshot_file(file) ||
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
      reason:
        (project_snapshot_reason_from_file(file) as ProjectSnapshotReason | null) ?? "manual",
      app_version: "",
      size: this.native_fs.stat(file_path).size,
      kind: "full",
      project_hash: "",
      fingerprint: "",
      anchor: false,
      protect: false,
      task: null,
    };
    return { snapshot, file_path };
  }

  /** 快照目录按工程路径身份稳定寻址，工程移动后旧备份仍保留在原目录。 */
  public directory(project_path: string): string {
    const identity = resolve_project_file_identity(project_path, this.native_fs);
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
    const base = sanitize_name(path.basename(project_path, path.extname(project_path))) || "project";
    return this.paths.get_user_data_path(...BACKUP_ROOT, `${base}-${hash}`);
  }

  /** 保留 limit 个未保护 full；锚点和保护点永不因数量被删。 */
  private async write_manifest(
    project_path: string,
    directory: string,
    snapshots: readonly ProjectSnapshot[],
    limit: number,
  ): Promise<void> {
    const sorted = [...snapshots].sort((left, right) =>
      right.created_at.localeCompare(left.created_at),
    );
    const protected_snapshots = sorted.filter((snapshot) => snapshot.anchor || snapshot.protect);
    const unprotected = sorted.filter((snapshot) => !snapshot.anchor && !snapshot.protect);
    const kept = [
      ...protected_snapshots,
      ...unprotected.slice(0, Math.max(0, limit - protected_snapshots.length)),
    ].sort((left, right) => right.created_at.localeCompare(left.created_at));
    const kept_names = new Set(kept.map((snapshot) => snapshot.file));
    for (const snapshot of sorted) {
      if (!kept_names.has(snapshot.file)) {
        this.remove_best_effort(path.join(directory, snapshot.file));
      }
    }
    const manifest = this.read_manifest(directory);
    const next_manifest: SnapshotManifest = {
      project_path,
      project_identity:
        manifest?.project_identity ??
        resolve_project_file_identity(project_path, this.native_fs),
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
      const snapshots = record["snapshots"]
        .map(normalize_snapshot)
        .filter((snapshot): snapshot is ProjectSnapshot => snapshot !== null);
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

/** 旧 manifest 没有新字段时按 full、无保护点读取，避免升级后丢失恢复入口。 */
function normalize_snapshot(value: unknown): ProjectSnapshot | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record["file"] !== "string" ||
    typeof record["created_at"] !== "string" ||
    typeof record["reason"] !== "string" ||
    typeof record["app_version"] !== "string" ||
    typeof record["size"] !== "number"
  ) {
    return null;
  }
  const file = record["file"];
  const reason = PROJECT_SNAPSHOT_REASONS.includes(record["reason"] as ProjectSnapshotReason)
    ? (record["reason"] as ProjectSnapshotReason)
    : ((project_snapshot_reason_from_file(file) as ProjectSnapshotReason | null) ?? "manual");
  return {
    file,
    created_at: record["created_at"],
    reason,
    app_version: record["app_version"],
    size: record["size"],
    kind: "full",
    project_hash: typeof record["project_hash"] === "string" ? record["project_hash"] : "",
    fingerprint: typeof record["fingerprint"] === "string" ? record["fingerprint"] : "",
    anchor: record["anchor"] === true,
    protect: record["protect"] === true,
    task: typeof record["task"] === "string" ? record["task"] : null,
  };
}

