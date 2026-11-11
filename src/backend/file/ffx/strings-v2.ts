import type { Item } from "../../../domain/item";
import type { StringsBlock, StringsWriteBlock } from "./strings-common";
import {
  STRINGS_DELIMITER,
  add_strings_hash_prefix,
  create_strings_item,
  escape_strings_value,
  first_non_empty,
  strings_checksum,
} from "./strings-common";

/**
 * O v2 declara o par CAT no header (`source=` / `target=`). Nada de idioma
 * chumbado: sem o mapa o bloco é inválido e precisa ser re-exportado.
 */
function read_pair(metadata: StringsBlock["metadata"], rel_path: string): [string, string] {
  const { source, target } = metadata;
  if (source === undefined || source === "" || target === undefined || target === "") {
    throw new Error(`FFX Strings v2 sem source/target no header: ${rel_path}`);
  }
  return [source, target];
}

/** Lê um bloco v2; a linha do idioma fonte é o pristine. */
export function read_strings_v2_block(block: StringsBlock, rel_path: string): Item[] {
  const [sourceLang, targetLang] = read_pair(block.metadata, rel_path);

  return [...block.rows.values()].map((row) => {
    let src = row.translations.get(sourceLang)?.text ?? "";
    if (src === "") {
      // Sem linha fonte, usa uma referência de jogo — nunca a tradução alvo.
      for (const [lang, translation] of row.translations) {
        if (lang !== targetLang && translation.text !== "") {
          src = translation.text;
          break;
        }
      }
    }
    return create_strings_item(row, block.metadata, src, rel_path);
  });
}

/** Serializa um bloco v2 com os idiomas declarados no header. */
export function render_strings_v2(block: StringsWriteBlock): string[] {
  const [sourceLang, targetLang] = read_pair(block.metadata, block.key);
  const lines = [
    `/*key=${block.key} row_count=${block.metadata.rowCount ?? block.rows.length} version=2 source=${sourceLang} target=${targetLang}*/`,
  ];

  for (const row of block.rows) {
    const translations = row.extra.ffx_translations ?? {};
    const source = translations[sourceLang];
    const target = translations[targetLang];
    const sourceText = first_non_empty(source?.source, source?.text, row.src);
    const targetText = row.translation ?? first_non_empty(target?.text, source?.target);

    const suffix = row.name === "" ? "" : `:${row.name}`;
    const prefix = `${row.id}${suffix}:${row.index}`;
    const emitted = new Set<string>();
    const emit = (lang: string, text: string, hash: string): void => {
      if (emitted.has(lang) || text === "") return;
      emitted.add(lang);
      lines.push(
        `${prefix}:${lang}${STRINGS_DELIMITER}${add_strings_hash_prefix(
          hash === "" ? strings_checksum(text) : hash,
        )} = ${escape_strings_value(text)}`,
      );
    };

    // Ordem do ff-resources: fonte, alvo e depois as referências.
    emit(sourceLang, sourceText, source?.hash ?? "");
    emit(targetLang, targetText, target?.hash ?? "");
    for (const [lang, translation] of Object.entries(translations)) {
      if (translation !== undefined) emit(lang, translation.text, translation.hash);
    }
  }

  return lines;
}
