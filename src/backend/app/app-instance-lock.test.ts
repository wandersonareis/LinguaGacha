import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { AppInstanceLock } from "./app-instance-lock";

describe("AppInstanceLock", () => {
  it("同一数据目录拒绝第二个实例，释放后可重新打开", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-instance-lock-"));
    const user_data_root = path.join(temp.path, "userdata");

    const first = await AppInstanceLock.acquire(user_data_root);
    try {
      await expect(AppInstanceLock.acquire(user_data_root)).rejects.toMatchObject({
        code: "runtime.instance_in_use",
      });
    } finally {
      await first.release();
    }

    const second = await AppInstanceLock.acquire(user_data_root);
    await second.release();
  });

  it("不同数据目录可以同时打开", async () => {
    using first_root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-instance-a-"));
    using second_root = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-instance-b-"));
    const first = await AppInstanceLock.acquire(path.join(first_root.path, "userdata"));
    const second = await AppInstanceLock.acquire(path.join(second_root.path, "userdata"));
    try {
      expect(first).not.toBe(second);
    } finally {
      await Promise.all([first.release(), second.release()]);
    }
  });
});
