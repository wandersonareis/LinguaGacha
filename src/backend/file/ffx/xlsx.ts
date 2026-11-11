import type { Item, ItemFileType } from "../../../domain/item";
import { create_item } from "../../../domain/item";
import { JsonTool } from "../../../shared/utils/json-tool";
import { write_binary_file } from "../shared/file-format-helpers";
import { cell_text, read_workbook, write_cell } from "../shared/spreadsheet";
import { read_translation_for_generation } from "../shared/translation-generation-text";
import { FFX_SOURCE_LANG, FFX_TARGET_LANG, add_hash_prefix, read_ffx_extra } from "./ffx-common";
import path from "node:path";

/** Identidade do artefato XLSX do FFX Resources. */
export const FFX_XLSX_FILE_TYPE = "FFX_XLSX" satisfies ItemFileType;

const FFX_XLSX_HEADER = [
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

// Índices 0-based das colunas.
const COL_KEY = 0;
const COL_ID = 1;
const COL_NAME = 2;
const COL_INDEX = 3;
const COL_LANG = 4;
const COL_HASH = 5;
const COL_TEXT = 6;
const COL_SOURCE = 7;
const COL_TARGET = 8;
const COL_DIVERGENT = 9;

/** Lê o XLSX do FFX Resources; header desconhecido devolve lista vazia. */
export async function read_ffx_xlsx(content: Uint8Array, rel_path: string): Promise<Item[]> {
  const workbook = await read_workbook(content);
  const sheet = workbook.worksheets[0];
  if (!sheet) return [];

  const header: string[] = [];
  for (let col = 1; col <= FFX_XLSX_HEADER.length; col += 1) {
    header.push(cell_text(sheet.getCell(1, col).value ?? ""));
  }

  const isNewFormat =
    header[7]?.toLowerCase() === "source" && header[8]?.toLowerCase() === "target";
  const expected = isNewFormat ? FFX_XLSX_HEADER : OLD_HEADER;
  if (!expected.every((cell, index) => header[index]?.toLowerCase() === cell)) {
    return [];
  }

  const sourceIndex = isNewFormat ? COL_SOURCE : -1;
  const targetIndex = isNewFormat ? COL_TARGET : -1;
  const divergentIndex = isNewFormat ? COL_DIVERGENT : 7;

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

  for (let row = 2; row <= sheet.rowCount; row += 1) {
    const key = cell_text(sheet.getCell(row, COL_KEY + 1).value ?? "");
    if (!key) continue;

    const id = cell_text(sheet.getCell(row, COL_ID + 1).value ?? "");
    const name = cell_text(sheet.getCell(row, COL_NAME + 1).value ?? "");
    const indexText = cell_text(sheet.getCell(row, COL_INDEX + 1).value ?? "");
    const lang = cell_text(sheet.getCell(row, COL_LANG + 1).value ?? "").toLowerCase();
    const hash = cell_text(sheet.getCell(row, COL_HASH + 1).value ?? "");
    const text = cell_text(sheet.getCell(row, COL_TEXT + 1).value ?? "");
    const source =
      sourceIndex < 0 ? "" : cell_text(sheet.getCell(row, sourceIndex + 1).value ?? "");
    const target =
      targetIndex < 0 ? "" : cell_text(sheet.getCell(row, targetIndex + 1).value ?? "");
    const divergent = cell_text(sheet.getCell(row, divergentIndex + 1).value ?? "");
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
        file_type: FFX_XLSX_FILE_TYPE,
        file_path: rel_path,
        tag: group.key,
        extra_field: JsonTool.stringifyStrict(extraField),
        status: "NONE",
      }),
    );
  }

  return items;
}

/** Atualiza as células do XLSX original, preservando o restante da planilha. */
export async function write_ffx_xlsx(
  items: readonly Item[],
  rel_path: string,
  translated_path: string,
  original: Buffer,
): Promise<void> {
  const workbook = await read_workbook(new Uint8Array(original));
  const sheet = workbook.worksheets[0];
  if (!sheet) return;

  for (const item of items) {
    const translation = read_translation_for_generation(item);
    if (translation === undefined) continue;

    const extra = read_ffx_extra(item.extra_field);
    const name = extra.ffx_name ?? "";
    const translations = extra.ffx_translations ?? {};
    const source = translations[FFX_SOURCE_LANG]?.text ?? "";
    const target = translations[FFX_TARGET_LANG]?.text ?? translation;

    for (let row = 2; row <= sheet.rowCount; row += 1) {
      const rowName = cell_text(sheet.getCell(row, COL_NAME + 1).value ?? "");
      const rowIndex =
        Number.parseInt(cell_text(sheet.getCell(row, COL_INDEX + 1).value ?? ""), 10) || 0;
      if (rowIndex === item.row && rowName === name) {
        write_cell(sheet, row, COL_TEXT + 1, translation);
        write_cell(
          sheet,
          row,
          COL_HASH + 1,
          add_hash_prefix(extra.ffx_hash ?? translations[FFX_SOURCE_LANG]?.hash ?? ""),
        );
        write_cell(sheet, row, COL_SOURCE + 1, source);
        write_cell(sheet, row, COL_TARGET + 1, target);
        break;
      }
    }
  }

  await write_binary_file(path.join(translated_path, rel_path), await workbook.xlsx.writeBuffer());
}
