import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { ProjectDatabase } from "../database/database-operations";
import { ProjectSnapshotService } from "./project-snapshot-service";

describe("ProjectSnapshotService", () => {
  it("生成快照并按数量限制删除最旧副本", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(2), database);
    try {
      const first = await service.create(project, "manual");
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Second", name_dst: "", status: "PROCESSED" } },
        ]);
      });
      const second = await service.create(project, "before-agent-apply");
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Third", name_dst: "", status: "PROCESSED" } },
        ]);
      });
      const third = await service.create(project, "before-restore");
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).not.toBeNull();

      const snapshots = await service.list(project);
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map((snapshot) => snapshot.file)).not.toContain(first!.file);
      expect(snapshots[0]?.file).toBe(third!.file);
      await expect(service.describe(project)).resolves.toMatchObject({
        limit: 2,
        count: 2,
        latest: { file: third!.file },
      });
    } finally {
      await database.close();
    }
  });

  it("数量为 0 时不创建快照", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(0), database);
    try {
      await expect(service.create(project, "manual")).resolves.toBeNull();
      await expect(service.list(project)).resolves.toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("拒绝快照目录之外的路径", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      await service.create(project, "manual");
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

  it("恢复只覆盖工程数据，保留当前 Agent 对话", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      const first_store = database.open_agent_store(project);
      await first_store.create("chat-1");
      await first_store.close();

      const snapshot = await service.create(project, "manual");
      expect(snapshot).not.toBeNull();

      const second_store = database.open_agent_store(project);
      await second_store.create("chat-2");
      await second_store.close();
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Broken", name_dst: "", status: "PROCESSED" } },
        ]);
      });

      const resolved = service.resolve(project, snapshot!.file);
      await database.restore_project_tables(project, resolved.file_path);

      const items = await database.get_all_items(project);
      expect(items[0]?.["dst"]).toBe("Old");
      const meta = await database.get_all_meta(project);
      expect(meta["active_chat"]).toBe("chat-2");
      const restored_store = database.open_agent_store(project);
      await expect(restored_store.read()).resolves.toMatchObject({ id: "chat-2" });
      await restored_store.close();
    } finally {
      await database.close();
    }
  });
});

function create_temp() {
  return fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-snapshot-"));
}

function create_settings(limit: number) {
  return { read_setting: () => ({ project_snapshot_limit: limit }) };
}

function create_service(
  root: string,
  settings: ReturnType<typeof create_settings>,
  database: ProjectDatabase,
) {
  return new ProjectSnapshotService(
    new AppPathService({ appRoot: root, builtinRoot: path.join(root, "builtin") }),
    database,
    settings,
    { read_version_or_default: () => "1.2.3" },
    { warning: vi.fn() },
  );
}

async function create_project(database: ProjectDatabase, root: string): Promise<string> {
  const project = path.join(root, "demo.lg");
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
  return project;
}
