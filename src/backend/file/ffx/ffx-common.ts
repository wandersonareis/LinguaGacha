import { JsonTool } from "../../../shared/utils/json-tool";

// Idiomas de linha dos artefatos FFX Resources.
export const FFX_LANGUAGES = ["us", "ch", "de", "fr", "it", "jp", "kr", "sp", "pt"] as const;

// Idioma fonte dos artefatos FFX (inglês).
export const FFX_SOURCE_LANG = "us";

// Idioma da coluna/linha de tradução em JSON/CSV/XLSX.
export const FFX_TARGET_LANG = "pt";

/** Texto de um idioma no extra_field dos formatos JSON/CSV/XLSX. */
export type FfxTranslation = {
  text: string;
  hash: string;
  divergent?: boolean;
  source?: string;
  target?: string;
};

/** Campos compartilhados do extra_field dos formatos JSON/CSV/XLSX. */
export type FfxExtra = {
  ffx_key?: string;
  ffx_id?: string;
  ffx_name?: string;
  ffx_hash?: string;
  ffx_divergent?: boolean;
  ffx_translations?: Record<string, FfxTranslation | undefined>;
};

/** Lê o extra_field do item; ausência de valor vira objeto vazio. */
export function read_ffx_extra(value: unknown): FfxExtra {
  if (typeof value !== "string" || value === "") return {};
  return JsonTool.parseStrict(value) as FfxExtra;
}

/** Garante o prefixo `$` do hash no artefato. */
export function add_hash_prefix(hash: string): string {
  if (hash === "") return "";
  return hash.startsWith("$") ? hash : `$${hash}`;
}
