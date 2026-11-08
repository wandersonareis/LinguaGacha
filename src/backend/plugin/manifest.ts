import path from "node:path";

import { ITEM_FILE_TYPES } from "../../domain/item";
import { default_native_fs, type NativeFs } from "../../native/native-fs";
import { AppError, read_error_message } from "../../shared/error";
import {
  PLUGIN_EXTENSION_PATTERN,
  PLUGIN_FILE_TYPE_PATTERN,
  PLUGIN_ID_PATTERN,
  read_plugin_manifest,
  type PluginManifest,
} from "./protocol";

export type DiscoveredPlugin = Readonly<{
  directory: string; // 插件根下的绝对目录
  entry_path: string; // 已确认存在的 ESM 入口
  manifest: PluginManifest;
}>;

export type PluginDiscoveryDiagnostic = Readonly<{ directory: string; message: string }>;

export type PluginDiscoveryResult = Readonly<{
  plugins: readonly DiscoveredPlugin[];
  diagnostics: readonly PluginDiscoveryDiagnostic[];
}>;

/**
 * 扫描插件根目录并逐个校验清单；单个坏插件只记录诊断，不影响其它插件。
 * 清单读取不执行插件代码，重复身份在进入注册表前就被拒绝。
 */
export function discover_plugins(
  plugins_root: string,
  native_fs: NativeFs = default_native_fs,
): PluginDiscoveryResult {
  const plugins: DiscoveredPlugin[] = [];
  const diagnostics: PluginDiscoveryDiagnostic[] = [];
  if (!native_fs.exists(plugins_root)) return { plugins, diagnostics };

  const seen_ids = new Set<string>();
  const seen_extensions = new Set<string>();
  const seen_file_types = new Set<string>(ITEM_FILE_TYPES); // 内置格式优先占用身份。
  for (const name of native_fs
    .read_dir_names(plugins_root)
    .slice()
    .sort((left, right) => left.localeCompare(right))) {
    const directory = path.join(plugins_root, name);
    try {
      if (!native_fs.stat(directory).isDirectory()) continue;
      const manifest_path = path.join(directory, "manifest.json");
      if (!native_fs.exists(manifest_path)) continue;
      const manifest = read_plugin_manifest(
        JSON.parse(native_fs.read_text_file(manifest_path)) as unknown,
      );
      assert_manifest_contract(
        manifest,
        seen_ids,
        seen_extensions,
        seen_file_types,
        native_fs,
        directory,
      );
      const entry_path = resolve_entry_path(directory, manifest, native_fs);
      seen_ids.add(manifest.id);
      for (const extension of manifest.extensions) seen_extensions.add(extension);
      for (const file_type of manifest.file_types) seen_file_types.add(file_type);
      plugins.push({ directory, entry_path, manifest });
    } catch (error) {
      diagnostics.push({ directory, message: read_error_message(error) });
    }
  }
  return { plugins, diagnostics };
}

/** 身份只允许小写 ASCII；插件不得占用内置格式或其它插件的扩展名。 */
function assert_manifest_contract(
  manifest: PluginManifest,
  seen_ids: ReadonlySet<string>,
  seen_extensions: ReadonlySet<string>,
  seen_file_types: ReadonlySet<string>,
  native_fs: NativeFs,
  directory: string,
): void {
  if (!PLUGIN_ID_PATTERN.test(manifest.id) || seen_ids.has(manifest.id)) {
    throw invalid_manifest("plugin_id_invalid", directory);
  }
  for (const extension of manifest.extensions) {
    if (!PLUGIN_EXTENSION_PATTERN.test(extension) || seen_extensions.has(extension)) {
      throw invalid_manifest("plugin_extension_invalid", directory);
    }
  }
  for (const file_type of manifest.file_types) {
    if (!PLUGIN_FILE_TYPE_PATTERN.test(file_type) || seen_file_types.has(file_type)) {
      throw invalid_manifest("plugin_file_type_invalid", directory);
    }
  }
  if (manifest.detection === "content" && manifest.extensions.length === 0) {
    throw invalid_manifest("plugin_detection_invalid", directory);
  }
  // 目录名只是物理位置，不参与身份；这里只确认目录本身可读。
  if (!native_fs.exists(directory)) throw invalid_manifest("plugin_directory_missing", directory);
}

/** 入口必须是目录内的单个 .mjs 文件，禁止路径穿越与绝对路径。 */
function resolve_entry_path(
  directory: string,
  manifest: PluginManifest,
  native_fs: NativeFs,
): string {
  const entry = manifest.entry;
  if (
    path.basename(entry) !== entry ||
    path.isAbsolute(entry) ||
    entry === "." ||
    entry === ".." ||
    path.extname(entry) !== ".mjs"
  ) {
    throw invalid_manifest("plugin_entry_invalid", directory);
  }
  const entry_path = path.join(directory, entry);
  if (!native_fs.exists(entry_path) || !native_fs.stat(entry_path).isFile()) {
    throw invalid_manifest("plugin_entry_missing", directory);
  }
  return entry_path;
}

function invalid_manifest(reason: string, directory: string): AppError {
  return new AppError("request.validation_failed", {
    diagnostic_context: { reason, directory },
  });
}
