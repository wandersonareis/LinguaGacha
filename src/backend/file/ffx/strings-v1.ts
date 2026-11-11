import type { Item } from "../../../domain/item";
import type { StringsBlock, StringsWriteBlock } from "./strings-common";
import {
  STRINGS_DELIMITER,
  STRINGS_SOURCE_MARK,
  STRINGS_TARGET_MARK,
  add_strings_hash_prefix,
  create_strings_item,
  escape_strings_value,
  first_non_empty,
  strings_checksum,
} from "./strings-common";

/**
 * O v1 não declara idiomas no header: a linha do idioma default carrega o
 * pristine em `source` e a tradução em `target` (projeções inline).
 */
export const STRINGS_V1_SOURCE_LANG = "us";

/** Lê um bloco v1; a projeção `source` prevalece sobre o valor da linha. */
export function read_strings_v1_block(block: StringsBlock, rel_path: string): Item[] {
  return [...block.rows.values()].map((row) => {
    const source = row.translations.get(STRINGS_V1_SOURCE_LANG);
    let src = first_non_empty(source?.source, source?.text);
    if (src === "") {
      for (const translation of row.translations.values()) {
        if (translation.text !== "") {
          src = translation.text;
          break;
        }
      }
    }
    return create_strings_item(row, block.metadata, src, rel_path);
  });
}

/** Serializa um bloco v1, com o par source/target na linha do idioma default. */
export function render_strings_v1(block: StringsWriteBlock): string[] {
  const lines = [`/*key=${block.key} row_count=${block.metadata.rowCount ?? block.rows.length}*/`];

  for (const row of block.rows) {
    const translations = row.extra.ffx_translations ?? {};
    const source = translations[STRINGS_V1_SOURCE_LANG];
    const sourceText = first_non_empty(source?.source, source?.text, row.src);
    const targetText = row.translation ?? first_non_empty(source?.target);

    const suffix = row.name === "" ? "" : `:${row.name}`;
    const prefix = `${row.id}${suffix}:${row.index}`;
    const emitted = new Set<string>();

    const emit = (lang: string, text: string, hash: string): string | undefined => {
      if (emitted.has(lang) || text === "") return undefined;
      emitted.add(lang);
      return `${prefix}:${lang}${STRINGS_DELIMITER}${add_strings_hash_prefix(
        hash === "" ? strings_checksum(text) : hash,
      )} = ${escape_strings_value(text)}`;
    };

    let line = emit(STRINGS_V1_SOURCE_LANG, sourceText, source?.hash ?? "");
    if (line === undefined && targetText !== "") {
      // Pristine vazio mas com tradução: a linha vazia ainda carrega o target.
      line = `${prefix}:${STRINGS_V1_SOURCE_LANG}${STRINGS_DELIMITER}${add_strings_hash_prefix(
        source?.hash ?? strings_checksum(""),
      )} = `;
      emitted.add(STRINGS_V1_SOURCE_LANG);
    }
    if (line !== undefined) {
      if (sourceText !== "") line += `${STRINGS_SOURCE_MARK}${escape_strings_value(sourceText)}`;
      if (targetText !== "") line += `${STRINGS_TARGET_MARK}${escape_strings_value(targetText)}`;
      lines.push(line);
    }

    for (const [lang, translation] of Object.entries(translations)) {
      if (translation === undefined) continue;
      const other = emit(lang, translation.text, translation.hash);
      if (other !== undefined) lines.push(other);
    }
  }

  return lines;
}
