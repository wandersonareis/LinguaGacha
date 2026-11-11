import type { Item, ItemFileType } from "../../../domain/item";
import { create_item } from "../../../domain/item";
import { JsonTool } from "../../../shared/utils/json-tool";
import { write_text_file } from "../shared/file-format-helpers";
import { read_translation_for_generation } from "../shared/translation-generation-text";
import { FFX_SOURCE_LANG, FFX_TARGET_LANG, add_hash_prefix, read_ffx_extra } from "./ffx-common";

/** Identidade do artefato CSV do FFX Resources. */
export const FFX_CSV_FILE_TYPE = "FFX_CSV" satisfies ItemFileType;

const FFX_CSV_HEADER = [
  "key",
  "id",
  "name",
  "index",
  "lang",
  "hash",
  "text",
  "source",
  "target",
  "divergent",
];

// Colunas do formato antigo (8 colunas, sem source/target).
const OLD_HEADER = ["key", "id", "name", "index", "lang", "hash", "text", "divergent"];

/** Aceita o header antigo (8 colunas) e o atual (10, com source/target). */
export function is_ffx_csv(text: string): boolean {
  const lines = text.split(/\r?\n/);
  if (lines.length === 0 || !lines[0]) return false;
  const header = lines[0].split(",").map((cell) => cell.trim().replace(/^"|"$/gu, ""));
  if (header.length === OLD_HEADER.length) {
    return header.every((cell, index) => cell === OLD_HEADER[index]);
  }
  return (
    header.length === FFX_CSV_HEADER.length &&
    header.every((cell, index) => cell === FFX_CSV_HEADER[index])
  );
}

/** Lê o CSV do FFX Resources, agrupando as linhas de idioma por key+index. */
export function read_ffx_csv(text: string, rel_path: string): Item[] {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2 || !lines[0]) return [];

  const header = lines[0].split(",").map((cell) => cell.trim().replace(/^"|"$/gu, ""));
  const isNewFormat =
    header.length === FFX_CSV_HEADER.length && header[7] === "source" && header[8] === "target";
  const expectedCols = isNewFormat ? FFX_CSV_HEADER.length : OLD_HEADER.length;
  const sourceIndex = isNewFormat ? 7 : -1;
  const targetIndex = isNewFormat ? 8 : -1;
  const divergentIndex = isNewFormat ? 9 : 7;

  const grouped = new Map<
    string,
    {
      key: string;
      id: string;
      name: string;
      index: number;
      translations: Map<
        string,
        { text: string; hash: string; divergent: boolean; source?: string; target?: string }
      >;
    }
  >();

  for (let lineIndex = 1; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]?.trim();
    if (!line) continue;
    const fields = parse_csv_line(line);
    if (fields.length < expectedCols) continue;

    const key = fields[0] ?? "";
    const id = fields[1] ?? "";
    const name = fields[2] ?? "";
    const indexText = fields[3] ?? "0";
    const lang = (fields[4] ?? "").toLowerCase();
    const hash = fields[5] ?? "";
    const text = fields[6] ?? "";
    const source = sourceIndex < 0 ? "" : (fields[sourceIndex] ?? "");
    const target = targetIndex < 0 ? "" : (fields[targetIndex] ?? "");
    const divergent = fields[divergentIndex] ?? "";
    if (!lang) continue;

    const index = Number.parseInt(indexText, 10) || 0;
    const groupKey = `${key}:${index}`;
    let group = grouped.get(groupKey);
    if (group === undefined) {
      group = { key, id, name, index, translations: new Map() };
      grouped.set(groupKey, group);
    }
    group.translations.set(lang, {
      text,
      hash,
      divergent: divergent === "true",
      source,
      target,
    });
  }

  const items: Item[] = [];
  for (const group of grouped.values()) {
    const src = group.translations.get(FFX_SOURCE_LANG)?.text ?? "";
    if (!src) continue;

    const translations: Record<
      string,
      { text: string; hash: string; divergent: boolean; source?: string; target?: string }
    > = {};
    for (const [lang, translation] of group.translations) translations[lang] = translation;

    const extraField = {
      ffx_key: group.key,
      ffx_id: group.id,
      ffx_name: group.name,
      ffx_translations: translations,
    };

    items.push(
      create_item({
        src,
        dst: "",
        row: group.index,
        file_type: FFX_CSV_FILE_TYPE,
        file_path: rel_path,
        tag: group.key,
        extra_field: JsonTool.stringifyStrict(extraField),
        status: "NONE",
      }),
    );
  }

  return items;
}

/** Escreve uma linha por item traduzido no formato atual de 10 colunas. */
export async function write_ffx_csv(
  items: readonly Item[],
  rel_path: string,
  translated_path: string,
): Promise<void> {
  const lines: string[] = [FFX_CSV_HEADER.join(",")];

  for (const item of items) {
    const translation = read_translation_for_generation(item);
    if (translation === undefined) continue;

    const extra = read_ffx_extra(item.extra_field);
    const translations = extra.ffx_translations ?? {};
    const source = translations[FFX_SOURCE_LANG]?.text ?? "";
    const target = translations[FFX_TARGET_LANG]?.text ?? translation;

    const record = [
      escape_csv(extra.ffx_key ?? item.tag),
      escape_csv(extra.ffx_id ?? ""),
      escape_csv(extra.ffx_name ?? ""),
      item.row.toString(),
      escape_csv(FFX_TARGET_LANG),
      escape_csv(add_hash_prefix(extra.ffx_hash ?? translations[FFX_SOURCE_LANG]?.hash ?? "")),
      escape_csv(translation),
      escape_csv(source),
      escape_csv(target),
      escape_csv(extra.ffx_divergent ? "true" : "false"),
    ];
    lines.push(record.join(","));
  }

  await write_text_file(`${translated_path}/${rel_path}`, lines.join("\n"));
}

/** Decompõe uma linha CSV respeitando aspas RFC 4180. */
function parse_csv_line(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] ?? "";
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === "," && !quoted) {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * CSV 没有单元格类型，Excel 导入时会按内容重新解释字段；FFX 产物同时供外部工具消费，
 * 改写以 `=` 开头的值会破坏原稿，因此这里只做 RFC 4180 引号并保持字段原值。
 */
function escape_csv(field: string): string {
  if (field.includes(",") || field.includes('"') || field.includes("\n")) {
    return '"' + field.replace(/"/gu, '""') + '"';
  }
  return field;
}
