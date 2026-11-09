import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ProjectFileLock } from "./project-file-lock";

describe("ProjectFileLock", () => {
  it("同一 .lg 拒绝第二个使用者，释放后可重新获取", async () => {
    using temp = create_temp();
    const project = write_project(temp.path, "demo.lg");
    const options = lock_options(temp.path);
    const first = await ProjectFileLock.acquire(project, options);
    try {
      expect(fs.existsSync(path.join(temp.path, ".demo.lg.lock"))).toBe(true);
      await expect(ProjectFileLock.acquire(project, options)).rejects.toMatchObject({
        code: "project.in_use",
      });
    } finally {
      await first.release();
    }
    expect(fs.existsSync(path.join(temp.path, ".demo.lg.lock"))).toBe(false);

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

  it("工程目录无法创建锁时回退到临时目录", async () => {
    using temp = create_temp();
    const options = lock_options(temp.path);
    const missing_project = path.join(temp.path, "missing", "demo.lg");
    const first = await ProjectFileLock.acquire(missing_project, options);
    try {
      const registry = path.join(options.temp_root, "linguagacha-project-locks");
      expect(fs.readdirSync(registry)).toHaveLength(1);
      await expect(ProjectFileLock.acquire(missing_project, options)).rejects.toMatchObject({
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
    const missing_project = path.join(temp.path, "missing", "demo.lg");

    await expect(
      ProjectFileLock.acquire(missing_project, {
        data_root: path.join(blocker, "data"),
        temp_root: path.join(blocker, "temp"),
      }),
    ).rejects.toMatchObject({ code: "project.lock_unavailable" });
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
