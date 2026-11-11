import { decode_text_content } from "../../../shared/utils/text-tool";
import { JsonTool } from "../../../shared/utils/json-tool";
import { group_items } from "../shared/file-format-helpers";
import type { GeneratedFilePaths } from "../file-format-types";
import type { Item, ItemFileType } from "../../../domain/item";
import { FFX_CSV_FILE_TYPE, is_ffx_csv, read_ffx_csv, write_ffx_csv } from "./csv";
import { FFX_JSON_FILE_TYPE, is_ffx_json, read_ffx_json, write_ffx_json } from "./json";
import { FFX_PO_FILE_TYPE, is_po_document, read_po_items, write_ffx_po } from "./po";
import {
  FFX_STRINGS_FILE_TYPE,
  is_ffx_strings,
  read_ffx_strings,
  write_ffx_strings,
} from "./strings";
import { FFX_XLSX_FILE_TYPE, read_ffx_xlsx, write_ffx_xlsx } from "./xlsx";
import path from "node:path";

/**
 * Orquestrador dos artefatos FFX Resources: identifica o formato pelo
 * conteúdo/extensão e delega leitura e escrita ao módulo do formato.
 *
 * Formatos: JSON (`json.ts`), CSV (`csv.ts`), XLSX (`xlsx.ts`), Strings
 * (`strings.ts`) e PO (`po.ts`).
 */
export class FFXFormat {
  /** PO 头记录工程目标语言；其余格式的槽位由 FFX 产物决定。 */
  public constructor(private readonly target_language: string) {}

  /** Detecta o formato e devolve os itens do arquivo. */
  public async read_from_stream(
    content: Uint8Array,
    rel_path: string,
  ): Promise<{ items: Item[]; file_type: ItemFileType }> {
    const text = await decode_text_content(content);
    const ext = path.extname(rel_path).toLowerCase();

    // PO: a extensão decide o parser; o conteúdo precisa ser gettext.
    if (ext === ".po") {
      if (!is_po_document(text)) {
        throw new Error(`FFX PO format requires msgid/msgstr entries in file: ${rel_path}`);
      }
      return { items: read_po_items(text, rel_path), file_type: FFX_PO_FILE_TYPE };
    }

    // JSON: a estrutura metadata/rows confirma o formato.
    if (ext === ".json") {
      try {
        const data = JsonTool.parseStrict(text);
        if (is_ffx_json(data)) {
          return { items: read_ffx_json(data, rel_path), file_type: FFX_JSON_FILE_TYPE };
        }
      } catch {
        // JSON inválido ou de outro formato; tenta os próximos.
      }
    }

    if (ext === ".csv" || is_ffx_csv(text)) {
      return { items: read_ffx_csv(text, rel_path), file_type: FFX_CSV_FILE_TYPE };
    }

    if (ext === ".strings" || is_ffx_strings(text)) {
      return { items: read_ffx_strings(text, rel_path), file_type: FFX_STRINGS_FILE_TYPE };
    }

    if (ext === ".xlsx") {
      try {
        const items = await read_ffx_xlsx(content, rel_path);
        if (items.length > 0) return { items, file_type: FFX_XLSX_FILE_TYPE };
      } catch {
        // XLSX inválido ou de outro formato.
      }
    }

    return { items: [], file_type: "NONE" };
  }

  /** Agrupa por formato e grava cada arquivo no diretório de tradução. */
  public async write_to_path(
    items: Item[],
    paths: GeneratedFilePaths,
    asset_reader: (path: string) => Buffer | null | Promise<Buffer | null>,
  ): Promise<void> {
    for (const type of [
      FFX_JSON_FILE_TYPE,
      FFX_CSV_FILE_TYPE,
      FFX_XLSX_FILE_TYPE,
      FFX_STRINGS_FILE_TYPE,
      FFX_PO_FILE_TYPE,
    ] as const) {
      for (const [rel_path, group] of group_items(items, type)) {
        const original = await asset_reader(rel_path);
        if (original === null) continue;

        switch (type) {
          case FFX_JSON_FILE_TYPE:
            await write_ffx_json(
              group,
              rel_path,
              paths.translated_path,
              await decode_text_content(original),
            );
            break;
          case FFX_CSV_FILE_TYPE:
            await write_ffx_csv(group, rel_path, paths.translated_path);
            break;
          case FFX_XLSX_FILE_TYPE:
            await write_ffx_xlsx(group, rel_path, paths.translated_path, original);
            break;
          case FFX_STRINGS_FILE_TYPE:
            await write_ffx_strings(group, rel_path, paths.translated_path);
            break;
          case FFX_PO_FILE_TYPE:
            await write_ffx_po(group, rel_path, paths.translated_path, this.target_language);
            break;
        }
      }
    }
  }
}
