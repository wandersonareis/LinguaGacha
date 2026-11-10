import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import type { AppMetadataService } from "../app/app-metadata-service";
import type { AppSettingService } from "../app/app-setting-service";
import type { ProjectDatabase } from "../database/database-operations";
import type { LogManager } from "../log/log-manager";
import { NativeFs, default_native_fs } from "../../native/native-fs";
import { AppError } from "../../shared/error";
import { normalize_project_backup_interval_hours } from "../../domain/setting";
import { resolve_project_file_identity } from "./project-file-lock";

export type ScheduledProjectBackup = Readonly<{
  file: string;
  created_at: string;
  app_version: string;
  size: number;
  project_hash: string;
  fingerprint: string;
  digest: string;
}>;

export type ScheduledProjectBackupDescription = Readonly<{
  directory: string;
  latest: ScheduledProjectBackup | null;
  count: number;
}>;

type ScheduledManifest = {
  project_path: string;
  project_identity: string;
  entries: ScheduledProjectBackup[];
};

const MANIFEST_FILE = "manifest.json";
const FILE_SUFFIX = ".lg";

/**
 * 用户控制的定时 full 备份。它是最后手段：只保存完整 `.lg`，不做增量、不做自动删除，
 * 也不暴露给 Agent。内容只有工程文件，不包含 userdata、skills 或 workspace。
 */
export class ProjectScheduledBackupService {
  public constructor(
    private readonly database: Pick<ProjectDatabase, "export_snapshot" | "read_project_state">,
    private readonly settings: Pick<AppSettingService, "read_setting">,
    private readonly metadata: Pick<AppMetadataService, "read_version_or_default">,
    private readonly log_manager: Pick<LogManager, "warning">,
    private readonly native_fs: NativeFs = default_native_fs,
    private readonly enabled = true,
  ) {}

  /** 到期、且工程内容与上次不同，才创建新的 full 备份；失败只记录，不影响当前操作。 */
  public async create_if_due(project_path: string): Promise<ScheduledProjectBackup | null> {
    if (!this.enabled) return null;
    const setting = this.settings.read_setting();
    const interval_hours = normalize_project_backup_interval_hours(
      setting["project_backup_interval_hours"],
    );
    const directory = this.directory(project_path);
    try {
      this.native_fs.make_dir(directory);
      const entries = this.list_entries(directory);
      const latest = entries[0];
      if (
        latest !== undefined &&
        Date.now() - Date.parse(latest.created_at) < interval_hours * 60 * 60 * 1000
      ) {
        return null;
      }
      const state = await this.database.read_project_state(project_path);
      if (latest !== undefined && latest.project_hash === state.project_hash) {
        return null;
      }
      const created_at = new Date().toISOString();
      const file = `${created_at.replace(/[:.]/g, "-")}${FILE_SUFFIX}`;
      const target_path = path.join(directory, file);
      const temporary_path = path.join(directory, `.${randomUUID()}.tmp`);
      try {
        await this.database.export_snapshot(project_path, temporary_path);
        const digest = createHash("sha256")
          .update(this.native_fs.read_file(temporary_path))
          .digest("hex");
        this.native_fs.rename(temporary_path, target_path);
        const entry: ScheduledProjectBackup = {
          file,
          created_at,
          app_version: this.metadata.read_version_or_default(),
          size: this.native_fs.stat(target_path).size,
          project_hash: state.project_hash,
          fingerprint: state.fingerprint,
          digest,
        };
        const manifest = this.read_manifest(directory) ?? {
          project_path,
          project_identity: resolve_project_file_identity(project_path, this.native_fs),
          entries: [],
        };
        this.native_fs.write_file_atomic(
          path.join(directory, MANIFEST_FILE),
          JSON.stringify(
            {
              ...manifest,
              project_path,
              entries: [entry, ...entries].sort((left, right) =>
                right.created_at.localeCompare(left.created_at),
              ),
            } satisfies ScheduledManifest,
            null,
            2,
          ),
        );
        return entry;
      } catch (error) {
        this.remove_best_effort(temporary_path);
        this.report_warning("create_scheduled_backup", error);
        return null;
      }
    } catch (error) {
      this.report_warning("scheduled_backup_directory", error);
      return null;
    }
  }

  /** 读取用户目录中的备份；manifest 丢失时回退到目录扫描。 */
  public async list(project_path: string): Promise<ScheduledProjectBackup[]> {
    const directory = this.directory(project_path);
    const manifest_entries = this.list_entries(directory);
    const by_file = new Map(manifest_entries.map((entry) => [entry.file, entry]));
    if (this.native_fs.exists(directory)) {
      for (const entry of this.native_fs.read_dirents(directory)) {
        if (!entry.isFile() || !entry.name.endsWith(FILE_SUFFIX) || by_file.has(entry.name))
          continue;
        const file_path = path.join(directory, entry.name);
        const stat = this.native_fs.stat(file_path);
        by_file.set(entry.name, {
          file: entry.name,
          created_at: new Date(stat.mtimeMs).toISOString(),
          app_version: "",
          size: stat.size,
          project_hash: "",
          fingerprint: "",
          digest: "",
        });
      }
    }
    return [...by_file.values()]
      .filter((entry) => this.native_fs.exists(path.join(directory, entry.file)))
      .sort((left, right) => right.created_at.localeCompare(left.created_at));
  }

  public async describe(project_path: string): Promise<ScheduledProjectBackupDescription> {
    const entries = await this.list(project_path);
    return {
      directory: this.directory(project_path),
      latest: entries[0] ?? null,
      count: entries.length,
    };
  }

  /** 定时备份只允许恢复本工程目录内的 `.lg` 直接文件名。 */
  public resolve(
    project_path: string,
    file: unknown,
  ): { entry: ScheduledProjectBackup; file_path: string } {
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
    const entry =
      this.list_entries(directory).find((candidate) => candidate.file === file) ?? {
        file,
        created_at: new Date(this.native_fs.stat(file_path).mtimeMs).toISOString(),
        app_version: "",
        size: this.native_fs.stat(file_path).size,
        project_hash: "",
        fingerprint: "",
        digest: "",
      };
    return { entry, file_path };
  }

  /** 表级恢复要求同版本；`file` 恢复由生命周期负责迁移旧版本。 */
  public is_compatible(entry: ScheduledProjectBackup): boolean {
    return entry.app_version === "" || entry.app_version === this.metadata.read_version_or_default();
  }

  public directory(project_path: string): string {
    const configured = this.settings.read_setting()["project_backup_directory"];
    const root =
      typeof configured === "string" && configured.trim() !== ""
        ? path.resolve(configured)
        : path.dirname(project_path);
    const identity = resolve_project_file_identity(project_path, this.native_fs);
    const hash = createHash("sha256").update(identity).digest("hex").slice(0, 8);
    const base =
      sanitize_name(path.basename(project_path, path.extname(project_path))) || "project";
    return path.join(root, `${base}-${hash}`);
  }

  private list_entries(directory: string): ScheduledProjectBackup[] {
    const manifest = this.read_manifest(directory);
    return manifest?.entries.filter((entry) => this.native_fs.exists(path.join(directory, entry.file))) ?? [];
  }

  private read_manifest(directory: string): ScheduledManifest | null {
    const manifest_path = path.join(directory, MANIFEST_FILE);
    if (!this.native_fs.exists(manifest_path)) return null;
    try {
      const value: unknown = JSON.parse(this.native_fs.read_text_file(manifest_path));
      if (typeof value !== "object" || value === null) return null;
      const record = value as Record<string, unknown>;
      if (!Array.isArray(record["entries"])) return null;
      return {
        project_path: typeof record["project_path"] === "string" ? record["project_path"] : "",
        project_identity:
          typeof record["project_identity"] === "string" ? record["project_identity"] : "",
        entries: record["entries"].filter(is_scheduled_backup),
      };
    } catch (error) {
      this.report_warning("read_scheduled_manifest", error);
      return null;
    }
  }

  private remove_best_effort(target_path: string): void {
    try {
      this.native_fs.unlink(target_path, { force: true });
    } catch (error) {
      this.report_warning("remove_scheduled_backup", error);
    }
  }

  private report_warning(operation: string, error: unknown): void {
    this.log_manager.warning("用户定时备份失败。", {
      source: "project_scheduled_backup",
      context: { operation },
      error,
      targets: { window: true },
    });
  }
}

function sanitize_name(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 40);
}

function is_scheduled_backup(value: unknown): value is ScheduledProjectBackup {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["file"] === "string" &&
    typeof record["created_at"] === "string" &&
    typeof record["app_version"] === "string" &&
    typeof record["size"] === "number" &&
    typeof record["project_hash"] === "string" &&
    typeof record["fingerprint"] === "string" &&
    typeof record["digest"] === "string"
  );
}
