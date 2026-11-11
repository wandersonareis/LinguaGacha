import { create_item, type Item, type ItemFileType } from "../../../domain/item";
import { JsonTool } from "../../../shared/utils/json-tool";

/** Formato Strings (java-like) do FFX Resources; v1/v2 compartilham a linha. */
export const FFX_STRINGS_FILE_TYPE = "FFX_STRINGS" satisfies ItemFileType;

// U+2551 BOX DRAWINGS DOUBLE VERTICAL: liga a chave ao hash de identidade.
export const STRINGS_DELIMITER = "║";

// Separa o hash de identidade do valor da linha.
export const STRINGS_SEPARATOR = " = ";

// Projeções v1: source/target moram na própria linha do idioma fonte.
export const STRINGS_SOURCE_MARK = `${STRINGS_DELIMITER}source = `;
export const STRINGS_TARGET_MARK = `${STRINGS_DELIMITER}target = `;

/** Metadados de um bloco; version/source/target só existem no v2. */
export type StringsMetadata = {
  key?: string;
  rowCount?: number;
  version?: number;
  source?: string;
  target?: string;
};

/** Texto de um idioma da row; source/target são as projeções v1. */
export type StringsTranslation = {
  text: string;
  hash: string;
  source?: string;
  target?: string;
};

/** Dados privados que o formato Strings guarda no extra_field do item. */
export type StringsExtra = {
  ffx_key?: string;
  ffx_name?: string;
  ffx_metadata?: StringsMetadata;
  ffx_translations?: Record<string, StringsTranslation | undefined>;
  ffx_divergent?: boolean;
};

/** Uma row do arquivo: identidade (id/name/index) e linhas por idioma. */
export type StringsRow = {
  id: string;
  name: string;
  index: number;
  translations: Map<string, StringsTranslation>;
};

/** Bloco contíguo de linhas sob um mesmo header. */
export type StringsBlock = {
  metadata: StringsMetadata;
  rows: Map<string, StringsRow>;
};

/** Uma row pronta para serialização, independente da versão. */
export type StringsWriteRow = {
  id: string;
  name: string;
  index: number;
  src: string;
  extra: StringsExtra;
  translation: string | undefined;
};

/** Bloco pronto para serialização; a versão vem da metadata do header. */
export type StringsWriteBlock = {
  key: string;
  metadata: StringsMetadata;
  rows: StringsWriteRow[];
};

type StringsLine = {
  id: string;
  name: string;
  index: number;
  lang: string;
  hash: string;
  value: string;
  ref: boolean;
  source: string;
  target: string;
};

/** Reconhece o formato pela presença de um header ou de uma linha de dados. */
export function is_ffx_strings(text: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("/*key=") && trimmed.includes("row_count=")) return true;
    if (trimmed.includes(STRINGS_DELIMITER) && trimmed.includes(STRINGS_SEPARATOR)) return true;
  }
  return false;
}

/**
 * Separa o arquivo em blocos contíguos e resolve as refs `$hash` pela tabela
 * global do arquivo (a def pode estar em outro bloco). As linhas de idioma
 * são coletadas por (id, name, index), como o parser do ff-resources.
 */
export function scan_strings_blocks(text: string): StringsBlock[] {
  const blocks: StringsBlock[] = [];
  const table = new Map<string, string>();
  const refs: Array<{
    row: StringsRow;
    lang: string;
    hash: string;
    source: string;
    target: string;
  }> = [];
  let metadata: StringsMetadata = {};
  let current: StringsBlock | undefined;

  const ensure_block = (): StringsBlock => {
    if (current === undefined) {
      current = { metadata, rows: new Map() };
      blocks.push(current);
    }
    return current;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("/*key=") && line.endsWith("*/")) {
      metadata = read_strings_metadata(line);
      current = { metadata, rows: new Map() };
      blocks.push(current);
      continue;
    }

    // A linha de conteúdo é parseada sem trim: espaços nas pontas do valor
    // fazem parte do texto (o formato os preserva).
    const parsed = parse_strings_line(rawLine);
    if (parsed === null) continue;

    const block = ensure_block();
    const rowKey = `${parsed.id}\u0000${parsed.name}\u0000${parsed.index}`;
    let row = block.rows.get(rowKey);
    if (row === undefined) {
      row = {
        id: parsed.id,
        name: parsed.name,
        index: parsed.index,
        translations: new Map(),
      };
      block.rows.set(rowKey, row);
    }

    if (parsed.ref) {
      refs.push({
        row,
        lang: parsed.lang,
        hash: parsed.hash,
        source: parsed.source,
        target: parsed.target,
      });
      continue;
    }

    if (!table.has(parsed.hash)) table.set(parsed.hash, parsed.value);
    row.translations.set(
      parsed.lang,
      create_translation(parsed.value, parsed.hash, parsed.source, parsed.target),
    );
  }

  for (const ref of refs) {
    const resolved = table.get(ref.hash) ?? `$${ref.hash}`;
    ref.row.translations.set(
      ref.lang,
      create_translation(resolved, ref.hash, ref.source, ref.target),
    );
  }

  return blocks;
}

/** Monta o item de um row já interpretado pela versão do bloco. */
export function create_strings_item(
  row: StringsRow,
  metadata: StringsMetadata,
  src: string,
  rel_path: string,
): Item {
  const translations: Record<string, StringsTranslation> = {};
  for (const [lang, translation] of row.translations) translations[lang] = translation;

  const extra: StringsExtra = {
    ffx_key: row.id,
    ...(row.name === "" ? {} : { ffx_name: row.name }),
    ffx_metadata: metadata,
    ffx_translations: translations,
    ffx_divergent: false,
  };

  return create_item({
    src,
    dst: "", // A tradução existente fica em extra_field até o item ser processado.
    row: row.index,
    file_type: FFX_STRINGS_FILE_TYPE,
    file_path: rel_path,
    tag: row.id,
    extra_field: JsonTool.stringifyStrict(extra),
    status: "NONE",
  });
}

/** Lê o extra_field do formato; legado inválido vira objeto vazio. */
export function read_strings_extra(value: unknown): StringsExtra {
  if (typeof value !== "string" || value === "") return {};
  try {
    const parsed: unknown = JsonTool.parseStrict(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as StringsExtra;
  } catch {
    // extra_field corrompido não impede reescrever as linhas conhecidas do item.
    return {};
  }
}

/** Primeiro valor não vazio, na ordem de preferência informada. */
export function first_non_empty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value !== undefined && value !== "") return value;
  }
  return "";
}

/** Escapa o valor para uma linha, preservando a gramática do formato. */
export function escape_strings_value(value: string): string {
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .replace(/║/gu, "\\║");
}

/** Hash de identidade estável para linhas sem hash (o import usa o texto). */
export function strings_checksum(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const char of text) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Garante o prefixo `$` do hash no artefato. */
export function add_strings_hash_prefix(hash: string): string {
  return hash.startsWith("$") ? hash : `$${hash}`;
}

function create_translation(
  text: string,
  hash: string,
  source: string,
  target: string,
): StringsTranslation {
  return {
    text,
    hash,
    ...(source === "" ? {} : { source }),
    ...(target === "" ? {} : { target }),
  };
}

/** Lê os campos do header do bloco. Campos futuros são ignorados. */
function read_strings_metadata(line: string): StringsMetadata {
  const content = line.slice(2, -2); // Remove os delimitadores do comentário.
  const metadata: StringsMetadata = {};
  const key = /\bkey=(\S+)/u.exec(content)?.[1];
  if (key !== undefined) metadata.key = key;
  const rowCount = /\brow_count=(\d+)/u.exec(content)?.[1];
  if (rowCount !== undefined) metadata.rowCount = Number.parseInt(rowCount, 10);
  const version = /\bversion=(\d+)/u.exec(content)?.[1];
  if (version !== undefined) metadata.version = Number.parseInt(version, 10);
  const source = /\bsource=(\S+)/u.exec(content)?.[1];
  if (source !== undefined) metadata.source = source;
  const target = /\btarget=(\S+)/u.exec(content)?.[1];
  if (target !== undefined) metadata.target = target;
  return metadata;
}

/**
 * Decompõe uma linha com âncora à direita: último campo = lang,
 * penúltimo = index, prefixo = id ou id:name. Campos futuros crescem pela
 * esquerda, como no ff-resources.
 */
function parse_strings_line(line: string): StringsLine | null {
  const separatorIndex = line.indexOf(STRINGS_SEPARATOR);
  if (separatorIndex < 0) return null;
  const left = line.slice(0, separatorIndex);
  const rawValue = line.slice(separatorIndex + STRINGS_SEPARATOR.length);

  const hashIndex = left.indexOf(STRINGS_DELIMITER);
  if (hashIndex < 0) return null;
  const keyPart = left.slice(0, hashIndex);
  const rawHash = left.slice(hashIndex + STRINGS_DELIMITER.length).trim();
  const hash = rawHash.startsWith("$") ? rawHash.slice(1) : rawHash;
  if (hash === "") return null;

  const fields = keyPart.split(":");
  if (fields.length < 3) return null;
  const lang = fields[fields.length - 1] ?? "";
  const indexText = fields[fields.length - 2] ?? "";
  if (!/^\d+$/u.test(indexText)) return null;
  const index = Number.parseInt(indexText, 10);
  if (lang === "" || !Number.isSafeInteger(index)) return null;

  const leftFields = fields.slice(0, -2);
  if (leftFields.length === 0) return null;
  // Com nome: id:name:index:lang. Sem nome: id:index:lang.
  const name = leftFields.length > 1 ? (leftFields[leftFields.length - 1] ?? "") : "";
  const id =
    leftFields.length > 1 ? (leftFields[leftFields.length - 2] ?? "") : (leftFields[0] ?? "");
  if (id === "") return null;

  const projection = split_strings_projection(rawValue);
  const refHash = projection.value.startsWith("$") ? projection.value.slice(1) : "";
  const ref = refHash === hash;
  return {
    id,
    name,
    index,
    lang,
    hash,
    value: ref ? "" : unescape_strings_value(projection.value),
    ref,
    source: projection.source,
    target: projection.target,
  };
}

/** Desfaz o escape do valor: `\\`, `\r`, `\n` e `\║`. */
function unescape_strings_value(value: string): string {
  const out: string[] = [];
  let escaped = false;
  for (const char of value) {
    if (escaped) {
      switch (char) {
        case "n":
          out.push("\n");
          break;
        case "r":
          out.push("\r");
          break;
        case "\\":
          out.push("\\");
          break;
        case STRINGS_DELIMITER:
          out.push(STRINGS_DELIMITER);
          break;
        default:
          out.push("\\", char);
          break;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    out.push(char);
  }
  if (escaped) out.push("\\");
  return out.join("");
}

/** Separa as projeções v1 (`║source = …`, `║target = …`) do valor literal. */
function split_strings_projection(raw: string): { value: string; source: string; target: string } {
  const sourceIndex = index_unescaped(raw, STRINGS_SOURCE_MARK);
  if (sourceIndex >= 0) {
    const value = raw.slice(0, sourceIndex);
    const rest = raw.slice(sourceIndex + STRINGS_SOURCE_MARK.length);
    const targetIndex = index_unescaped(rest, STRINGS_TARGET_MARK);
    if (targetIndex >= 0) {
      return {
        value,
        source: unescape_strings_value(rest.slice(0, targetIndex)),
        target: unescape_strings_value(rest.slice(targetIndex + STRINGS_TARGET_MARK.length)),
      };
    }
    return { value, source: unescape_strings_value(rest), target: "" };
  }
  const targetIndex = index_unescaped(raw, STRINGS_TARGET_MARK);
  if (targetIndex >= 0) {
    return {
      value: raw.slice(0, targetIndex),
      source: "",
      target: unescape_strings_value(raw.slice(targetIndex + STRINGS_TARGET_MARK.length)),
    };
  }
  return { value: raw, source: "", target: "" };
}

/** Índice do marcador que não está escapado (nº par de backslashes antes). */
function index_unescaped(text: string, marker: string): number {
  let from = 0;
  while (from <= text.length) {
    const found = text.indexOf(marker, from);
    if (found < 0) return -1;
    let backslashes = 0;
    for (let index = found - 1; index >= 0 && text[index] === "\\"; index -= 1) backslashes += 1;
    if (backslashes % 2 === 0) return found;
    from = found + marker.length;
  }
  return -1;
}
