import {
  classify_target_language_grapheme,
  is_cjk_language_code,
  normalize_language_code,
  type TargetLanguageCode,
} from "../../domain/language";
import { check_similarity_by_jaccard } from "../utils/text-tool";

const TRANSLATION_SIMILARITY_THRESHOLD = 0.8; // 相似度阈值只服务校对页质量 warning

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const SHORT_ASCII_UPPERCASE_LATIN_PATTERN = /^[A-Z]{2,4}$/;

/**
 * 外文残留按连续字素聚合；孤立 Latin 字素及短大写片段证据不足，其它片段继续报告。
 */
export function collect_foreign_residue_fragments(args: {
  text: string;
  targetLanguage: TargetLanguageCode;
}): string[] {
  const fragments: string[] = [];
  let current_fragment = "";
  let current_grapheme_count = 0; // 附标与基字符属于同一字素，不能按字符串长度计数。
  let current_has_other_residue = false; // 含其它书写系统的片段即使只有一个字素也要报告。

  // 片段结束时就地判断证据强度，不让过滤规则泄漏到调用方。
  const flush_current_fragment = (): void => {
    const is_exempt_latin_fragment =
      !current_has_other_residue &&
      (current_grapheme_count === 1 || SHORT_ASCII_UPPERCASE_LATIN_PATTERN.test(current_fragment));

    if (current_fragment !== "" && !is_exempt_latin_fragment) {
      fragments.push(current_fragment);
    }
    current_fragment = "";
    current_grapheme_count = 0;
    current_has_other_residue = false;
  };

  for (const { segment } of GRAPHEME_SEGMENTER.segment(args.text)) {
    const classification = classify_target_language_grapheme(segment, args.targetLanguage);
    if (classification === "latin-residue" || classification === "other-residue") {
      current_fragment += segment;
      current_grapheme_count += 1;
      current_has_other_residue ||= classification === "other-residue";
      continue;
    }

    flush_current_fragment();
  }

  flush_current_fragment();

  return [...new Set(fragments)];
}

/**
 * 文本相似先走包含关系快判，再使用字符集合 Jaccard，保持历史轻量质量检查口径。
 * 保护段在 `unpreserved_text` 中被替换为空白，标点也不承载翻译证据；先去掉空白和标点，
 * 避免标签数量多的短句仅靠这些字符就被判为高度相似。
 */
export function is_translation_text_similar(left: string, right: string): boolean {
  const left_text = normalize_similarity_text(left);
  const right_text = normalize_similarity_text(right);
  if (left_text === "" || right_text === "") {
    return false;
  }

  return (
    left_text.includes(right_text) ||
    right_text.includes(left_text) ||
    check_similarity_by_jaccard(left_text, right_text) > TRANSLATION_SIMILARITY_THRESHOLD
  );
}

/** 相似度只比较可见正文；保护段占位空白和标点不参与字符集合。 */
function normalize_similarity_text(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, "");
}

/**
 * 非 CJK 目标按词集合比较，避免短句中的同源词、保留术语和少量共同字母
 * 仅凭字符集合就被判为高度相似。CJK 与泰文没有稳定空格分词，沿用字符集合口径。
 */
export function is_translation_text_similar_for_target(args: {
  src: string;
  dst: string;
  targetLanguage: TargetLanguageCode;
}): boolean {
  const target_language = normalize_language_code(args.targetLanguage);
  if (
    target_language !== null &&
    (is_cjk_language_code(target_language) || target_language === "TH")
  ) {
    return is_translation_text_similar(args.src, args.dst);
  }
  const left_words = collect_similarity_words(args.src);
  const right_words = collect_similarity_words(args.dst);
  const union = new Set([...left_words, ...right_words]).size;
  if (union === 0) return false;
  let intersection = 0;
  for (const word of left_words) {
    if (right_words.has(word)) intersection += 1;
  }
  return intersection / union > TRANSLATION_SIMILARITY_THRESHOLD;
}

/** 相似度词集合只保留字母开头的词，标点和保护段占位不进入集合。 */
function collect_similarity_words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*/gu) ?? []);
}

/**
 * 相似度 issue 是独立质量裁决；日/韩译中文时沿用既有政策，要求同时出现非中文书写证据。
 */
export function has_translation_similarity_issue(args: {
  src: string;
  dst: string;
  sourceLanguage: string;
  targetLanguage: string;
  has_foreign_residue: boolean; // 调用方复用同一译文的外文残留检查结果。
}): boolean {
  const target_language = normalize_language_code(args.targetLanguage);
  const source_language = normalize_language_code(args.sourceLanguage);
  const similar =
    target_language === null || target_language === "ALL"
      ? is_translation_text_similar(args.src, args.dst)
      : is_translation_text_similar_for_target({
          src: args.src,
          dst: args.dst,
          targetLanguage: target_language,
        });
  if (!similar) {
    return false;
  }

  if (target_language !== "ZH" && target_language !== "ZH-HANT") {
    return true;
  }

  if (source_language !== "JA" && source_language !== "KO") {
    return true;
  }

  return args.has_foreign_residue;
}
