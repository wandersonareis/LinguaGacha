import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { AppPathService } from "../app/app-path-service";
import { ProjectDatabase } from "../database/database-operations";
import { default_native_fs } from "../../native/native-fs";
import { materialize_project_snapshot } from "./project-snapshot-archive";
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
      expect(first!.file).toMatch(/\.lg\.zip$/u);
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

  it("旧版未压缩 .lg 快照在下次创建时转为 .lg.zip", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      const directory = service.directory(project);
      fs.mkdirSync(directory, { recursive: true });
      const legacy_name = "2026-01-01T00-00-00-000Z_manual.lg";
      fs.copyFileSync(project, path.join(directory, legacy_name));
      expect((await service.list(project)).map((snapshot) => snapshot.file)).toContain(
        legacy_name,
      );

      await service.create(project, "manual");

      const files = (await service.list(project)).map((snapshot) => snapshot.file);
      expect(files).not.toContain(legacy_name);
      expect(files).toContain(`${legacy_name}.zip`);
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
      expect(resolved.file_path).toBe(path.join(service.directory(project), snapshot!.file));
      expect(resolved.file_path).toMatch(/\.lg\.zip$/u);
      const materialized = await materialize_project_snapshot(
        default_native_fs,
        resolved.file_path,
      );
      try {
        await database.restore_project_tables(project, materialized.path);
      } finally {
        materialized.cleanup();
      }

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

  it("脚本前恢复点独立于数量限制，同任务只保留一个文件", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(1), database);
    try {
      const first = await service.create_for_run(project, "round-1", "before-workspace-run");
      expect(first).not.toBeNull();
      expect(first!.file).toMatch(/^\.run-[0-9a-f]{8}\.lg\.zip$/u);
      expect(first!.protect).toBe(false);
      expect(first!.anchor).toBe(false);
      expect(await service.list(project)).toEqual([]);
      await expect(service.describe(project)).resolves.toMatchObject({ count: 0 });

      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Second", name_dst: "", status: "PROCESSED" } },
        ]);
      });
      const second = await service.create_for_run(project, "round-1", "before-workspace-run");
      expect(second!.file).toBe(first!.file);
      expect(run_point_files(service, project)).toEqual([first!.file]);

      const kept = await service.create(project, "before-agent-apply");
      expect(kept).not.toBeNull();
      expect((await service.list(project)).map((snapshot) => snapshot.file)).toEqual([kept!.file]);
      expect(run_point_files(service, project)).toEqual([first!.file]);
    } finally {
      await database.close();
    }
  });

  it("脚本前恢复点按 restore_point 文件名可恢复，并按任务丢弃", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Second", name_dst: "", status: "PROCESSED" } },
        ]);
      });
      const point = await service.create_for_run(project, "round-2", "before-workspace-run");
      expect(point).not.toBeNull();
      await database.transaction(project, (writer) => {
        writer.patch_item_translation_fields(project, [
          { item_id: 1, next: { dst: "Broken", name_dst: "", status: "PROCESSED" } },
        ]);
      });

      const resolved = service.resolve(project, point!.file);
      expect(resolved.file_path).toBe(path.join(service.directory(project), point!.file));
      expect(resolved.snapshot.reason).toBe("before-workspace-run");
      const materialized = await materialize_project_snapshot(
        default_native_fs,
        resolved.file_path,
      );
      try {
        await database.restore_project_tables(project, materialized.path);
      } finally {
        materialized.cleanup();
      }
      expect((await database.get_all_items(project))[0]?.["dst"]).toBe("Second");

      service.discard_run_points(project, "round-2");
      expect(run_point_files(service, project)).toEqual([]);
      expect(() => service.resolve(project, point!.file)).toThrow(
        expect.objectContaining({ code: "project.snapshot_not_found" }),
      );
    } finally {
      await database.close();
    }
  });

  it("丢弃恢复点只影响指定任务，并拒绝伪装路径", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      const first = await service.create_for_run(project, "round-a", "before-workspace-run");
      const second = await service.create_for_run(project, "round-b", "before-workspace-run");
      expect(first!.file).not.toBe(second!.file);
      expect(() => service.resolve(project, ".run-../../etc.lg.zip")).toThrow(
        expect.objectContaining({ code: "request.validation_failed" }),
      );
      expect(() => service.resolve(project, ".manifest.lg.zip")).toThrow(
        expect.objectContaining({ code: "request.validation_failed" }),
      );
      service.discard_run_points(project, "round-a");
      expect(run_point_files(service, project)).toEqual([second!.file]);
      service.discard_run_points(project);
      expect(run_point_files(service, project)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("关闭快照时不创建脚本前恢复点", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(0), database);
    try {
      await expect(
        service.create_for_run(project, "round-off", "before-workspace-run"),
      ).resolves.toBeNull();
      expect(run_point_files(service, project)).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("新任务的恢复点回收上一任务的遗留文件", async () => {
    using temp = create_temp();
    const database = new ProjectDatabase("1.2.3");
    const project = await create_project(database, temp.path);
    const service = create_service(temp.path, create_settings(5), database);
    try {
      const previous = await service.create_for_run(project, "round-old", "before-workspace-run");
      const current = await service.create_for_run(project, "round-new", "before-workspace-run");
      expect(previous!.file).not.toBe(current!.file);
      expect(run_point_files(service, project)).toEqual([current!.file]);
    } finally {
      await database.close();
    }
  });
});

function run_point_files(service: ProjectSnapshotService, project: string): string[] {
  const directory = service.directory(project);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => /^\.run-[0-9a-f]{8}\.lg\.zip$/u.test(file));
}

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
