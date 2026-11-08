import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NativeFs } from "../../native/native-fs";
import { FormatPluginService } from "./format-plugin-service";
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

function write_plugin(
  plugins_root: string,
  directory: string,
  manifest: Record<string, unknown>,
): void {
  const plugin_dir = path.join(plugins_root, directory);
  fs.mkdirSync(plugin_dir, { recursive: true });
  fs.writeFileSync(path.join(plugin_dir, "manifest.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(
    path.join(plugin_dir, "index.mjs"),
    "export default { read() { return { file_type: 'SAMPLE', items: [] }; } };",
    "utf8",
  );
}

function create_service(temp: string): FormatPluginService {
  return new FormatPluginService({
    plugins_root: path.join(temp, "plugins"),
    state_path: path.join(temp, "plugins.json"),
    host_entry: "",
    node_executable: process.execPath,
    native_fs,
  });
}

describe("FormatPluginService", () => {
  it("列出有效插件、持久化启停并更新生效目录", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-format-plugin-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(plugins_root, "sample", plugin_manifest());
    const service = create_service(temp.path);

    expect(service.list().plugins).toEqual([
      expect.objectContaining({ id: "sample", enabled: true, detection: "extension" }),
    ]);
    expect(service.catalog().some((format) => format.plugin_id === "sample")).toBe(true);

    await service.set_enabled("sample", false);

    expect(service.list().plugins[0]!.enabled).toBe(false);
    expect(service.catalog().some((format) => format.plugin_id === "sample")).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(temp.path, "plugins.json"), "utf8"))).toEqual({
      disabled: ["sample"],
    });

    const reopened = create_service(temp.path);
    expect(reopened.list().plugins[0]!.enabled).toBe(false);
    await reopened.dispose();
  });

  it("扩展名被内置格式占用时要求内容识别", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-format-plugin-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(
      plugins_root,
      "by-extension",
      plugin_manifest({ id: "by-extension", extensions: [".json"], file_types: ["JSONX"] }),
    );
    write_plugin(
      plugins_root,
      "by-content",
      plugin_manifest({
        id: "by-content",
        extensions: [".json"],
        file_types: ["JSONY"],
        detection: "content",
      }),
    );

    const service = create_service(temp.path);
    const catalog = service.list();

    expect(catalog.plugins.map((plugin) => plugin.id)).toEqual(["by-content"]);
    expect(catalog.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining(".json"),
    ]);
  });

  it("状态文件损坏时按全部启用继续", () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-format-plugin-"));
    const plugins_root = path.join(temp.path, "plugins");
    write_plugin(plugins_root, "sample", plugin_manifest());
    fs.writeFileSync(path.join(temp.path, "plugins.json"), "not-json", "utf8");

    const service = create_service(temp.path);

    expect(service.list().plugins[0]!.enabled).toBe(true);
  });

  it("未知插件身份返回请求错误", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-format-plugin-"));
    const service = create_service(temp.path);
    await expect(service.set_enabled("missing", false)).rejects.toMatchObject({
      code: "request.validation_failed",
    });
  });
});
