import type { Item } from "../../../domain/item";
import { write_text_file } from "../shared/file-format-helpers";
import { read_translation_for_generation } from "../shared/translation-generation-text";
import type { StringsMetadata, StringsWriteBlock, StringsWriteRow } from "./strings-common";
import { read_strings_extra, scan_strings_blocks } from "./strings-common";
import { read_strings_v1_block, render_strings_v1 } from "./strings-v1";
import { read_strings_v2_block, render_strings_v2 } from "./strings-v2";

export { FFX_STRINGS_FILE_TYPE, is_ffx_strings } from "./strings-common";

/**
 * Desligue para parar de aceitar e serializar artefatos v1. O v2 é o formato
 * atual do ff-resources; com o v1 desligado, um artefato legado precisa ser
 * re-exportado pelo jogo antes de entrar no projeto.
 */
export const STRINGS_V1_ENABLED = true;

export type StringsFormatOptions = {
  allow_v1?: boolean;
};

/** Maior versão conhecida; versões futuras falham em vez de parsear errado. */
const STRINGS_MAX_VERSION = 2;

/** Versão do bloco: header sem `version` é v1 (compatibilidade). */
function strings_version(metadata: StringsMetadata): number {
  const version = metadata.version ?? 1;
  if (version < 1 || version > STRINGS_MAX_VERSION) {
    throw new Error(
      `FFX Strings: versão de formato ${version} não suportada (máximo ${STRINGS_MAX_VERSION})`,
    );
  }
  return version;
}

/**
 * Lê o arquivo inteiro. A versão é escolhida por bloco (header): com
 * `version` no header, vale o valor declarado; sem ele, v1.
 */
export function read_ffx_strings(
  text: string,
  rel_path: string,
  options: StringsFormatOptions = {},
): Item[] {
  const allowV1 = options.allow_v1 ?? STRINGS_V1_ENABLED;
  const items: Item[] = [];

  for (const block of scan_strings_blocks(text)) {
    if (strings_version(block.metadata) >= 2) {
      items.push(...read_strings_v2_block(block, rel_path));
      continue;
    }
    if (!allowV1) {
      throw new Error(`FFX Strings: bloco v1 desativado em ${rel_path}; re-exporte no formato v2`);
    }
    items.push(...read_strings_v1_block(block, rel_path));
  }

  return items;
}

/** Escreve o arquivo, preservando a versão de cada bloco. */
export async function write_ffx_strings(
  items: readonly Item[],
  rel_path: string,
  translated_path: string,
  options: StringsFormatOptions = {},
): Promise<void> {
  const allowV1 = options.allow_v1 ?? STRINGS_V1_ENABLED;
  const groups = new Map<string, { metadata: StringsMetadata; rows: StringsWriteRow[] }>();

  for (const item of items) {
    const extra = read_strings_extra(item.extra_field);
    const metadata = extra.ffx_metadata ?? {};
    const key = metadata.key ?? extra.ffx_key ?? item.tag ?? rel_path;
    let group = groups.get(key);
    if (group === undefined) {
      group = { metadata, rows: [] };
      groups.set(key, group);
    }
    group.rows.push({
      id: item.tag !== "" ? item.tag : key,
      name: extra.ffx_name ?? "",
      index: item.row,
      src: item.src,
      extra,
      translation: read_translation_for_generation(item),
    });
  }

  const lines: string[] = [];
  for (const [key, group] of groups) {
    if (strings_version(group.metadata) < 2 && !allowV1) {
      throw new Error(`FFX Strings: escrita v1 desativada em ${rel_path}`);
    }
    // SortRows do ff-resources ordena por Index de forma estável.
    const rows = [...group.rows].sort((left, right) => left.index - right.index);
    const block: StringsWriteBlock = { key, metadata: group.metadata, rows };
    lines.push(
      ...(strings_version(group.metadata) >= 2
        ? render_strings_v2(block)
        : render_strings_v1(block)),
    );
  }

  await write_text_file(`${translated_path}/${rel_path}`, lines.join("\n"));
}
