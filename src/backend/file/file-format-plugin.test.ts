import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, inject } from "vitest";

import { NativeFs } from "../../native/native-fs";
import { FormatPluginService } from "../plugin/format-plugin-service";
import { PLUGIN_API_VERSION } from "../plugin/protocol";
import { FileFormatService } from "./file-format-service";
import { GameDirectoryOperations } from "./shared/game/game-directory-operations";

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
      bilingual: input.asset.toString("utf8") + "|" + (input.items[0]?.dst ?? ""),
    };
  },
};
`;

const MANIFEST = {
  api_version: PLUGIN_API_VERSION,
  id: "sample",
  version: "1.0.0",
  name: "Sample",
  entry: "index.mjs",
  extensions: [".sample"],
  file_types: ["SAMPLE"],
};

let host_entry: string;

beforeAll(() => {
  host_entry = inject("pluginHostEntry");
});

describe("FileFormatService 插件分发", () => {
  it("按扩展名解析、按格式身份写回，并保留条目工程字段", async () => {
    using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "lg-plugin-format-"));
    const native = new NativeFs();
    const plugins_root = path.join(temp.path, "plugins");
    const plugin_dir = path.join(plugins_root, "sample");
    fs.mkdirSync(plugin_dir, { recursive: true });
    fs.writeFileSync(
      path.join(plugin_dir, "manifest.json"),
      JSON.stringify(MANIFEST),
      "utf8",
    );
    fs.writeFileSync(path.join(plugin_dir, "index.mjs"), PLUGIN_SOURCE, "utf8");
    const plugins = new FormatPluginService({
      plugins_root,
      state_path: path.join(temp.path, "plugins.json"),
      host_entry,
      node_executable: process.execPath,
      native_fs: native,
    });
    const service = new FileFormatService(
      new GameDirectoryOperations(native),
      { target_language: "PT" },
      async () => null,
      native,
      undefined,
      plugins,
    );
    try {
      const parsed = await service.parse_asset("data.sample", Buffer.from("hello", "utf8"));
      if (parsed.kind !== "items") throw new Error("Expected plugin items");
      expect(parsed.file_type).toBe("SAMPLE");
      expect(parsed.items).toMatchObject([
        { src: "hello", row: 0, tag: "a", file_type: "SAMPLE", file_path: "data.sample" },
      ]);

      const translated_path = path.join(temp.path, "translated");
      const bilingual_path = path.join(temp.path, "bilingual");
      fs.mkdirSync(translated_path);
      fs.mkdirSync(bilingual_path);
      await service.write_items(
        [{ ...parsed.items[0]!, status: "PROCESSED", dst: "olá" }],
        {
          paths: { translated_path, bilingual_path },
          source_files: [{ path: "data.sample", file_type: "SAMPLE" }],
          asset_reader: () => Buffer.from("asset", "utf8"),
        },
      );

      expect(fs.readFileSync(path.join(translated_path, "data.sample"), "utf8")).toBe("olá");
      expect(fs.readFileSync(path.join(bilingual_path, "data.sample"), "utf8")).toBe(
        "asset|olá",
      );
    } finally {
      await plugins.dispose();
    }
  });
});
