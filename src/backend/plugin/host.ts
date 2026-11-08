import path from "node:path";
import { pathToFileURL } from "node:url";

import { default_native_fs, type NativeFs } from "../../native/native-fs";
import { AppError, is_app_error, read_error_message } from "../../shared/error";
import {
  PLUGIN_API_VERSION,
  PLUGIN_MAX_OUTPUT_BYTES,
  read_plugin_detect_result,
  read_plugin_output_text,
  read_plugin_read_result,
  read_plugin_write_result,
  type PluginHostFailure,
  type PluginHostRequest,
  type PluginHostResponse,
  type PluginHostResult,
  type PluginItem,
  type PluginManifest,
} from "./protocol";

/** 插件只看到的正文输入；路径与落盘位置都由宿主掌握。 */
export type PluginReadInput = Readonly<{ rel_path: string; content: Uint8Array }>;
export type PluginWriteInput = Readonly<{
  rel_path: string;
  items: readonly PluginItem[];
  asset: Uint8Array;
}>;
export type PluginContext = Readonly<{ target_language: string }>;
export type PluginReadOutput = Readonly<{ file_type: string; items: readonly PluginItem[] }>;
export type PluginWriteOutput = Readonly<{
  translated?: Uint8Array | string;
  bilingual?: Uint8Array | string;
}>;

/** 插件模块只暴露纯函数；全部 IO、校验和限制由宿主负责。 */
export type PluginModule = Readonly<{
  detect?: (input: PluginReadInput, context: PluginContext) => boolean | Promise<boolean>;
  read?: (
    input: PluginReadInput,
    context: PluginContext,
  ) => PluginReadOutput | Promise<PluginReadOutput>;
  write?: (
    input: PluginWriteInput,
    context: PluginContext,
  ) => PluginWriteOutput | Promise<PluginWriteOutput>;
}>;

export type PluginHostOptions = Readonly<{
  manifest: PluginManifest;
  entry_path: string;
  work_root: string; // 请求输入与产物的唯一可写根
  target_language: string;
  native_fs?: NativeFs;
  log?: (line: string) => void;
}>;

/**
 * 插件宿主在一个独立进程内运行，加载一个插件并处理父进程请求。
 * 宿主拥有文件读取、路径约束、输出校验与错误归一，插件不接触真实工程路径。
 */
export class PluginHost {
  private readonly native_fs: NativeFs;
  private plugin: PluginModule | null = null;
  private readonly context: PluginContext;

  public constructor(private readonly options: PluginHostOptions) {
    this.native_fs = options.native_fs ?? default_native_fs;
    this.context = Object.freeze({ target_language: options.target_language });
  }

  /** 入口只加载 ESM；缺少全部处理器时在 ready 前失败。 */
  public async start(): Promise<void> {
    const loaded = (await import(pathToFileURL(this.options.entry_path).href)) as Partial<
      PluginModule & { default?: Partial<PluginModule> }
    >;
    const plugin = (loaded.default ?? loaded) as Partial<PluginModule>;
    const has_handler = (["detect", "read", "write"] as const).some(
      (name) => typeof plugin[name] === "function",
    );
    if (!has_handler) {
      throw new AppError("request.validation_failed", {
        diagnostic_context: { reason: "plugin_exports_missing" },
      });
    }
    this.plugin = plugin as PluginModule;
    this.options.log?.(`plugin ${this.options.manifest.id}@${this.options.manifest.version} loaded`);
  }

  /** 每个请求独立结算，失败只影响当前文件。 */
  public async handle(request: PluginHostRequest): Promise<PluginHostResponse> {
    try {
      return {
        v: PLUGIN_API_VERSION,
        id: request.id,
        ok: true,
        result: await this.dispatch(request),
      };
    } catch (error) {
      return {
        v: PLUGIN_API_VERSION,
        id: request.id,
        ok: false,
        error: to_failure(request.method, error),
      };
    }
  }

  private async dispatch(request: PluginHostRequest): Promise<PluginHostResult> {
    const plugin = this.require_plugin();
    if (request.method === "read") {
      if (plugin.read === undefined) throw missing_handler("read");
      const content = this.read_input(request.params.input_path);
      const output = await plugin.read(
        { rel_path: request.params.rel_path, content },
        this.context,
      );
      return read_plugin_read_result(output, this.options.manifest.file_types);
    }
    if (request.method === "detect") {
      if (plugin.detect === undefined) throw missing_handler("detect");
      const content = this.read_input(request.params.input_path);
      const detected = await plugin.detect(
        { rel_path: request.params.rel_path, content },
        this.context,
      );
      if (typeof detected !== "boolean") {
        throw new AppError("file.invalid_structure", {
          diagnostic_context: { reason: "plugin_detect_invalid" },
        });
      }
      return read_plugin_detect_result({ detected });
    }
    if (plugin.write === undefined) throw missing_handler("write");
    const asset = this.read_input(request.params.asset_path);
    const output =
      (await plugin.write(
        { rel_path: request.params.rel_path, items: request.params.items, asset },
        this.context,
      )) ?? {};
    const translated = read_plugin_output_text(output.translated);
    const bilingual = read_plugin_output_text(output.bilingual);
    const written: ("translated" | "bilingual")[] = [];
    if (translated !== null) {
      this.write_output(request.params.translated_path, translated);
      written.push("translated");
    }
    if (bilingual !== null) {
      this.write_output(request.params.bilingual_path, bilingual);
      written.push("bilingual");
    }
    return read_plugin_write_result({ written });
  }

  private require_plugin(): PluginModule {
    if (this.plugin === null) throw new AppError("runtime.internal_invariant");
    return this.plugin;
  }

  /** 输入路径必须真实存在于工作根内，符号链接也按真实路径核对。 */
  private read_input(candidate: string): Buffer {
    const root = this.native_fs.real_path(this.options.work_root);
    const resolved = this.native_fs.real_path(candidate);
    assert_inside(root, resolved, candidate);
    return this.native_fs.read_file(resolved);
  }

  /** 输出先核对父目录，再按原文件名落盘；不允许跨出工作根。 */
  private write_output(candidate: string, content: Uint8Array): void {
    if (content.byteLength > PLUGIN_MAX_OUTPUT_BYTES) {
      throw new AppError("file.invalid_structure", {
        diagnostic_context: { reason: "plugin_output_too_large", bytes: content.byteLength },
      });
    }
    const root = this.native_fs.real_path(this.options.work_root);
    const parent = this.native_fs.real_path(path.dirname(candidate));
    assert_inside(root, parent, candidate);
    this.native_fs.write_file_sync(path.join(parent, path.basename(candidate)), content);
  }
}

function assert_inside(root: string, candidate: string, reported: string): void {
  const relative = path.relative(root, candidate);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
  throw new AppError("request.validation_failed", {
    diagnostic_context: { reason: "plugin_path_escape", path: reported },
  });
}

function missing_handler(method: string): AppError {
  return new AppError("request.validation_failed", {
    diagnostic_context: { reason: "plugin_handler_missing", method },
  });
}

/** 失败只暴露稳定错误码与可读信息，堆栈留在子进程日志。 */
function to_failure(method: PluginHostRequest["method"], error: unknown): PluginHostFailure {
  if (is_app_error(error)) return { code: error.code, message: error.message };
  return {
    code: method === "write" ? "file.io_failed" : "file.parse_failed",
    message: read_error_message(error),
  };
}
