import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { default_native_fs } from "../../native/native-fs";
import {
  extract_project_snapshot_archive,
  is_project_snapshot_file,
  materialize_project_snapshot,
  write_project_snapshot_archive,
} from "./project-snapshot-archive";

describe("project-snapshot-archive", () => {
  it("压缩后解压得到同一份 .lg，并识别旧 .lg 与 .lg.zip", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-snapshot-archive-"));
    const source = path.join(temp.path, "2026-01-01_manual.lg");
    const archive = path.join(temp.path, "2026-01-01_manual.lg.zip");
    const data = Buffer.from("SQLite format 3\u0000snapshot-bytes", "utf8");
    default_native_fs.write_file_atomic(source, data);

    await write_project_snapshot_archive(default_native_fs, source, archive);
    expect(is_project_snapshot_file(archive)).toBe(true);
    expect(is_project_snapshot_file(source)).toBe(true);

    const extracted = path.join(temp.path, "extracted.lg");
    await extract_project_snapshot_archive(default_native_fs, archive, extracted);
    expect(default_native_fs.read_file(extracted)).toEqual(data);
  });

  it("旧 .lg 直接使用；压缩包解到临时文件并在 cleanup 后删除", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-snapshot-materialize-"));
    const legacy = path.join(temp.path, "2026-01-01_manual.lg");
    const archive = path.join(temp.path, "2026-01-01_manual.lg.zip");
    const data = Buffer.from("legacy-snapshot", "utf8");
    default_native_fs.write_file_atomic(legacy, data);
    await write_project_snapshot_archive(default_native_fs, legacy, archive);

    const direct = await materialize_project_snapshot(default_native_fs, legacy);
    expect(direct.path).toBe(legacy);
    direct.cleanup();
    expect(default_native_fs.exists(legacy)).toBe(true);

    const materialized = await materialize_project_snapshot(default_native_fs, archive);
    expect(materialized.path).not.toBe(archive);
    expect(materialized.path).toMatch(/\.restore\.tmp\.lg$/u);
    expect(default_native_fs.read_file(materialized.path)).toEqual(data);
    materialized.cleanup();
    expect(default_native_fs.exists(materialized.path)).toBe(false);
  });

  it("损坏的压缩包按快照不兼容处理，并清理临时文件", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-snapshot-invalid-"));
    const invalid = path.join(temp.path, "broken.lg.zip");
    default_native_fs.write_file_atomic(invalid, Buffer.from("not a zip", "utf8"));

    await expect(materialize_project_snapshot(default_native_fs, invalid)).rejects.toMatchObject({
      code: "project.snapshot_incompatible",
    });
    expect(
      default_native_fs.read_dirents(temp.path).filter((entry) => entry.name.endsWith(".tmp.lg")),
    ).toEqual([]);
  });
});
