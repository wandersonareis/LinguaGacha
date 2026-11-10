import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ProjectDatabase } from "../database/database-operations";
import { ProjectScheduledBackupService } from "./project-scheduled-backup";

describe("ProjectScheduledBackupService", () => {
  it("按间隔和内容创建完整 .lg，跳过重复内容并允许目录扫描", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-scheduled-backup-"));
    const database = new ProjectDatabase("1.2.3");
    const project = path.join(temp.path, "demo.lg");
    await database.create_project(project, (writer) => {
      writer.set_items(project, [
        {
          src: "Hello",
          dst: "Old",
          name_src: "",
          name_dst: "",
          file_path: "demo.txt",
          row: 0,
          status: "PROCESSED",
        },
      ]);
    });
    const settings = {
      read_setting: () => ({
        project_backup_interval_hours: 1,
        project_backup_directory: path.join(temp.path, "backups"),
      }),
    };
    const service = new ProjectScheduledBackupService(
      database,
      settings,
      { read_version_or_default: () => "1.2.3" },
      { warning: vi.fn() },
    );
    try {
      const first = await service.create_if_due(project);
      expect(first).not.toBeNull();
      expect((await service.list(project)).map((entry) => entry.file)).toContain(first!.file);
      expect(await service.describe(project)).toMatchObject({
        count: 1,
        latest: { file: first!.file },
      });

      // 让间隔过期但内容不变：仍不创建新文件。
      const directory = service.directory(project);
      const manifest_path = path.join(directory, "manifest.json");
      const manifest = JSON.parse(fs.readFileSync(manifest_path, "utf8"));
      manifest.entries[0].created_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(manifest_path, JSON.stringify(manifest));
      await expect(service.create_if_due(project)).resolves.toBeNull();
      expect(await service.list(project)).toHaveLength(1);

      // 内容变化后再到期，创建第二份全量备份。
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "New", name_dst: "", status: "PROCESSED" } },
        ]);
      });
      const second = await service.create_if_due(project);
      expect(second).not.toBeNull();
      expect(await service.list(project)).toHaveLength(2);

      expect(() => service.resolve(project, "../manifest.json")).toThrow(
        expect.objectContaining({ code: "request.validation_failed" }),
      );
      expect(() => service.resolve(project, "missing.lg")).toThrow(
        expect.objectContaining({ code: "project.snapshot_not_found" }),
      );
    } finally {
      await database.close();
    }
  });
});
