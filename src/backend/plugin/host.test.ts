import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { NativeFs } from "../../native/native-fs";
import { PluginHost } from "./host";
import { PLUGIN_API_VERSION, type PluginManifest } from "./protocol";

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
    return {
      file_type: "SAMPLE",
      items: [{ src: input.content.toString("utf8"), row: 0, tag: "a" }],
    };
  },
  write(input) {
    return {
      translated: input.items.map((item) => item.dst ?? item.src).join("\\n"),
      bilingual: "S:" + input.asset.toString("utf8") + "\\nD:" + (input.items[0]?.dst ?? ""),
    };
  },
  detect(input) {
    return input.content.toString("utf8").startsWith("SAMPLE:");
  },
};
`;

/** 每个用例独占插件目录与工作根，避免请求之间共享可写状态。 */
function create_fixture(temp: string, source = PLUGIN_SOURCE) {
  const plugin_dir = path.join(temp, "plugin");
  fs.mkdirSync(plugin_dir, { recursive: true });
  fs.writeFileSync(path.join(plugin_dir, "index.mjs"), source, "utf8");
  const work_root = path.join(temp, "work");
  fs.mkdirSync(work_root, { recursive: true });
  return { entry_path: path.join(plugin_dir, "index.mjs"), work_root };
}

async function open_host(temp: string, source = PLUGIN_SOURCE): Promise<PluginHost> {
  const fixture = create_fixture(temp, source);
  const host = new PluginHost({
    manifest: MANIFEST,
    entry_path: fixture.entry_path,
    work_root: fixture.work_root,
    target_language: "PT",
    native_fs,
  });
  await host.start();
  return host;
}

describe("PluginHost", () => {
  it("读取来源并把条目交给父进程", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(temp.path);
    const input_path = path.join(temp.path, "work", "input.bin");
    fs.writeFileSync(input_path, "olá", "utf8");

    const response = await host.handle({
      v: PLUGIN_API_VERSION,
      id: 1,
      method: "read",
      params: { rel_path: "a.sample", input_path },
    });

    expect(response).toEqual({
      v: PLUGIN_API_VERSION,
      id: 1,
      ok: true,
      result: {
        file_type: "SAMPLE",
        items: [{ src: "olá", row: 0, tag: "a" }],
      },
    });
  });

  it("写回译文与双语产物", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(temp.path);
    const work_root = path.join(temp.path, "work");
    const asset_path = path.join(work_root, "asset.bin");
    const translated_path = path.join(work_root, "translated.out");
    const bilingual_path = path.join(work_root, "bilingual.out");
    fs.writeFileSync(asset_path, "hello", "utf8");

    const response = await host.handle({
      v: PLUGIN_API_VERSION,
      id: 2,
      method: "write",
      params: {
        rel_path: "a.sample",
        items: [{ src: "hello", dst: "olá", row: 0 }],
        asset_path,
        translated_path,
        bilingual_path,
      },
    });

    expect(response).toEqual({
      v: PLUGIN_API_VERSION,
      id: 2,
      ok: true,
      result: { written: ["translated", "bilingual"] },
    });
    expect(fs.readFileSync(translated_path, "utf8")).toBe("olá");
    expect(fs.readFileSync(bilingual_path, "utf8")).toBe("S:hello\nD:olá");
  });

  it("内容识别返回布尔值", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(temp.path);
    const input_path = path.join(temp.path, "work", "input.bin");
    fs.writeFileSync(input_path, "SAMPLE:1", "utf8");

    await expect(
      host.handle({
        v: PLUGIN_API_VERSION,
        id: 3,
        method: "detect",
        params: { rel_path: "a.sample", input_path },
      }),
    ).resolves.toMatchObject({ ok: true, result: { detected: true } });
  });

  it("拒绝清单未登记的格式与越界路径", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(
      temp.path,
      "export default { read() { return { file_type: 'OTHER', items: [] }; } };",
    );
    const work_root = path.join(temp.path, "work");
    const outside = path.join(temp.path, "outside.bin");
    fs.writeFileSync(outside, "x", "utf8");
    fs.writeFileSync(path.join(work_root, "input.bin"), "x", "utf8");

    await expect(
      host.handle({
        v: PLUGIN_API_VERSION,
        id: 4,
        method: "read",
        params: { rel_path: "a.sample", input_path: path.join(work_root, "input.bin") },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "file.invalid_structure" } });

    await expect(
      host.handle({
        v: PLUGIN_API_VERSION,
        id: 5,
        method: "read",
        params: { rel_path: "a.sample", input_path: outside },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "request.validation_failed" } });
  });

  it("插件异常只影响当前请求", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(
      temp.path,
      "export default { read() { throw new Error('boom'); } };",
    );
    const input_path = path.join(temp.path, "work", "input.bin");
    fs.writeFileSync(input_path, "x", "utf8");

    const response = await host.handle({
      v: PLUGIN_API_VERSION,
      id: 6,
      method: "read",
      params: { rel_path: "a.sample", input_path },
    });

    expect(response).toMatchObject({ ok: false, error: { code: "file.parse_failed" } });
  });

  it("缺少处理器时返回请求错误", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-host-"));
    const host = await open_host(temp.path, "export default { write() { return {}; } };");
    const input_path = path.join(temp.path, "work", "input.bin");
    fs.writeFileSync(input_path, "x", "utf8");

    await expect(
      host.handle({
        v: PLUGIN_API_VERSION,
        id: 7,
        method: "read",
        params: { rel_path: "a.sample", input_path },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: "request.validation_failed" } });
  });
});
