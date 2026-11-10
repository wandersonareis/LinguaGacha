import { randomUUID } from "node:crypto";
import path from "node:path";

import JSZip from "jszip";

import type { NativeFs } from "../../native/native-fs";
import { AppError } from "../../shared/error";

/** 工程快照的两种磁盘形态：旧版未压缩 `.lg` 与压缩包 `.lg.zip`。 */
export const PROJECT_SNAPSHOT_SUFFIX = ".lg";
export const PROJECT_SNAPSHOT_ARCHIVE_SUFFIX = ".lg.zip";

/**
 * 压缩包只承载一个 `.lg`。工程是 SQLite 文件，DEFLATE 通常从 ~100 MB
 * 降到 ~15 MB；压缩包本身仍是可直接用文件管理器打开的普通 zip。
 */
const ARCHIVE_COMPRESSION_LEVEL = 6;

export function is_project_snapshot_file(file: string): boolean {
  return file.endsWith(PROJECT_SNAPSHOT_SUFFIX) || file.endsWith(PROJECT_SNAPSHOT_ARCHIVE_SUFFIX);
}

export function is_project_snapshot_archive(file: string): boolean {
  return file.endsWith(PROJECT_SNAPSHOT_ARCHIVE_SUFFIX);
}

/** 文件名中的原因；兼容旧 `.lg` 和新 `.lg.zip`。 */
export function project_snapshot_reason_from_file(file: string): string | null {
  const match =
    /_(before-agent-apply|before-workspace-run|before-batch-translation|before-project-migration|before-restore|manual)\.lg(?:\.zip)?$/u.exec(
      file,
    );
  return match?.[1] ?? null;
}

/** 把 `VACUUM INTO` 生成的临时 `.lg` 压成最终 `.lg.zip`。 */
export async function write_project_snapshot_archive(
  native_fs: Pick<NativeFs, "read_file" | "write_file_atomic">,
  source_lg_path: string,
  target_archive_path: string,
): Promise<void> {
  const zip = new JSZip();
  zip.file(path.basename(source_lg_path), native_fs.read_file(source_lg_path));
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: ARCHIVE_COMPRESSION_LEVEL },
  });
  native_fs.write_file_atomic(target_archive_path, buffer);
}

/** 取出压缩包中的 `.lg`；找不到时按损坏快照处理。 */
export async function extract_project_snapshot_archive(
  native_fs: Pick<NativeFs, "read_file" | "write_file_atomic">,
  archive_path: string,
  target_lg_path: string,
): Promise<void> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(native_fs.read_file(archive_path));
  } catch (cause) {
    throw new AppError("project.snapshot_incompatible", {
      cause,
      diagnostic_context: { operation: "read_project_snapshot_archive" },
    });
  }
  const entry = Object.values(zip.files).find(
    (candidate) => !candidate.dir && candidate.name.endsWith(PROJECT_SNAPSHOT_SUFFIX),
  );
  if (entry === undefined) {
    throw new AppError("project.snapshot_incompatible", {
      diagnostic_context: { operation: "read_project_snapshot_archive", reason: "missing_lg" },
    });
  }
  native_fs.write_file_atomic(target_lg_path, await entry.async("nodebuffer"));
}

/**
 * 还原统一入口：压缩包先解到同目录临时 `.lg`，旧 `.lg` 直接使用。
 * 调用方负责在 `finally` 执行 `cleanup`。
 */
export async function materialize_project_snapshot(
  native_fs: Pick<NativeFs, "read_file" | "write_file_atomic" | "unlink">,
  file_path: string,
): Promise<{ path: string; cleanup: () => void }> {
  if (!is_project_snapshot_archive(file_path)) {
    return { path: file_path, cleanup: () => {} };
  }
  const temporary_path = path.join(
    path.dirname(file_path),
    `.${randomUUID()}.restore.tmp.lg`,
  );
  try {
    await extract_project_snapshot_archive(native_fs, file_path, temporary_path);
  } catch (cause) {
    try {
      native_fs.unlink(temporary_path, { force: true });
    } catch {
      // 解压失败时临时文件可能尚未创建；清理失败不覆盖原始错误。
    }
    throw cause;
  }
  return {
    path: temporary_path,
    cleanup: () => {
      try {
        native_fs.unlink(temporary_path, { force: true });
      } catch {
        // 还原完成后临时文件已删除；清理失败不改变已提交的工程。
      }
    },
  };
}
