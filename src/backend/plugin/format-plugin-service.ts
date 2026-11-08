import { is_json_record } from "../../domain/json";
import { default_native_fs, type NativeFs } from "../../native/native-fs";
import { AppError } from "../../shared/error";
import {
  BUILTIN_FORMAT_CATALOG,
  type FormatCatalogEntry,
  type FormatPluginCatalog,
  type FormatPluginDiagnostic,
} from "../../shared/project-source-formats";
import { discover_plugins, type DiscoveredPlugin } from "./manifest";
import type { PluginSupervisorOptions } from "./supervisor";
import { PluginSupervisor } from "./supervisor";

export type FormatPluginServiceOptions = Readonly<{
  plugins_root: string;
  state_path: string; // 启停状态文件，聚合在 userdata 下
  host_entry: string; // 已构建的插件宿主入口
  node_executable: string;
  node_arguments?: readonly string[];
  node_env?: Readonly<Record<string, string>>;
  hardening?: boolean; // 启用 Node 权限模型与堆上限
  native_fs?: NativeFs;
  log?: (line: string) => void;
}>;

/**
 * 插件目录只在这里解释：发现、启停、宿主生命周期与外层目录都收口于本服务。
 * 宿主进程按插件与目标语言懒启动，关闭业务根时统一释放。
 */
export class FormatPluginService {
  private readonly native_fs: NativeFs;
  private readonly plugins: readonly DiscoveredPlugin[];
  private readonly diagnostics: readonly FormatPluginDiagnostic[];
  private readonly disabled: Set<string>;
  private readonly supervisors = new Map<string, PluginSupervisor>();

  public constructor(private readonly options: FormatPluginServiceOptions) {
    this.native_fs = options.native_fs ?? default_native_fs;
    const discovered = discover_plugins(options.plugins_root, this.native_fs);
    // 扩展名被内置格式占用时只能声明为内容识别，避免抢走标准来源。
    const builtin_extensions = new Set(
      BUILTIN_FORMAT_CATALOG.filter((format) => format.source_kind === "file").flatMap(
        (format) => format.extensions,
      ),
    );
    const plugins: DiscoveredPlugin[] = [];
    const diagnostics: FormatPluginDiagnostic[] = [...discovered.diagnostics];
    for (const plugin of discovered.plugins) {
      const reserved =
        plugin.manifest.detection === "content"
          ? undefined
          : plugin.manifest.extensions.find((extension) => builtin_extensions.has(extension));
      if (reserved === undefined) plugins.push(plugin);
      else
        diagnostics.push({
          directory: plugin.directory,
          message: `Extension ${reserved} is reserved by a built-in format.`,
        });
    }
    this.plugins = plugins;
    this.diagnostics = diagnostics;
    this.disabled = this.read_disabled();
  }

  /** 生效目录只包含内置格式与已启用插件，供解析、发现与摘要共用。 */
  public catalog(): readonly FormatCatalogEntry[] {
    return [
      ...BUILTIN_FORMAT_CATALOG,
      ...this.enabled_plugins().map(
        (plugin): FormatCatalogEntry => ({
          source_kind: "file",
          id: plugin.manifest.id,
          support_status: "supported",
          detection: plugin.manifest.detection ?? "extension",
          extension: plugin.manifest.extensions[0]!,
          extensions: plugin.manifest.extensions,
          title: plugin.manifest.name,
          description: plugin.manifest.description ?? "",
          plugin_id: plugin.manifest.id,
        }),
      ),
    ];
  }

  /** 界面同时看到被禁用的有效插件，未通过校验的目录只出现在诊断里。 */
  public list(): FormatPluginCatalog {
    return {
      formats: this.catalog(),
      plugins: this.plugins.map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        description: plugin.manifest.description ?? "",
        version: plugin.manifest.version,
        api_version: plugin.manifest.api_version,
        extensions: plugin.manifest.extensions,
        file_types: plugin.manifest.file_types,
        detection: plugin.manifest.detection ?? "extension",
        enabled: !this.disabled.has(plugin.manifest.id),
      })),
      diagnostics: this.diagnostics,
    };
  }

  /** 持久化条目的格式身份决定写回处理器。 */
  public plugin_for_file_type(file_type: string): DiscoveredPlugin | undefined {
    return this.enabled_plugins().find((plugin) =>
      plugin.manifest.file_types.includes(file_type),
    );
  }

  /** 独占扩展名的插件直接参与发现；共享扩展名必须声明内容识别。 */
  public plugin_for_extension(extension: string): DiscoveredPlugin | undefined {
    return this.enabled_plugins().find(
      (plugin) =>
        (plugin.manifest.detection ?? "extension") !== "content" &&
        plugin.manifest.extensions.includes(extension),
    );
  }

  /** 内容识别插件按目录顺序尝试，首个命中者拥有该文件。 */
  public content_plugins(extension: string): readonly DiscoveredPlugin[] {
    return this.enabled_plugins().filter(
      (plugin) =>
        plugin.manifest.detection === "content" &&
        plugin.manifest.extensions.includes(extension),
    );
  }

  /** 每个插件与目标语言组合复用同一宿主进程。 */
  public supervisor(plugin: DiscoveredPlugin, target_language: string): PluginSupervisor {
    const key = `${plugin.manifest.id}\u0000${target_language}`;
    const existing = this.supervisors.get(key);
    if (existing !== undefined) return existing;
    const options: PluginSupervisorOptions = {
      manifest: plugin.manifest,
      entry_path: plugin.entry_path,
      host_entry: this.options.host_entry,
      node_executable: this.options.node_executable,
      ...(this.options.node_arguments === undefined
        ? {}
        : { node_arguments: this.options.node_arguments }),
      ...(this.options.node_env === undefined ? {} : { node_env: this.options.node_env }),
      target_language,
      hardening: this.options.hardening ?? false,
      native_fs: this.native_fs,
      ...(this.options.log === undefined ? {} : { log: this.options.log }),
    };
    const supervisor = new PluginSupervisor(options);
    this.supervisors.set(key, supervisor);
    return supervisor;
  }

  /** 启停状态写入 userdata，下一次目录读取立即生效。 */
  public async set_enabled(plugin_id: string, enabled: boolean): Promise<void> {
    if (!this.plugins.some((plugin) => plugin.manifest.id === plugin_id)) {
      throw new AppError("request.validation_failed", {
        diagnostic_context: { reason: "plugin_unknown", plugin_id },
      });
    }
    if (enabled) this.disabled.delete(plugin_id);
    else this.disabled.add(plugin_id);
    for (const [key, supervisor] of this.supervisors) {
      if (!key.startsWith(`${plugin_id}\u0000`)) continue;
      this.supervisors.delete(key);
      await supervisor.dispose();
    }
    this.native_fs.write_file_atomic(
      this.options.state_path,
      JSON.stringify({ disabled: [...this.disabled].sort() }, null, 2),
    );
  }

  /** 关闭全部宿主进程；之后的业务根不再服务插件。 */
  public async dispose(): Promise<void> {
    const supervisors = [...this.supervisors.values()];
    this.supervisors.clear();
    await Promise.all(supervisors.map((supervisor) => supervisor.dispose()));
  }

  private enabled_plugins(): readonly DiscoveredPlugin[] {
    return this.plugins.filter((plugin) => !this.disabled.has(plugin.manifest.id));
  }

  private read_disabled(): Set<string> {
    try {
      if (!this.native_fs.exists(this.options.state_path)) return new Set();
      const value = JSON.parse(this.native_fs.read_text_file(this.options.state_path)) as unknown;
      if (!is_json_record(value) || !Array.isArray(value["disabled"])) return new Set();
      return new Set(value["disabled"].filter((id): id is string => typeof id === "string"));
    } catch {
      // 状态文件损坏时按全部启用继续，插件目录本身仍可正常使用。
      return new Set();
    }
  }
}
