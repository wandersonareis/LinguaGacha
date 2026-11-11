import { create_item, type Item, type ItemFileType } from "../../../domain/item";
import { JsonTool } from "../../../shared/utils/json-tool";
import { write_text_file } from "../shared/file-format-helpers";
import { read_translation_for_generation } from "../shared/translation-generation-text";

/** FFX PO 与其它 FFX 格式共用条目身份，扩展名识别后由内容校验确认。 */
export const FFX_PO_FILE_TYPE = "FFX_PO" satisfies ItemFileType;

const IMPORT_PREFIX = "import:";
const REFERENCE_PREFIX = "ref[";

/**
 * `#. import:` 元数据。字段与 FFX Resources 的 PO 产物一致：
 * `field` 只在同一索引包含多个字段时出现，`hash` 是原文在 data/ 中的哈希。
 */
type PoImportMeta = Readonly<{
  file?: string;
  name?: string;
  index?: number;
  field?: string;
  lang?: string;
  hash?: string;
}>;

type PoEntry = {
  extracted: string[]; // "#." 注释，含 import 元数据和语言参考。
  source_refs: string[]; // "#:" 源引用，按出现顺序保留。
  msgctxt: string;
  msgid: string;
  msgstr: string;
  has_msgid: boolean;
  has_msgstr: boolean;
  plural: boolean;
};

type PoTranslation = {
  text: string;
  hash: string;
  source?: string;
  target?: string;
};

type PoExtraField = {
  ffx_key?: string;
  ffx_po_name?: string;
  ffx_po_field?: string;
  ffx_metadata?: { key?: string; id?: string };
  ffx_translations?: Record<string, PoTranslation | undefined>;
};

/** PO 只表达原文与译文，重复的 msgid/msgstr 或结构标记缺失时不是 FFX PO。 */
export function is_po_document(text: string): boolean {
  return /^[ \t]*msgid[ \t]+"/mu.test(text) && /^[ \t]*msgstr(?:\[\d+\])?[ \t]+"/mu.test(text);
}

/**
 * 读取 FFX PO 为工程条目。`msgid` 是原文，`msgstr` 是译文；
 * 不处理复数形式，游戏文本没有按数量变化的槽位。
 */
export function read_po_items(text: string, rel_path: string): Item[] {
  const items: Item[] = [];
  for (const entry of parse_po(text)) {
    if (entry.plural) continue;
    if (entry.msgctxt === "" && entry.msgid === "") continue; // 头部没有条目坐标。
    const meta = read_import_meta(entry);
    const context = read_context(entry.msgctxt);
    const reference = split_reference(entry.source_refs[0]);
    const key = meta?.file ?? reference.file;
    if (key === "") continue;
    const name = meta?.name ?? (context.id !== "" ? context.id : stem_of(key));
    if (name === "") continue;
    const index =
      meta?.index ??
      (context.index >= 0 ? context.index : reference.index >= 0 ? reference.index : 0);
    const field = meta?.field ?? context.field;
    const hash = strip_hash_prefix(meta?.hash ?? "");
    const translations: Record<string, PoTranslation> = {
      us: { text: entry.msgid, hash, source: entry.msgid, target: entry.msgstr },
    };
    for (const [lang, value] of Object.entries(read_language_references(entry))) {
      translations[lang] = { text: value, hash: "" };
    }
    const extra_field = {
      ffx_key: key,
      ffx_po_name: name,
      ...(field === "" ? {} : { ffx_po_field: field }),
      ffx_metadata: { key, id: name },
      ffx_translations: translations,
    };
    items.push(
      create_item({
        src: entry.msgid,
        dst: "",
        row: index,
        file_type: FFX_PO_FILE_TYPE,
        file_path: rel_path,
        tag: key,
        extra_field: JsonTool.stringifyStrict(extra_field),
        status: "NONE",
      }),
    );
  }
  return items;
}

/**
 * 生成 FFX PO。已处理条目使用工程译文，未处理条目保留导入时的 msgstr，
 * 避免导出只包含本次翻译过的行。
 */
export function render_po(items: readonly Item[], language: string): string {
  const blocks: string[] = [];
  for (const item of items) {
    const extra = read_extra_field(item.extra_field);
    const translations = extra.ffx_translations ?? {};
    const source_entry = translations["us"];
    const source = source_entry?.text ?? item.src;
    const target = read_translation_for_generation(item) ?? source_entry?.target ?? "";
    if (source === "" && target === "") continue;
    const key = extra.ffx_key ?? (item.tag !== "" ? item.tag : item.file_path);
    if (key === "") continue;
    const name = extra.ffx_po_name ?? extra.ffx_metadata?.id ?? item.tag;
    const field = extra.ffx_po_field ?? "";
    const meta = {
      file: key,
      name,
      index: item.row,
      ...(field === "" ? {} : { field }),
      lang: "us",
      hash: add_hash_prefix(source_entry?.hash ?? ""),
    };
    const lines = [`#. ${IMPORT_PREFIX} ${JSON.stringify(meta)}`];
    for (const [lang, translation] of Object.entries(translations)) {
      if (lang === "us" || translation === undefined || translation.text === "") continue;
      lines.push(`#. ${REFERENCE_PREFIX}${lang}]: ${escape_po(translation.text)}`);
    }
    lines.push(`#: ${key}:${item.row}`);
    lines.push(`msgctxt "${escape_po(render_context(name, item.row, field))}"`);
    lines.push(`msgid "${escape_po(source)}"`);
    lines.push(`msgstr "${escape_po(target)}"`);
    blocks.push(lines.join("\n"));
  }
  return [render_header(language), ...blocks].join("\n\n") + "\n";
}

/** Grava o artefato PO no diretório de tradução. */
export async function write_ffx_po(
  items: readonly Item[],
  rel_path: string,
  translated_path: string,
  language: string,
): Promise<void> {
  await write_text_file(`${translated_path}/${rel_path}`, render_po(items, language));
}

/** 与 FFX Resources 产物同形的 gettext 头，导入时不参与条目构建。 */
function render_header(language: string): string {
  return [
    'msgid ""',
    'msgstr ""',
    '"Project-Id-Version: FFX Resources\\n"',
    '"MIME-Version: 1.0\\n"',
    '"Content-Type: text/plain; charset=UTF-8\\n"',
    '"Content-Transfer-Encoding: 8bit\\n"',
    `"Language: ${escape_po(language)}\\n"`,
  ].join("\n");
}

function read_extra_field(value: Item["extra_field"]): PoExtraField {
  return JsonTool.parseStrict(typeof value === "string" ? value : "{}") as PoExtraField;
}

/**
 * 逐行解析 PO 条目。空行、新的 msgid/msgctxt 或文件结束都会提交当前条目；
 * 注释可以在关键字之前出现，未知语法按 gettext 的宽容规则跳过。
 */
function parse_po(text: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let current = empty_entry();
  const flush = (): void => {
    if (
      current.has_msgid ||
      current.has_msgstr ||
      current.msgctxt !== "" ||
      current.extracted.length > 0 ||
      current.source_refs.length > 0
    ) {
      entries.push(current);
    }
    current = empty_entry();
  };

  const lines = text.split(/\r?\n/u);
  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at]!.trim();
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("#~")) continue; // 废弃条目不属于当前产物。
    if (line.startsWith("#")) {
      add_comment(current, line);
      continue;
    }
    if (is_keyword(line, "msgctxt")) {
      if (current.has_msgid || current.has_msgstr) flush();
      const value = read_po_value(lines, at, "msgctxt");
      current.msgctxt = value.text;
      at = value.last;
      continue;
    }
    if (is_keyword(line, "msgid_plural")) {
      current.plural = true;
      at = skip_po_value(lines, at);
      continue;
    }
    if (is_keyword(line, "msgid")) {
      if (current.has_msgid || current.has_msgstr) flush();
      const value = read_po_value(lines, at, "msgid");
      current.msgid = value.text;
      current.has_msgid = true;
      at = value.last;
      continue;
    }
    if (/^msgstr\[\d+\]/u.test(line)) {
      current.plural = true;
      at = skip_po_value(lines, at);
      continue;
    }
    if (is_keyword(line, "msgstr")) {
      const value = read_po_value(lines, at, "msgstr");
      current.msgstr = value.text;
      current.has_msgstr = true;
      at = value.last;
    }
  }
  flush();
  return entries;
}

function empty_entry(): PoEntry {
  return {
    extracted: [],
    source_refs: [],
    msgctxt: "",
    msgid: "",
    msgstr: "",
    has_msgid: false,
    has_msgstr: false,
    plural: false,
  };
}

function add_comment(entry: PoEntry, line: string): void {
  if (line.startsWith("#.")) entry.extracted.push(line.slice(2).trim());
  else if (line.startsWith("#:")) entry.source_refs.push(line.slice(2).trim());
}

/** 关键字后必须跟空格或行尾，"msgid_plural" 不能当作 "msgid"。 */
function is_keyword(line: string, keyword: string): boolean {
  return line === keyword || line.startsWith(keyword + " ");
}

/**
 * 读取关键字及其后续 `"..."` 续行。FFX PO 的值始终是单行转义字符串，
 * 这里同时接受编辑器折行后的标准 PO 写法。
 */
function read_po_value(
  lines: readonly string[],
  at: number,
  keyword: string,
): { text: string; last: number } {
  const line = lines[at]!;
  const rest = line.trim().slice(keyword.length).trim();
  if (!rest.startsWith('"'))
    throw new Error(`FFX PO requires a quoted ${keyword} value on line ${at + 1}`);
  let text = unescape_po(strip_po_quotes(rest));
  let last = at;
  while (last + 1 < lines.length) {
    const next = lines[last + 1]!.trim();
    if (!next.startsWith('"')) break;
    text += unescape_po(strip_po_quotes(next));
    last += 1;
  }
  return { text, last };
}

/** 复数槽位整体跳过，不要求首行值可解析。 */
function skip_po_value(lines: readonly string[], at: number): number {
  let last = at;
  while (last + 1 < lines.length && lines[last + 1]!.trim().startsWith('"')) last += 1;
  return last;
}

function strip_po_quotes(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  return text.replace(/^"|"$/gu, "");
}

/** 只解释 PO 定义的转义；未知序列保留反斜杠，便于原样回写。 */
function unescape_po(value: string): string {
  let result = "";
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]!;
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = value[at + 1];
    if (next === undefined) {
      result += "\\";
      break;
    }
    at += 1;
    switch (next) {
      case "n":
        result += "\n";
        break;
      case "r":
        result += "\r";
        break;
      case "t":
        result += "\t";
        break;
      case "\\":
        result += "\\";
        break;
      case '"':
        result += '"';
        break;
      default:
        result += "\\" + next;
    }
  }
  return result;
}

function escape_po(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
}

/** 元数据 JSON 是注释原文，不做 PO 转义；无效 JSON 时退回 msgctxt/#:。 */
function read_import_meta(entry: PoEntry): PoImportMeta | null {
  for (const comment of entry.extracted) {
    if (!comment.startsWith(IMPORT_PREFIX)) continue;
    const raw = comment.slice(IMPORT_PREFIX.length).trim();
    try {
      const value: unknown = JSON.parse(raw);
      if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
      const record = value as Record<string, unknown>;
      const file = read_text(record["file"]);
      const name = read_text(record["name"]);
      const index = read_index(record["index"]);
      const field = read_text(record["field"]);
      const lang = read_text(record["lang"]);
      const hash = read_text(record["hash"]);
      return {
        ...(file === undefined ? {} : { file }),
        ...(name === undefined ? {} : { name }),
        ...(index === undefined ? {} : { index }),
        ...(field === undefined ? {} : { field }),
        ...(lang === undefined ? {} : { lang }),
        ...(hash === undefined ? {} : { hash }),
      };
    } catch {
      return null;
    }
  }
  return null;
}

function read_text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function read_index(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 语言参考写成 `#. ref[sp]: texto`，导入后作为只读译文槽位保留。 */
function read_language_references(entry: PoEntry): Record<string, string> {
  const references: Record<string, string> = {};
  for (const comment of entry.extracted) {
    if (!comment.startsWith(REFERENCE_PREFIX)) continue;
    const rest = comment.slice(REFERENCE_PREFIX.length);
    const end = rest.indexOf("]:");
    if (end < 0) continue;
    const lang = rest.slice(0, end).trim();
    const value = unescape_po(rest.slice(end + 2).trim());
    if (lang !== "" && value !== "") references[lang] = value;
  }
  return references;
}

function read_context(context: string): { id: string; index: number; field: string } {
  const parts = context.split("|");
  const index = /^\d+$/u.test((parts[1] ?? "").trim()) ? Number(parts[1]!.trim()) : -1;
  return {
    id: (parts[0] ?? "").trim(),
    index,
    field: parts.slice(2).join("|").trim(),
  };
}

/** "#: 文件:索引"；没有数字后缀时索引记为未知。 */
function split_reference(reference: string | undefined): { file: string; index: number } {
  if (reference === undefined || reference === "") return { file: "", index: -1 };
  const separator = reference.lastIndexOf(":");
  if (separator < 0) return { file: reference.trim(), index: -1 };
  const suffix = reference.slice(separator + 1).trim();
  if (!/^\d+$/u.test(suffix)) return { file: reference.trim(), index: -1 };
  return { file: reference.slice(0, separator).trim(), index: Number(suffix) };
}

/** msgctxt 的 `<条目>|<索引>[|<字段>]` 与 FFX 产物保持同形。 */
function render_context(name: string, index: number, field: string): string {
  return field === "" ? `${name}|${index}` : `${name}|${index}|${field}`;
}

/** 没有 msgctxt 名称时用存储键的文件名补足条目身份。 */
function stem_of(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (normalized === "") return "";
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

function strip_hash_prefix(hash: string): string {
  return hash.startsWith("$") ? hash.slice(1) : hash;
}

function add_hash_prefix(hash: string): string {
  return hash === "" || hash.startsWith("$") ? hash : `$${hash}`;
}
