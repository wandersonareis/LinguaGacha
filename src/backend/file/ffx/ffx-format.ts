import { decode_text_content } from "../../../shared/utils/text-tool";
import { JsonTool } from "../../../shared/utils/json-tool";
import { group_items, write_text_file, write_binary_file } from "../shared/file-format-helpers";
import { read_translation_for_generation } from "../shared/translation-generation-text";
import type { GeneratedFilePaths } from "../file-format-types";
import type { Item, ItemFileType } from "../../../domain/item";
import { create_item } from "../../../domain/item";
import { read_workbook, cell_text, write_cell } from "../shared/spreadsheet";
import { FFX_PO_FILE_TYPE, is_po_document, read_po_items, render_po } from "./po";
import path from "node:path";

const FFX_JSON_TYPE = "FFX_JSON";
const FFX_CSV_TYPE = "FFX_CSV";
const FFX_XLSX_TYPE = "FFX_XLSX";
const FFX_STRINGS_TYPE = "FFX_STRINGS";
const FFX_PO_TYPE = FFX_PO_FILE_TYPE;

// FFX CSV/XLSX header with source/target projection columns
// source = reference text from data/vbf (us/English), target = translation from mods/
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

// Column indices for XLSX (0-based)
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

// FFX supported languages (2-char codes)
// 'us' (English) is the source language for translation
const FFX_LANGUAGES = ["us", "ch", "de", "fr", "it", "jp", "kr", "sp", "pt"] as const;

// Special delimiter character in FFX Strings format (U+2551 BOX DRAWINGS DOUBLE VERTICAL)
const STRINGS_DELIMITER = "║";

/**
 * FFX Format Handler
 * Supports FFX Resources export formats: JSON, CSV, XLSX, Strings, PO
 */
export class FFXFormat {
  /** PO 头记录工程目标语言；其余格式的槽位由 FFX 产物决定。 */
  public constructor(private readonly target_language: string) {}

  /**
   * Detect if content is FFX JSON format
   * FFX JSON has structure: { "file_key": { "metadata": {...}, "rows": [...] } }
   */
  private static isFFXJSON(data: unknown): boolean {
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      return false;
    }
    const obj = data as Record<string, unknown>;
    // Check if first entry has FFX structure
    const firstKey = Object.keys(obj)[0];
    if (!firstKey) return false;
    const entry = obj[firstKey];
    return typeof entry === "object" && entry !== null && "metadata" in entry && "rows" in entry;
  }

  /**
   * Detect if content is FFX CSV format (supports both old 8-col and new 10-col headers)
   */
  private static isFFXCSV(text: string): boolean {
    const lines = text.split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) return false;
    const header = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    // Accept both old format (8 cols) and new format (10 cols with source/target)
    if (header.length === 8) {
      return header.every(
        (h, i) => h === ["key", "id", "name", "index", "lang", "hash", "text", "divergent"][i],
      );
    }
    return (
      header.length === FFX_CSV_HEADER.length && header.every((h, i) => h === FFX_CSV_HEADER[i])
    );
  }

  /**
   * Detect if content is FFX Strings format
   * Format: (comment)key=... row_count=...(comment) followed by lines like: fileKey:rowIndex:lang<delimiter>hash = text
   */
  private static isFFXStrings(text: string): boolean {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("/*key=") && trimmed.includes("row_count=")) {
        return true;
      }
      // Data line format: fileKey:rowIndex:lang<delimiter>hash = text
      if (trimmed.includes(STRINGS_DELIMITER) && trimmed.includes(" = ")) {
        return true;
      }
    }
    return false;
  }

  /**
   * Read FFX JSON format
   * JSON structure: { fileKey: { metadata, rows: [{ index, name, character, kind, hash, text, original, missingInOriginal, missingInTranslated, divergent }] } }
   * text is a map of langCode -> translation (8 languages: us, ch, de, fr, it, jp, kr, sp)
   * 'us' is the source language
   * Hashes in artifact format have $ prefix (e.g., $860c5395b0614e48)
   * Supports source/target projection in rows
   */
  private static readFFXJSON(data: unknown, rel_path: string): Item[] {
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

        // 'us' (English) is always the source language - must exist or throw error
        const src = textMap["us"];
        if (src === undefined || src === "") {
          throw new Error(
            `FFX JSON format requires 'us' (English) as source language in file: ${rel_path}, key: ${fileKey}`,
          );
        }

        // Store all translations in extra_field for reference (like CSV/XLSX/Strings readers)
        const translationsObj: Record<
          string,
          { text: string; hash: string; source?: string; target?: string }
        > = {};
        for (const lang of FFX_LANGUAGES) {
          if (lang !== "us" && textMap[lang]) {
            // Strip $ prefix from hash if present
            let hash = hashMap[lang] ?? "";
            if (hash.startsWith("$")) hash = hash.slice(1);
            translationsObj[lang] = { text: textMap[lang], hash };
          }
        }
        // Also store us entry with source/target if present
        const usHash = hashMap["us"] ?? "";
        const usHashStripped = usHash.startsWith("$") ? usHash.slice(1) : usHash;
        // src is already validated to exist (line 136-138)
        const usEntry: { text: string; hash: string; source?: string; target?: string } = {
          text: src,
          hash: usHashStripped,
        };
        if (row.source !== undefined) usEntry.source = row.source;
        if (row.target !== undefined) usEntry.target = row.target;
        translationsObj["us"] = usEntry;

        // Build extra_field with FFX-specific metadata
        const extraField = {
          ffx_key: fileKey,
          ffx_metadata: entry.metadata,
          ffx_translations: translationsObj,
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
            dst: "", // Empty dst - translation will fill this for project's target language
            row: row.index,
            file_type: FFX_JSON_TYPE as ItemFileType,
            file_path: rel_path,
            tag: fileKey,
            extra_field: JsonTool.stringifyStrict(extraField),
            status: "NONE", // Always NONE to allow translation to project's target language; existing translations preserved in extra_field
          }),
        );
      }
    }
    return items;
  }

  /**
   * Read FFX CSV format
   * Columns: key, id, name, index, lang, hash, text, source, target, divergent
   * lang is 2-char code (us, ch, de, fr, it, jp, kr, sp, pt, etc.)
   * Groups rows by key+index, uses 'us' as source, stores all translations in extra_field
   * Supports both old 8-col format and new 10-col format with source/target
   */
  private static readFFXCSV(text: string, rel_path: string): Item[] {
    const items: Item[] = [];
    const lines = text.split(/\r?\n/);
    if (lines.length < 2 || !lines[0]) return items;

    // Detect header format (old 8-col or new 10-col)
    const headerLine = lines[0].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    const isNewFormat =
      headerLine.length === 10 && headerLine[7] === "source" && headerLine[8] === "target";

    // Column indices based on format
    const COL_TEXT_IDX = isNewFormat ? 6 : 6;
    const COL_SOURCE_IDX = isNewFormat ? 7 : -1;
    const COL_TARGET_IDX = isNewFormat ? 8 : -1;
    const COL_DIVERGENT_IDX = isNewFormat ? 9 : 7;

    // Group by key+index to handle multiple languages per entry
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

    // Skip header
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (!line) continue;

      const fields = this.parseCSVLine(line);
      const expectedCols = isNewFormat ? 10 : 8;
      if (fields.length < expectedCols) continue;

      const key = fields[0] ?? "";
      const id = fields[1] ?? "";
      const name = fields[2] ?? "";
      const indexStr = fields[3] ?? "0";
      const lang = (fields[4] ?? "").toLowerCase();
      const hash = fields[5] ?? "";
      const text = fields[COL_TEXT_IDX] ?? "";
      const source = isNewFormat ? (fields[COL_SOURCE_IDX] ?? "") : "";
      const target = isNewFormat ? (fields[COL_TARGET_IDX] ?? "") : "";
      const divergent = fields[COL_DIVERGENT_IDX] ?? "";
      const index = parseInt(indexStr, 10) || 0;

      if (!lang) continue;

      const groupKey = `${key}:${index}`;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          key,
          id,
          name,
          index,
          translations: new Map(),
        });
      }
      const group = grouped.get(groupKey)!;
      group.translations.set(lang, { text, hash, divergent: divergent === "true", source, target });
    }

    // Create items from grouped entries
    for (const group of grouped.values()) {
      const translations = group.translations;
      const src = translations.get("us")?.text ?? "";
      if (!src) continue; // Require English source

      // Store all translations in extra_field for reference
      const translationsObj: Record<
        string,
        { text: string; hash: string; divergent: boolean; source?: string; target?: string }
      > = {};
      for (const [lang, trans] of translations) {
        translationsObj[lang] = trans;
      }

      const extraField = {
        ffx_key: group.key,
        ffx_id: group.id,
        ffx_name: group.name,
        ffx_translations: translationsObj,
      };

      items.push(
        create_item({
          src,
          dst: "", // Empty dst - translation will fill this for project's target language
          row: group.index,
          file_type: FFX_CSV_TYPE as ItemFileType,
          file_path: rel_path,
          tag: group.key,
          extra_field: JsonTool.stringifyStrict(extraField),
          status: "NONE", // Always NONE to allow translation to project's target language
        }),
      );
    }
    return items;
  }

  /**
   * Parse CSV line handling quoted fields
   */
  private static parseCSVLine(line: string): string[] {
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (char === "," && !inQuotes) {
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
   * Read FFX XLSX format
   * Columns: key, id, name, index, lang, hash, text, source, target, divergent
   * Groups rows by key+index, uses 'us' as source, stores all translations in extra_field
   * Supports both old 8-col and new 10-col headers
   */
  private static async readFFXXLSX(content: Uint8Array, rel_path: string): Promise<Item[]> {
    const items: Item[] = [];
    const workbook = await read_workbook(content);
    const sheet = workbook.worksheets[0];
    if (!sheet) return items;

    // Check header
    const header: string[] = [];
    for (let col = 1; col <= FFX_XLSX_HEADER.length; col++) {
      const cellValue = sheet.getCell(1, col).value;
      header.push(cell_text(cellValue ?? ""));
    }

    // Detect format (old 8-col or new 10-col)
    const isNewFormat =
      header.length >= 10 &&
      header[7]?.toLowerCase() === "source" &&
      header[8]?.toLowerCase() === "target";
    const expectedCols = isNewFormat ? 10 : 8;

    if (
      !header
        .slice(0, expectedCols)
        .every((h, i) => h.toLowerCase() === FFX_XLSX_HEADER[i]?.toLowerCase())
    ) {
      return items; // Not FFX XLSX format
    }

    // Column indices based on format
    const COL_TEXT_IDX = isNewFormat ? COL_TEXT : COL_TEXT;
    const COL_SOURCE_IDX = isNewFormat ? COL_SOURCE : -1;
    const COL_TARGET_IDX = isNewFormat ? COL_TARGET : -1;
    const COL_DIVERGENT_IDX = isNewFormat ? COL_DIVERGENT : 7;

    // Group by key+index to handle multiple languages per entry
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

    for (let row = 2; row <= sheet.rowCount; row++) {
      const key = cell_text(sheet.getCell(row, COL_KEY + 1).value ?? "");
      if (!key) continue;

      const id = cell_text(sheet.getCell(row, COL_ID + 1).value ?? "");
      const name = cell_text(sheet.getCell(row, COL_NAME + 1).value ?? "");
      const indexStr = cell_text(sheet.getCell(row, COL_INDEX + 1).value ?? "");
      const lang = cell_text(sheet.getCell(row, COL_LANG + 1).value ?? "").toLowerCase();
      const hash = cell_text(sheet.getCell(row, COL_HASH + 1).value ?? "");
      const text = cell_text(sheet.getCell(row, COL_TEXT_IDX + 1).value ?? "");
      const source = isNewFormat
        ? cell_text(sheet.getCell(row, COL_SOURCE_IDX + 1).value ?? "")
        : "";
      const target = isNewFormat
        ? cell_text(sheet.getCell(row, COL_TARGET_IDX + 1).value ?? "")
        : "";
      const divergent = cell_text(sheet.getCell(row, COL_DIVERGENT_IDX + 1).value ?? "");

      if (!lang) continue;

      const index = parseInt(indexStr, 10) || 0;
      const groupKey = `${key}:${index}`;

      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          key,
          id,
          name,
          index,
          translations: new Map(),
        });
      }
      const group = grouped.get(groupKey)!;
      group.translations.set(lang, { text, hash, divergent: divergent === "true", source, target });
    }

    // Create items from grouped entries
    for (const group of grouped.values()) {
      const translations = group.translations;
      const src = translations.get("us")?.text ?? "";
      if (!src) continue; // Require English source

      // Store all translations in extra_field for reference
      const translationsObj: Record<
        string,
        { text: string; hash: string; divergent: boolean; source?: string; target?: string }
      > = {};
      for (const [lang, trans] of translations) {
        translationsObj[lang] = trans;
      }

      const extraField = {
        ffx_key: group.key,
        ffx_id: group.id,
        ffx_name: group.name,
        ffx_translations: translationsObj,
      };

      items.push(
        create_item({
          src,
          dst: "", // Empty dst - translation will fill this for project's target language
          row: group.index,
          file_type: FFX_XLSX_TYPE as ItemFileType,
          file_path: rel_path,
          tag: group.key,
          extra_field: JsonTool.stringifyStrict(extraField),
          status: "NONE", // Always NONE to allow translation to project's target language
        }),
      );
    }
    return items;
  }

  /**
   * Read FFX Strings format
   * Format:
   *   (comment)key=ffx/battle/btl/bika00_10/bika00_10.bin row_count=5(comment)
   *   bika00_10:0:ch<delimiter>$860c5395b0614e48 = {PC:00:TIDUS}{TEXT_NEWLINE}text
   * Each line: fileKey:rowIndex:lang<delimiter>$hash = text[<delimiter>source = sourceText][<delimiter>target = targetText]
   * 'us' is the source language, other languages are translations
   * Supports source/target projection in new format
   */
  private static readFFXStrings(text: string, rel_path: string): Item[] {
    const items: Item[] = [];
    const lines = text.split(/\r?\n/);

    // Map to group by fileKey and rowIndex
    // structure: fileKey -> rowIndex -> { src, translations: Map<lang, {text, hash, source, target}>, metadata }
    const entries = new Map<
      string,
      Map<
        number,
        {
          src: string;
          translations: Map<
            string,
            { text: string; hash: string; source?: string; target?: string }
          >;
          metadata: { key?: string; rowCount?: number };
        }
      >
    >();

    let fileMetadata: { key?: string; rowCount?: number } = {};

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Parse metadata comment line
      if (trimmed.startsWith("/*key=") && trimmed.endsWith("*/")) {
        const content = trimmed.slice(2, -2); // Remove /* and */
        const keyMatch = content.match(/key=([^\s]+)/);
        const rowCountMatch = content.match(/row_count=(\d+)/);
        if (keyMatch && keyMatch[1]) fileMetadata.key = keyMatch[1];
        if (rowCountMatch && rowCountMatch[1])
          fileMetadata.rowCount = parseInt(rowCountMatch[1], 10);
        continue;
      }

      // Parse data line: fileKey:rowIndex:lang<delimiter>$hash = text[<delimiter>source = ...][<delimiter>target = ...]
      const eqIndex = trimmed.indexOf(" = ");
      if (eqIndex === -1) continue;

      const leftPart = trimmed.slice(0, eqIndex).trim();
      const rightPart = trimmed.slice(eqIndex + 3); // Skip " = "

      // Parse leftPart: fileKey:rowIndex:lang<delimiter>$hash
      const hashIndex = leftPart.indexOf(STRINGS_DELIMITER);
      if (hashIndex === -1) continue;

      const keyPart = leftPart.slice(0, hashIndex);
      const hashWithPrefix = leftPart.slice(hashIndex + 1);
      const hash = hashWithPrefix.startsWith("$") ? hashWithPrefix.slice(1) : hashWithPrefix;

      // keyPart is fileKey:rowIndex:lang
      const parts = keyPart.split(":");
      if (parts.length !== 3) continue;

      const fileKey = parts[0];
      const rowIndexStr = parts[1];
      const lang = parts[2];
      if (!fileKey || !rowIndexStr || !lang) continue;
      const rowIndex = parseInt(rowIndexStr, 10);
      if (isNaN(rowIndex)) continue;

      // Parse rightPart for source/target projection
      // Format: text[<delimiter>source = sourceText][<delimiter>target = targetText]
      let textValue = rightPart;
      let source = "";
      let target = "";

      // Check for source/target projection
      const sourceMarker = `${STRINGS_DELIMITER}source = `;
      const targetMarker = `${STRINGS_DELIMITER}target = `;

      const sourceIdx = textValue.indexOf(sourceMarker);
      if (sourceIdx >= 0) {
        textValue = textValue.slice(0, sourceIdx);
        const afterSource = rightPart.slice(sourceIdx + sourceMarker.length);
        const targetIdx = afterSource.indexOf(targetMarker);
        if (targetIdx >= 0) {
          source = afterSource.slice(0, targetIdx);
          target = afterSource.slice(targetIdx + targetMarker.length);
        } else {
          source = afterSource;
        }
      } else {
        const targetIdx = textValue.indexOf(targetMarker);
        if (targetIdx >= 0) {
          textValue = textValue.slice(0, targetIdx);
          target = textValue.slice(targetIdx + targetMarker.length);
        }
      }

      // Get or create entry
      if (!entries.has(fileKey)) {
        entries.set(fileKey, new Map());
      }
      const fileEntries = entries.get(fileKey)!;

      if (!fileEntries.has(rowIndex)) {
        fileEntries.set(rowIndex, { src: "", translations: new Map(), metadata: fileMetadata });
      }
      const entry = fileEntries.get(rowIndex)!;

      // Store translation
      entry.translations.set(lang, { text: textValue, hash, source, target });

      // If this is 'us' (English), set as source
      if (lang === "us") {
        entry.src = textValue;
      }
    }

    // Now create items from grouped entries
    for (const [fileKey, fileEntries] of entries) {
      for (const [rowIndex, entry] of fileEntries) {
        if (!entry.src) {
          // No 'us' source - skip or use first available
          const firstTranslation = entry.translations.values().next().value;
          if (!firstTranslation) continue;
          entry.src = firstTranslation.text;
        }

        // Build extra_field with all translations and metadata
        const translationsObj: Record<
          string,
          { text: string; hash: string; source?: string; target?: string }
        > = {};
        for (const [lang, trans] of entry.translations) {
          translationsObj[lang] = trans;
        }

        const extraField = {
          ffx_key: fileKey,
          ffx_metadata: entry.metadata,
          ffx_translations: translationsObj,
          ffx_divergent: false, // Strings format doesn't have divergent field
        };

        items.push(
          create_item({
            src: entry.src,
            dst: "", // Empty dst - translation will fill this for project's target language
            row: rowIndex,
            file_type: FFX_STRINGS_TYPE as ItemFileType,
            file_path: rel_path,
            tag: fileKey,
            extra_field: JsonTool.stringifyStrict(extraField),
            status: "NONE", // Always NONE to allow translation to project's target language; existing translations preserved in extra_field
          }),
        );
      }
    }

    return items;
  }

  /**
   * Main entry point: detect format and parse
   */
  public async read_from_stream(
    content: Uint8Array,
    rel_path: string,
  ): Promise<{ items: Item[]; file_type: ItemFileType }> {
    const text = await decode_text_content(content);
    const ext = path.extname(rel_path).toLowerCase();

    // Try PO: extension picks the parser, content must carry gettext msgid/msgstr.
    if (ext === ".po") {
      if (!is_po_document(text)) {
        throw new Error(`FFX PO format requires msgid/msgstr entries in file: ${rel_path}`);
      }
      return {
        items: read_po_items(text, rel_path),
        file_type: FFX_PO_TYPE as ItemFileType,
      };
    }

    // Try JSON first
    if (ext === ".json") {
      try {
        const data = JsonTool.parseStrict(text);
        if (FFXFormat.isFFXJSON(data)) {
          return {
            items: FFXFormat.readFFXJSON(data, rel_path),
            file_type: FFX_JSON_TYPE as ItemFileType,
          };
        }
      } catch {
        // Not valid JSON or not FFX JSON
      }
    }

    // Try CSV
    if (ext === ".csv" || FFXFormat.isFFXCSV(text)) {
      return {
        items: FFXFormat.readFFXCSV(text, rel_path),
        file_type: FFX_CSV_TYPE as ItemFileType,
      };
    }

    // Try Strings
    if (ext === ".strings" || FFXFormat.isFFXStrings(text)) {
      return {
        items: FFXFormat.readFFXStrings(text, rel_path),
        file_type: FFX_STRINGS_TYPE as ItemFileType,
      };
    }

    // Try XLSX
    if (ext === ".xlsx") {
      try {
        const items = await FFXFormat.readFFXXLSX(content, rel_path);
        if (items.length > 0) {
          return { items, file_type: FFX_XLSX_TYPE as ItemFileType };
        }
      } catch {
        // Not valid XLSX or not FFX format
      }
    }

    return { items: [], file_type: "NONE" };
  }

  /**
   * Write items back to FFX formats
   */
  public async write_to_path(
    items: Item[],
    paths: GeneratedFilePaths,
    asset_reader: (path: string) => Buffer | null | Promise<Buffer | null>,
  ): Promise<void> {
    // Group by file type
    for (const type of [
      FFX_JSON_TYPE,
      FFX_CSV_TYPE,
      FFX_XLSX_TYPE,
      FFX_STRINGS_TYPE,
      FFX_PO_TYPE,
    ] as const) {
      for (const [rel_path, group] of group_items(items, type as ItemFileType)) {
        const original = await asset_reader(rel_path);
        if (original === null) continue;

        const originalText = await decode_text_content(original);

        switch (type) {
          case FFX_JSON_TYPE:
            await this.writeFFXJSON(group, rel_path, paths, originalText);
            break;
          case FFX_CSV_TYPE:
            await this.writeFFXCSV(group, rel_path, paths);
            break;
          case FFX_XLSX_TYPE:
            await this.writeFFXXLSX(group, rel_path, paths, original);
            break;
          case FFX_STRINGS_TYPE:
            await this.writeFFXStrings(group, rel_path, paths);
            break;
          case FFX_PO_TYPE:
            await this.writeFFXPO(group, rel_path, paths);
            break;
        }
      }
    }
  }

  private async writeFFXJSON(
    items: Item[],
    rel_path: string,
    paths: GeneratedFilePaths,
    originalText: string,
  ): Promise<void> {
    const originalData = JsonTool.parseStrict(originalText) as Record<string, unknown>;

    // Update translations in the original structure
    for (const item of items) {
      const fileKey = item.tag;
      const entry = originalData[fileKey] as { rows?: unknown[] };
      if (!entry || !entry.rows) continue;

      const translation = read_translation_for_generation(item);
      if (translation === undefined) continue;

      const extraFieldRaw = item.extra_field;
      const extraField = JsonTool.parseStrict(
        typeof extraFieldRaw === "string" ? extraFieldRaw : "{}",
      ) as {
        ffx_name?: string;
        ffx_hash?: string;
        ffx_translations?: Record<
          string,
          { text: string; hash: string; source?: string; target?: string }
        >;
      };
      const name = extraField.ffx_name ?? "";
      const translations = extraField.ffx_translations ?? {};
      const usTrans = translations["us"] ?? { text: "", hash: "" };
      const source = usTrans.text ?? "";
      const target = translations["pt"]?.text ?? translation;

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
          // Update target language (pt) translation
          r.text["pt"] = translation;
          // Update hash with $ prefix
          if (!r.hash) r.hash = {};
          r.hash["pt"] = this.addHashPrefix(extraField.ffx_hash ?? usTrans.hash ?? "");
          // Update source and target projection
          r.source = source;
          r.target = target;
          break;
        }
      }
    }

    await write_text_file(
      `${paths.translated_path}/${rel_path}`,
      JsonTool.stringifyStrict(originalData, { indent: 2 }),
    );
  }

  private async writeFFXCSV(
    items: Item[],
    rel_path: string,
    paths: GeneratedFilePaths,
  ): Promise<void> {
    const lines: string[] = [FFX_CSV_HEADER.join(",")];

    for (const item of items) {
      const translation = read_translation_for_generation(item);
      if (translation === undefined) continue;

      const extraFieldRaw = item.extra_field;
      const extraField = JsonTool.parseStrict(
        typeof extraFieldRaw === "string" ? extraFieldRaw : "{}",
      ) as {
        ffx_key?: string;
        ffx_id?: string;
        ffx_name?: string;
        ffx_hash?: string;
        ffx_divergent?: boolean;
        ffx_translations?: Record<
          string,
          { text: string; hash: string; source?: string; target?: string }
        >;
      };

      // Get source/target from extra_field if available
      const translations = extraField.ffx_translations ?? {};
      const usTrans = translations["us"] ?? { text: "", hash: "" };
      const source = usTrans.text ?? "";
      const target = translations["pt"]?.text ?? translation;

      const record = [
        this.escapeCSV(extraField.ffx_key ?? item.tag),
        this.escapeCSV(extraField.ffx_id ?? ""),
        this.escapeCSV(extraField.ffx_name ?? ""),
        item.row.toString(),
        this.escapeCSV("pt"), // target language
        this.escapeCSV(this.addHashPrefix(extraField.ffx_hash ?? usTrans.hash ?? "")), // hash with $ prefix
        this.escapeCSV(translation),
        this.escapeCSV(source),
        this.escapeCSV(target),
        this.escapeCSV(extraField.ffx_divergent ? "true" : "false"),
      ];
      lines.push(record.join(","));
    }

    await write_text_file(`${paths.translated_path}/${rel_path}`, lines.join("\n"));
  }

  /**
   * Ensure hash has $ prefix (artifact format)
   */
  private addHashPrefix(hash: string): string {
    if (!hash) return "";
    return hash.startsWith("$") ? hash : `$${hash}`;
  }

  /**
   * CSV 没有单元格类型，Excel 导入时会按内容重新解释字段；FFX 产物同时供外部工具消费，
   * 改写以 `=` 开头的值会破坏原稿，因此这里只做 RFC 4180 引号并保持字段原值。
   */
  private escapeCSV(field: string): string {
    if (field.includes(",") || field.includes('"') || field.includes("\n")) {
      return '"' + field.replace(/"/g, '""') + '"';
    }
    return field;
  }

  private async writeFFXXLSX(
    items: Item[],
    rel_path: string,
    paths: GeneratedFilePaths,
    original: Buffer,
  ): Promise<void> {
    const workbook = await read_workbook(new Uint8Array(original));
    const sheet = workbook.worksheets[0];
    if (!sheet) return;

    for (const item of items) {
      const translation = read_translation_for_generation(item);
      if (translation === undefined) continue;

      const extraFieldRaw = item.extra_field;
      const extraField = JsonTool.parseStrict(
        typeof extraFieldRaw === "string" ? extraFieldRaw : "{}",
      ) as {
        ffx_name?: string;
        ffx_hash?: string;
        ffx_divergent?: boolean;
        ffx_translations?: Record<string, { text: string; hash: string }>;
      };
      const name = extraField.ffx_name ?? "";
      const translations = extraField.ffx_translations ?? {};
      const usTrans = translations["us"] ?? { text: "", hash: "" };
      const source = usTrans.text ?? "";
      const target = translations["pt"]?.text ?? translation;

      // Find the row in the sheet
      for (let row = 2; row <= sheet.rowCount; row++) {
        const rowName = cell_text(sheet.getCell(row, COL_NAME + 1).value ?? "");
        const rowIndex =
          parseInt(cell_text(sheet.getCell(row, COL_INDEX + 1).value ?? ""), 10) || 0;
        if (rowIndex === item.row && rowName === name) {
          write_cell(sheet, row, COL_TEXT + 1, translation);
          // Write hash with $ prefix
          const hashWithPrefix = this.addHashPrefix(extraField.ffx_hash ?? usTrans.hash ?? "");
          write_cell(sheet, row, COL_HASH + 1, hashWithPrefix);
          // Write source and target columns
          write_cell(sheet, row, COL_SOURCE + 1, source);
          write_cell(sheet, row, COL_TARGET + 1, target);
          break;
        }
      }
    }

    await write_binary_file(
      path.join(paths.translated_path, rel_path),
      await workbook.xlsx.writeBuffer(),
    );
  }

  private async writeFFXStrings(
    items: Item[],
    rel_path: string,
    paths: GeneratedFilePaths,
  ): Promise<void> {
    const lines: string[] = [];

    // Group by fileKey to write metadata comment
    const byFileKey = new Map<string, Item[]>();
    for (const item of items) {
      const key = item.tag;
      if (!byFileKey.has(key)) {
        byFileKey.set(key, []);
      }
      byFileKey.get(key)!.push(item);
    }

    // Write metadata comment for each fileKey (use first item's metadata)
    for (const [, fileItems] of byFileKey) {
      const firstItem = fileItems[0]!;
      const extraFieldRaw = firstItem.extra_field;
      const extraField = JsonTool.parseStrict(
        typeof extraFieldRaw === "string" ? extraFieldRaw : "{}",
      ) as {
        ffx_metadata?: { key?: string; rowCount?: number };
      };
      const metadata = extraField.ffx_metadata ?? {};
      const keyPath = metadata.key ?? rel_path;
      const rowCount = metadata.rowCount ?? fileItems.length;
      lines.push(`/*key=${keyPath} row_count=${rowCount}*/`);
    }

    // Write translation lines
    for (const item of items) {
      const translation = read_translation_for_generation(item);
      if (translation === undefined) continue;

      const extraFieldRaw = item.extra_field;
      const extraField = JsonTool.parseStrict(
        typeof extraFieldRaw === "string" ? extraFieldRaw : "{}",
      ) as {
        ffx_translations?: Record<
          string,
          { text: string; hash: string; source?: string; target?: string }
        >;
      };
      const translations = extraField.ffx_translations ?? {};

      // Escape value for strings format (escape backslash, CR, LF, and ║)
      const escapeValue = (s: string): string => {
        return s
          .replace(/\\/g, "\\\\")
          .replace(/\r/g, "\\r")
          .replace(/\n/g, "\\n")
          .replace(/║/g, "\\║");
      };

      // Write source language (us) line if we have it
      if (translations["us"]) {
        const usTrans = translations["us"];
        const hashWithPrefix = this.addHashPrefix(usTrans.hash);
        const source = escapeValue(usTrans.source ?? usTrans.text);
        const target = escapeValue(usTrans.target ?? "");
        let line = `${item.tag}:${item.row}:us${STRINGS_DELIMITER}${hashWithPrefix} = ${escapeValue(translation)}`;
        if (source) {
          line += `${STRINGS_DELIMITER}source = ${source}`;
        }
        if (target) {
          line += `${STRINGS_DELIMITER}target = ${target}`;
        }
        lines.push(line);
      }

      // Write target language (pt) line
      // We'll use a placeholder hash for the new translation
      const targetHash = translations["pt"]?.hash ?? `$${Math.random().toString(16).slice(2, 18)}`;
      const source = escapeValue(translations["us"]?.text ?? "");
      const target = escapeValue(translation);
      let line = `${item.tag}:${item.row}:pt${STRINGS_DELIMITER}${targetHash} = ${escapeValue(translation)}`;
      if (source) {
        line += `${STRINGS_DELIMITER}source = ${source}`;
      }
      if (target) {
        line += `${STRINGS_DELIMITER}target = ${target}`;
      }
      lines.push(line);
    }

    await write_text_file(`${paths.translated_path}/${rel_path}`, lines.join("\n"));
  }

  private async writeFFXPO(
    items: Item[],
    rel_path: string,
    paths: GeneratedFilePaths,
  ): Promise<void> {
    await write_text_file(
      `${paths.translated_path}/${rel_path}`,
      render_po(items, this.target_language),
    );
  }
}
