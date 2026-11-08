import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { build } from "vite";

import { NativeFs } from "../../native/native-fs";
import { PLUGIN_API_VERSION, type PluginManifest } from "./protocol";
import { PluginSupervisor } from "./supervisor";

const native_fs = new NativeFs();
const MANIFEST: PluginManifest = {
  api_version: PLUGIN_API_VERSION,
  id: "sample",
  version: "1.0.0",
  name: "Sample",
  entry: "index.mjs",
  extensions: [".sample"],
  file_types: ["SAMPLE"],
};

const PLUGIN_SOURCE = `
export default {
  read(input) {
    const secret = process.env.LG_PLUGIN_SENTINEL ?? "missing";
    return {
      file_type: "SAMPLE",
      items: [{ src: input.content.toString("utf8") + "|" + secret, row: 0 }],
    };
  },
  write(input) {
    return { translated: input.items.map((item) => item.dst ?? item.src).join("\\n") };
  },
  detect(input) {
    return input.content.toString("utf8") === "hit";
  },
};
`;

let build_output: string;
let host_entry: string;

beforeAll(async () => {
  build_output = fs.mkdtempSync(path.join(os.tmpdir(), "lg-plugin-host-build-"));
  await build({
    configFile: false,
    resolve: { conditions: ["node"], mainFields: ["module", "main"] },
    publicDir: false,
    build: {
      target: "node24",
      outDir: build_output,
      emptyOutDir: true,
      minify: false,
      lib: {
        entry: { "plugin-host": path.join(process.cwd(), "src/backend/plugin/host-entry.ts") },
        formats: ["es"],
        fileName: () => "plugin-host.mjs",
      },
      rolldownOptions: { platform: "node", external: [...builtinModules, /^node:/u] },
    },
  });
  host_entry = path.join(build_output, "plugin-host.mjs");
}, 120_000);

afterAll(() => {
  fs.rmSync(build_output, { recursive: true, force: true });
});

/** 插件目录与工作根都由用例独占；重写入口即可验证重启。 */
function create_plugin(temp: string, source = PLUGIN_SOURCE): string {
  const directory = path.join(temp, "plugin");
  fs.mkdirSync(directory, { recursive: true });
  const entry_path = path.join(directory, "index.mjs");
  fs.writeFileSync(entry_path, source, "utf8");
  return entry_path;
}

function create_supervisor(entry_path: string, timeout_ms = 5_000): PluginSupervisor {
  return new PluginSupervisor({
    manifest: MANIFEST,
    entry_path,
    host_entry,
    node_executable: process.execPath,
    target_language: "PT",
    timeout_ms,
    native_fs,
  });
}

describe("PluginSupervisor", () => {
  it("在子进程内完成读取、识别与写回，且不继承宿主环境变量", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-supervisor-"));
    vi.stubEnv("LG_PLUGIN_SENTINEL", "secret");
    const supervisor = create_supervisor(create_plugin(temp.path));
    try {
      const parsed = await supervisor.read("a.sample", Buffer.from("olá", "utf8"));
      expect(parsed).toEqual({
        file_type: "SAMPLE",
        items: [{ src: "olá|missing", row: 0 }],
      });
      await expect(supervisor.detect("a.sample", Buffer.from("hit", "utf8"))).resolves.toBe(true);

      const files = await supervisor.write(
        "a.sample",
        [{ src: "hello", dst: "olá", row: 0 }],
        Buffer.from("asset", "utf8"),
      );
      expect(Buffer.from(files.translated!).toString("utf8")).toBe("olá");
    } finally {
      await supervisor.dispose();
    }
  });

  it("超时后终止子进程，下一次调用重新启动", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-supervisor-"));
    const entry_path = create_plugin(
      temp.path,
      "export default { read() { return new Promise(() => {}); } };",
    );
    const supervisor = create_supervisor(entry_path, 400);
    try {
      await expect(supervisor.read("a.sample", Buffer.from("x"))).rejects.toMatchObject({
        code: "runtime.cancelled",
      });
      fs.writeFileSync(entry_path, PLUGIN_SOURCE, "utf8");
      await expect(supervisor.read("a.sample", Buffer.from("x"))).resolves.toMatchObject({
        file_type: "SAMPLE",
      });
    } finally {
      await supervisor.dispose();
    }
  });

  it("子进程崩溃只影响当前调用，随后可恢复", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-supervisor-"));
    const entry_path = create_plugin(temp.path, "export default { read() { process.exit(1); } };");
    const supervisor = create_supervisor(entry_path);
    try {
      await expect(supervisor.read("a.sample", Buffer.from("x"))).rejects.toMatchObject({
        code: "file.parse_failed",
      });
      fs.writeFileSync(entry_path, PLUGIN_SOURCE, "utf8");
      await expect(supervisor.read("a.sample", Buffer.from("x"))).resolves.toMatchObject({
        file_type: "SAMPLE",
      });
    } finally {
      await supervisor.dispose();
    }
  });

  it("关闭后拒绝新调用", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-supervisor-"));
    const supervisor = create_supervisor(create_plugin(temp.path));
    await supervisor.dispose();

    await expect(supervisor.read("a.sample", Buffer.from("x"))).rejects.toMatchObject({
      code: "runtime.disposed",
    });
  });
});
