import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { acquire_no_delete_guard } from "./file-lock";

describe("file-lock", () => {
  it("Windows 上持有 guard 时拒绝删除目录，释放后允许删除", (context) => {
    if (process.platform !== "win32") {
      context.skip();
      return;
    }
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "lg-file-lock-"));
    const guard = acquire_no_delete_guard(directory);
    if (guard === null) {
      context.skip(); // addon 未编译：本机缺少 Visual C++ Build Tools。
      return;
    }
    try {
      expect(() => fs.rmdirSync(directory)).toThrow();
    } finally {
      guard.close();
    }
    fs.rmdirSync(directory);
  });
});
