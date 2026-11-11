import type { Item, ItemFileType } from "../../../domain/item";
import { create_item } from "../../../domain/item";
import { JsonTool } from "../../../shared/utils/json-tool";
import { write_text_file } from "../shared/file-format-helpers";
import { read_translation_for_generation } from "../shared/translation-generation-text";
import {
  FFX_LANGUAGES,
  FFX_SOURCE_LANG,
  FFX_TARGET_LANG,
  add_hash_prefix,
  read_ffx_extra,
} from "./ffx-common";

/** Identidade do artefato JSON do FFX Resources. */
export const FFX_JSON_FILE_TYPE = "FFX_JSON" satisfies ItemFileType;

/** FFX JSON tem metadata/rows por file_key. */
export function is_ffx_json(data: unknown): boolean {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return false;
  const obj = data as Record<string, unknown>;
  const firstKey = Object.keys(obj)[0];
  if (!firstKey) return false;
  const entry = obj[firstKey];
  return typeof entry === "object" && entry !== null && "metadata" in entry && "rows" in entry;
}

/** Lê o JSON do FFX Resources para itens do projeto. */
export function read_ffx_json(data: unknown, rel_path: string): Item[] {
  const items: Item[] = [];
  const obj = data as Record<string, unknown>;

  for (const [fileKey, entryData] of Object.entries(obj)) {
    const entry = entryData as {
      metadata?: { key?: string; id?: string; version?: string; pattern?: string };
      rows?: Array<{
        index: number;
        name?: string;
        character?: string;
        kind?: string;
        hash?: Record<string, string>;
        text?: Record<string, string>;
        original?: Record<string, string>;
        missingInOriginal?: boolean;
        missingInTranslated?: boolean;
        divergent?: boolean;
        source?: string;
        target?: string;
      }>;
    };
    if (!entry.rows) continue;

    for (const row of entry.rows) {
      const textMap = row.text ?? {};
      const hashMap = row.hash ?? {};
      const src = textMap[FFX_SOURCE_LANG];
      if (src === undefined || src === "") {
        throw new Error(
          `FFX JSON format requires 'us' (English) as source language in file: ${rel_path}, key: ${fileKey}`,
        );
      }

      // Todas as traduções ficam no extra_field; o projeto só traduz o dst.
      const translations: Record<
        string,
        { text: string; hash: string; source?: string; target?: string }
      > = {};
      for (const lang of FFX_LANGUAGES) {
        if (lang !== FFX_SOURCE_LANG && textMap[lang]) {
          // O hash do artefato carrega o prefixo $; o DTO guarda o hex puro.
          const hash = hashMap[lang] ?? "";
          translations[lang] = {
            text: textMap[lang],
            hash: hash.startsWith("$") ? hash.slice(1) : hash,
          };
        }
      }

      const usHash = hashMap[FFX_SOURCE_LANG] ?? "";
      const usEntry: { text: string; hash: string; source?: string; target?: string } = {
        text: src,
        hash: usHash.startsWith("$") ? usHash.slice(1) : usHash,
      };
      if (row.source !== undefined) usEntry.source = row.source;
      if (row.target !== undefined) usEntry.target = row.target;
      translations[FFX_SOURCE_LANG] = usEntry;

      const extraField = {
        ffx_key: fileKey,
        ffx_metadata: entry.metadata,
        ffx_translations: translations,
        ffx_original: row.original,
        ffx_missingInOriginal: row.missingInOriginal,
        ffx_missingInTranslated: row.missingInTranslated,
        ffx_divergent: row.divergent,
        ffx_character: row.character,
        ffx_kind: row.kind,
      };

      items.push(
        create_item({
          src,
          dst: "",
          row: row.index,
          file_type: FFX_JSON_FILE_TYPE,
          file_path: rel_path,
          tag: fileKey,
          extra_field: JsonTool.stringifyStrict(extraField),
          status: "NONE",
        }),
      );
    }
  }

  return items;
}

/** Atualiza as traduções do JSON original, preservando o restante do arquivo. */
export async function write_ffx_json(
  items: readonly Item[],
  rel_path: string,
  translated_path: string,
  original_text: string,
): Promise<void> {
  const originalData = JsonTool.parseStrict(original_text) as Record<string, unknown>;

  for (const item of items) {
    const fileKey = item.tag;
    const entry = originalData[fileKey] as { rows?: unknown[] };
    if (!entry || !entry.rows) continue;

    const translation = read_translation_for_generation(item);
    if (translation === undefined) continue;

    const extra = read_ffx_extra(item.extra_field);
    const name = extra.ffx_name ?? "";
    const translations = extra.ffx_translations ?? {};
    const source = translations[FFX_SOURCE_LANG]?.text ?? "";
    const target = translations[FFX_TARGET_LANG]?.text ?? translation;

    for (const row of entry.rows) {
      const r = row as {
        index: number;
        name?: string;
        text?: Record<string, string>;
        hash?: Record<string, string>;
        source?: string;
        target?: string;
      };
      if (r.index === item.row && (r.name ?? "") === name) {
        if (!r.text) r.text = {};
        r.text[FFX_TARGET_LANG] = translation;
        if (!r.hash) r.hash = {};
        r.hash[FFX_TARGET_LANG] = add_hash_prefix(
          extra.ffx_hash ?? translations[FFX_SOURCE_LANG]?.hash ?? "",
        );
        r.source = source;
        r.target = target;
        break;
      }
    }
  }

  await write_text_file(
    `${translated_path}/${rel_path}`,
    JsonTool.stringifyStrict(originalData, { indent: 2 }),
  );
}
