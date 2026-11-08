import { Type, type Static } from "typebox";
import { Compile } from "typebox/compile";

import { JSON_VALUE_SCHEMA, is_json_record, type JsonRecord } from "../../domain/json";
import { AppError } from "../../shared/error";

/** 插件宿主协议版本；两端在执行任何插件代码前先核对。 */
export const PLUGIN_API_VERSION = 1;

export const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
export const PLUGIN_FILE_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/u;
export const PLUGIN_EXTENSION_PATTERN = /^\.[a-z0-9]+$/u;

/** 单条正文上限；插件输出超出范围视为结构错误。 */
export const PLUGIN_MAX_ITEM_TEXT_LENGTH = 1_000_000;
/** 单个文件产出的字节上限；FFX 等大型来源仍在范围内。 */
export const PLUGIN_MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
/** 单文件条目上限；防止错误插件把进程内存打满。 */
export const PLUGIN_MAX_ITEMS = 2_000_000;

const PLUGIN_MANIFEST_SCHEMA = Type.Object(
  {
    api_version: Type.Integer({ minimum: 1 }),
    id: Type.String({ minLength: 1, maxLength: 64 }),
    version: Type.String({ minLength: 1, maxLength: 64 }),
    name: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.Optional(Type.String({ maxLength: 500 })),
    entry: Type.String({ minLength: 1, maxLength: 200 }),
    extensions: Type.Array(Type.String({ minLength: 2, maxLength: 16 }), {
      minItems: 1,
      maxItems: 16,
    }),
    file_types: Type.Array(Type.String({ minLength: 1, maxLength: 64 }), {
      minItems: 1,
      maxItems: 16,
    }),
    detection: Type.Optional(Type.Union([Type.Literal("extension"), Type.Literal("content")])),
  },
  { additionalProperties: false },
);
const PLUGIN_MANIFEST_VALIDATOR = Compile(PLUGIN_MANIFEST_SCHEMA);

/** 插件条目的公开形状；身份字段由核心在导入时补齐。 */
const PLUGIN_ITEM_SCHEMA = Type.Object(
  {
    src: Type.String(),
    dst: Type.Optional(Type.String()),
    name_src: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    name_dst: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    extra_field: Type.Optional(JSON_VALUE_SCHEMA),
    tag: Type.Optional(Type.String()),
    row: Type.Integer({ minimum: 0 }),
    file_type: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);
const PLUGIN_ITEM_VALIDATOR = Compile(PLUGIN_ITEM_SCHEMA);

/** 清单只含声明事实，插件代码在被校验前不执行。 */
export type PluginManifest = Static<typeof PLUGIN_MANIFEST_SCHEMA>;
/** 插件返回的条目只允许公开业务字段。 */
export type PluginItem = Static<typeof PLUGIN_ITEM_SCHEMA>;

export type PluginReadRequest = Readonly<{
  v: number;
  id: number;
  method: "read";
  params: Readonly<{ rel_path: string; input_path: string }>;
}>;
export type PluginWriteRequest = Readonly<{
  v: number;
  id: number;
  method: "write";
  params: Readonly<{
    rel_path: string;
    items: readonly PluginItem[];
    asset_path: string;
    translated_path: string;
    bilingual_path: string;
  }>;
}>;
export type PluginDetectRequest = Readonly<{
  v: number;
  id: number;
  method: "detect";
  params: Readonly<{ rel_path: string; input_path: string }>;
}>;
export type PluginHostRequest = PluginReadRequest | PluginWriteRequest | PluginDetectRequest;

export type PluginReadResult = Readonly<{ file_type: string; items: readonly PluginItem[] }>;
export type PluginWriteResult = Readonly<{
  written: readonly ("translated" | "bilingual")[];
}>;
export type PluginDetectResult = Readonly<{ detected: boolean }>;
export type PluginHostResult = PluginReadResult | PluginWriteResult | PluginDetectResult;

/** 失败只带稳定错误码与可读信息，堆栈留在子进程日志。 */
export type PluginHostFailure = Readonly<{ code: string; message: string }>;
export type PluginHostResponse = Readonly<
  | { v: number; id: number; ok: true; result: PluginHostResult }
  | { v: number; id: number; ok: false; error: PluginHostFailure }
>;

/** 子进程启动后先发 ready；启动失败发 fatal 并退出。 */
export type PluginHostSignal =
  | Readonly<{ v: number; type: "ready"; api_version: number }>
  | Readonly<{ v: number; type: "fatal"; error: PluginHostFailure }>;

/** 清单来自磁盘 JSON，只接受当前 API 版本。 */
export function read_plugin_manifest(value: unknown): PluginManifest {
  if (!PLUGIN_MANIFEST_VALIDATOR.Check(value)) {
    throw new AppError("request.validation_failed", {
      diagnostic_context: { reason: "plugin_manifest_invalid" },
    });
  }
  const manifest = value as PluginManifest;
  if (manifest.api_version !== PLUGIN_API_VERSION) {
    throw new AppError("request.validation_failed", {
      diagnostic_context: {
        reason: "plugin_api_version_unsupported",
        expected: PLUGIN_API_VERSION,
        actual: manifest.api_version,
      },
    });
  }
  return manifest;
}

/** 子进程入口解析父进程消息；任何形状偏差都按请求错误处理。 */
export function read_plugin_host_request(value: unknown): PluginHostRequest {
  if (!is_json_record(value)) throw invalid_request();
  if (value["v"] !== PLUGIN_API_VERSION) throw invalid_request();
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) throw invalid_request();
  const method = value["method"];
  const params = value["params"];
  if (!is_json_record(params)) throw invalid_request();
  if (method === "read" || method === "detect") {
    return {
      v: PLUGIN_API_VERSION,
      id,
      method,
      params: {
        rel_path: read_text(params, "rel_path"),
        input_path: read_text(params, "input_path"),
      },
    };
  }
  if (method === "write") {
    return {
      v: PLUGIN_API_VERSION,
      id,
      method,
      params: {
        rel_path: read_text(params, "rel_path"),
        items: read_plugin_items(params["items"]),
        asset_path: read_text(params, "asset_path"),
        translated_path: read_text(params, "translated_path"),
        bilingual_path: read_text(params, "bilingual_path"),
      },
    };
  }
  throw invalid_request();
}

/** 父进程只接受 ready/fatal 两类信号。 */
export function read_plugin_host_signal(value: unknown): PluginHostSignal | null {
  if (!is_json_record(value)) return null;
  if (value["v"] !== PLUGIN_API_VERSION) return null;
  if (value["type"] === "ready") {
    return {
      v: PLUGIN_API_VERSION,
      type: "ready",
      api_version: Number(value["api_version"] ?? 0),
    };
  }
  if (value["type"] === "fatal" && is_json_record(value["error"])) {
    return {
      v: PLUGIN_API_VERSION,
      type: "fatal",
      error: {
        code: String(value["error"]["code"] ?? "runtime.internal_invariant"),
        message: String(value["error"]["message"] ?? ""),
      },
    };
  }
  return null;
}

/** 响应外壳先核对关联字段，结果由对应方法的校验器继续收窄。 */
export function read_plugin_host_response(value: unknown): PluginHostResponse {
  if (!is_json_record(value)) throw invalid_response();
  if (value["v"] !== PLUGIN_API_VERSION) throw invalid_response();
  const id = value["id"];
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) throw invalid_response();
  if (value["ok"] === true) {
    return { v: PLUGIN_API_VERSION, id, ok: true, result: value["result"] as PluginHostResult };
  }
  if (value["ok"] === false && is_json_record(value["error"])) {
    return {
      v: PLUGIN_API_VERSION,
      id,
      ok: false,
      error: {
        code: String(value["error"]["code"] ?? "request.validation_failed"),
        message: String(value["error"]["message"] ?? ""),
      },
    };
  }
  throw invalid_response();
}

/** 读取结果只能声明清单已登记的格式。 */
export function read_plugin_read_result(
  value: unknown,
  allowed_file_types: readonly string[],
): PluginReadResult {
  if (!is_json_record(value)) throw invalid_structure();
  const file_type = value["file_type"];
  if (typeof file_type !== "string" || !allowed_file_types.includes(file_type)) {
    throw invalid_structure();
  }
  return { file_type, items: read_plugin_items(value["items"]) };
}

/** 写回结果只报告宿主实际落盘的种类。 */
export function read_plugin_write_result(value: unknown): PluginWriteResult {
  if (!is_json_record(value) || !Array.isArray(value["written"])) throw invalid_structure();
  const written = value["written"];
  if (!written.every((entry) => entry === "translated" || entry === "bilingual")) {
    throw invalid_structure();
  }
  return { written };
}

export function read_plugin_detect_result(value: unknown): PluginDetectResult {
  if (!is_json_record(value) || typeof value["detected"] !== "boolean") throw invalid_structure();
  return { detected: value["detected"] };
}

/** 条目数组在宿主与父进程两侧共用同一形状与上限。 */
export function read_plugin_items(value: unknown): PluginItem[] {
  if (!Array.isArray(value) || value.length > PLUGIN_MAX_ITEMS) throw invalid_structure();
  const items: PluginItem[] = [];
  for (const entry of value) {
    if (!PLUGIN_ITEM_VALIDATOR.Check(entry)) throw invalid_structure();
    const item = entry as PluginItem;
    if (item.src.length > PLUGIN_MAX_ITEM_TEXT_LENGTH) throw invalid_structure();
    items.push(item);
  }
  return items;
}

/** 插件返回的正文允许字符串或字节。 */
export function read_plugin_output_text(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return Buffer.from(value, "utf8");
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw invalid_structure();
}

function read_text(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw invalid_request();
  return value;
}

function invalid_request(): AppError {
  return new AppError("request.validation_failed");
}

function invalid_response(): AppError {
  return new AppError("file.invalid_structure", {
    diagnostic_context: { reason: "plugin_response_invalid" },
  });
}

function invalid_structure(): AppError {
  return new AppError("file.invalid_structure", {
    diagnostic_context: { reason: "plugin_output_invalid" },
  });
}
