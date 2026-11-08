import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NativeFs } from "../../native/native-fs";
import { discover_plugins } from "./manifest";
import { PLUGIN_API_VERSION } from "./protocol";

const native_fs = new NativeFs();

function plugin_manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    api_version: PLUGIN_API_VERSION,
    id: "sample",
    version: "1.0.0",
    name: "Sample",
    entry: "index.mjs",
    extensions: [".sample"],
    file_types: ["SAMPLE"],
    ...overrides,
  };
}

/** 清单先落盘再扫描，插件代码在发现阶段不会被执行。 */
function write_plugin(
  plugins_root: string,
  directory: string,
  manifest: unknown,
  entry_file = "index.mjs",
): void {
  const plugin_dir = path.join(plugins_root, directory);
  fs.mkdirSync(plugin_dir, { recursive: true });
  fs.writeFileSync(path.join(plugin_dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(
    path.join(plugin_dir, entry_file),
    "export default { read() { return { file_type: 'SAMPLE', items: [] }; } };",
    "utf8",
  );
}

describe("discover_plugins", () => {
  it("发现有效插件并跳过没有清单的目录", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-manifest-"));
    const plugins_root = path.join(temp.path, "plugins");
    fs.mkdirSync(path.join(plugins_root, "ignored"), { recursive: true });
    write_plugin(plugins_root, "sample", plugin_manifest());

    const result = discover_plugins(plugins_root, native_fs);

    expect(result.diagnostics).toEqual([]);
    expect(result.plugins.map((plugin) => plugin.manifest.id)).toEqual(["sample"]);
    expect(result.plugins[0]!.entry_path).toBe(
      path.join(plugins_root, "sample", "index.mjs"),
    );
  });

  it("拒绝与内置格式或其它插件重复的身份", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-manifest-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(plugins_root, "a", plugin_manifest({ id: "a", file_types: ["TXT"] }));
    write_plugin(
      plugins_root,
      "b",
      plugin_manifest({ id: "b", extensions: [".same"], file_types: ["SAME"] }),
    );
    write_plugin(
      plugins_root,
      "c",
      plugin_manifest({ id: "c", extensions: [".same"], file_types: ["OTHER"] }),
    );
    write_plugin(plugins_root, "d", plugin_manifest({ id: "d", file_types: ["SAME"] }));

    const result = discover_plugins(plugins_root, native_fs);

    expect(result.plugins.map((plugin) => plugin.manifest.id)).toEqual(["b"]);
    expect(result.diagnostics.map((diagnostic) => path.basename(diagnostic.directory))).toEqual([
      "a",
      "c",
      "d",
    ]);
  });

  it("拒绝路径穿越、绝对路径与非 ESM 入口", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-manifest-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(plugins_root, "traversal", plugin_manifest({ entry: "../evil.mjs" }));
    write_plugin(plugins_root, "absolute", plugin_manifest({ entry: path.resolve(temp.path, "evil.mjs") }));
    write_plugin(plugins_root, "commonjs", plugin_manifest({ entry: "index.js" }), "index.js");

    const result = discover_plugins(plugins_root, native_fs);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(3);
  });

  it("拒绝不支持的 API 版本", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-manifest-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(plugins_root, "future", plugin_manifest({ api_version: PLUGIN_API_VERSION + 1 }));

    const result = discover_plugins(plugins_root, native_fs);

    expect(result.plugins).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
  });

  it("插件根不存在时返回空结果", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-manifest-"));
    expect(discover_plugins(path.join(temp.path, "missing"), native_fs)).toEqual({
      plugins: [],
      diagnostics: [],
    });
  });
});
