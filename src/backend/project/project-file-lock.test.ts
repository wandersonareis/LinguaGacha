import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ProjectFileLock, resolve_project_file_identity } from "./project-file-lock";

describe("ProjectFileLock", () => {
  it("同一 .lg 拒绝第二个使用者，释放后可重新获取", async () => {
    using temp = create_temp();
    const project = write_project(temp.path, "demo.lg");
    const options = lock_options(temp.path);
    const first = await ProjectFileLock.acquire(project, options);
    try {
      expect(fs.existsSync(user_data_lock(project, options))).toBe(true);
      expect(fs.existsSync(temp_lock(project, options))).toBe(true);
      expect(fs.existsSync(path.join(temp.path, ".demo.lg.lock"))).toBe(false);
      await expect(ProjectFileLock.acquire(project, options)).rejects.toMatchObject({
        code: "project.in_use",
      });
    } finally {
      await first.release();
    }
    expect(fs.existsSync(user_data_lock(project, options))).toBe(false);
    expect(fs.existsSync(temp_lock(project, options))).toBe(false);

    const second = await ProjectFileLock.acquire(project, options);
    await second.release();
  });

  it("不同 .lg 可以同时打开", async () => {
    using temp = create_temp();
    const options = lock_options(temp.path);
    const first = await ProjectFileLock.acquire(write_project(temp.path, "first.lg"), options);
    const second = await ProjectFileLock.acquire(write_project(temp.path, "second.lg"), options);
    try {
      expect(first.identity).not.toBe(second.identity);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });

  it("应用数据根无法创建锁时回退到临时目录", async () => {
    using temp = create_temp();
    const blocker = path.join(temp.path, "blocker");
    fs.writeFileSync(blocker, "");
    const options = { data_root: path.join(blocker, "data"), temp_root: path.join(temp.path, "temp") };
    const project = write_project(temp.path, "demo.lg");
    const first = await ProjectFileLock.acquire(project, options);
    try {
      const registry = path.join(options.temp_root, "linguagacha-project-locks");
      expect(fs.readdirSync(registry)).toHaveLength(1);
      await expect(ProjectFileLock.acquire(project, options)).rejects.toMatchObject({
        code: "project.in_use",
      });
    } finally {
      await first.release();
    }
  });

  it("没有任何可写位置时拒绝打开", async () => {
    using temp = create_temp();
    const blocker = path.join(temp.path, "blocker");
    fs.writeFileSync(blocker, "");
    const project = write_project(temp.path, "demo.lg");

    await expect(
      ProjectFileLock.acquire(project, {
        data_root: path.join(blocker, "data"),
        temp_root: path.join(blocker, "temp"),
      }),
    ).rejects.toMatchObject({ code: "project.lock_unavailable" });
  });

  it("锁目录被删除时只记录降级，不抛错也不重建", async () => {
    using temp = create_temp();
    const project = write_project(temp.path, "demo.lg");
    const on_compromised = vi.fn();
    const uncaught = vi.fn();
    process.on("uncaughtException", uncaught);
    const lock = await ProjectFileLock.acquire(project, {
      ...lock_options(temp.path),
      stale: 2000,
      update: 1000,
      on_compromised,
    });
    try {
      const target = user_data_lock(project, lock_options(temp.path));
      expect(fs.existsSync(target)).toBe(true);
      fs.rmSync(target, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(on_compromised).toHaveBeenCalledWith({
        location: "user_data",
        error: expect.objectContaining({ code: "ECOMPROMISED" }),
      });
      expect(uncaught).not.toHaveBeenCalled();
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      process.off("uncaughtException", uncaught);
      await expect(lock.release()).resolves.toBeUndefined();
    }
  });

  it("残留的过期锁被下一次打开覆盖", async () => {
    using temp = create_temp();
    const project = write_project(temp.path, "demo.lg");
    const options = lock_options(temp.path);
    const target = user_data_lock(project, options);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    const stale_time = new Date(Date.now() - 60_000);
    fs.utimesSync(target, stale_time, stale_time);

    const lock = await ProjectFileLock.acquire(project, options);
    try {
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.statSync(target).mtime.getTime()).toBeGreaterThan(stale_time.getTime());
    } finally {
      await lock.release();
    }
  });

  it("持锁期间占用删除保护句柄，释放时先关闭", async () => {
    using temp = create_temp();
    const project = write_project(temp.path, "demo.lg");
    const close = vi.fn();
    const guard_factory = vi.fn(() => ({ close }));
    const lock = await ProjectFileLock.acquire(project, {
      ...lock_options(temp.path),
      guard_factory,
    });
    expect(guard_factory).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    await lock.release();
    expect(close).toHaveBeenCalledTimes(2);
  });
});

function create_temp() {
  return fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-project-lock-"));
}

function write_project(root: string, name: string): string {
  const project = path.join(root, name);
  fs.writeFileSync(project, "");
  return project;
}

function lock_options(root: string) {
  return {
    data_root: path.join(root, "data"),
    temp_root: path.join(root, "temp"),
  };
}

function lock_hash(project: string): string {
  return createHash("sha256").update(resolve_project_file_identity(project)).digest("hex");
}

function user_data_lock(project: string, options: { data_root: string }): string {
  return path.join(options.data_root, "project-locks", `${lock_hash(project)}.lock`);
}

function temp_lock(project: string, options: { temp_root: string }): string {
  return path.join(options.temp_root, "linguagacha-project-locks", `${lock_hash(project)}.lock`);
}
