import { createReadStream, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

// 批量翻译复检：结构保护段、校对警告、姓名一致性和行结构。
// 脚本只写 changes/items/updates，由 Agent 调用 workspace_apply 提交。

const TEXT_NEWLINE = "{TEXT_NEWLINE}";
const K_SENTINEL = "{K}";
const MACRO_KIND_PATTERN = /^\{([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)(?::|\})/u;

/** 逐行读取 JSONL；空行、损坏行和缺失文件都跳过。 */
async function* readJsonLineRecords(filePath) {
  if (typeof filePath !== "string" || filePath === "" || !existsSync(filePath)) return;
  const reader = readline.createInterface({
    input: createReadStream(filePath),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    const text = line.trim();
    if (text === "") continue;
    try {
      const value = JSON.parse(text);
      if (value !== null && typeof value === "object" && !Array.isArray(value)) yield value;
    } catch {
      // 损坏行由宿主日志报告，复检不能因此中断。
    }
  }
}

async function readJsonLines(filePath) {
  const rows = [];
  for await (const row of readJsonLineRecords(filePath)) rows.push(row);
  return rows;
}

/** 按项目 text_preserve 条目编译正则；无效规则单独报告，不让整批复检失败。 */
function compileRules(entries) {
  const patterns = [];
  const invalid = [];
  for (const entry of entries) {
    const source = typeof entry.src === "string" ? entry.src : "";
    if (source.trim() === "") continue;
    try {
      patterns.push(new RegExp(source, "giu"));
    } catch {
      invalid.push(source);
    }
  }
  return { patterns, invalid };
}

/** 与 TextPreserveRule 一致：同起点按规则顺序裁决，随后丢弃重叠候选。 */
function collectSegments(text, patterns) {
  const candidates = [];
  const value = String(text ?? "");
  patterns.forEach((pattern, ruleIndex) => {
    for (const match of value.matchAll(pattern)) {
      const segment = match[0];
      if (segment === "") continue;
      candidates.push({ value: segment, index: match.index ?? 0, ruleIndex });
    }
  });
  candidates.sort(
    (left, right) => left.index - right.index || left.ruleIndex - right.ruleIndex,
  );
  const result = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.index < cursor) continue;
    result.push(candidate);
    cursor = candidate.index + candidate.value.length;
  }
  return result;
}

/** 宏取类型，普通标签取完整值；类型不同时不能按位置自动替换。 */
function segmentKind(value) {
  const match = MACRO_KIND_PATTERN.exec(value);
  return match ? match[1] : value;
}

/** 按保护段索引替换译文的保护段，其他内容保持原样。 */
function replaceSegments(text, segments, replacements) {
  let result = "";
  let cursor = 0;
  for (const segment of segments) {
    result += text.slice(cursor, segment.index);
    result += replacements.has(segment.index)
      ? replacements.get(segment.index)
      : text.slice(segment.index, segment.index + segment.value.length);
    cursor = segment.index + segment.value.length;
  }
  return result + text.slice(cursor);
}

/** 只保留本次目标的校对警告，避免全量警告进入内存。 */
async function readWarnings(filePath, wantedIds) {
  const map = new Map();
  for await (const row of readJsonLineRecords(filePath)) {
    const itemId = Number(row.item_id);
    if (!Number.isSafeInteger(itemId)) continue;
    if (wantedIds !== null && !wantedIds.has(itemId)) continue;
    const warnings = Array.isArray(row.warnings) ? row.warnings : [];
    if (warnings.length > 0) map.set(itemId, warnings);
  }
  return map;
}

/**
 * 复检 PROCESSED 条目。contract 直接传入 `ws.contract`。
 * options.item_ids 省略或为空时扫描全部条目；传入时只处理指定条目。
 */
export async function audit(contract, options = {}) {
  if (contract === null || typeof contract !== "object") {
    throw new Error("recheck: contract is required.");
  }
  const wantedIds =
    Array.isArray(options.item_ids) && options.item_ids.length > 0
      ? new Set(options.item_ids.map(Number).filter((value) => Number.isSafeInteger(value)))
      : null;

  const ruleEntries = await readJsonLines(contract.datasets?.text_preserve?.path);
  const { patterns, invalid } = compileRules(ruleEntries);
  const warningsById = await readWarnings(contract.datasets?.warnings?.path, wantedIds);

  const autoRepairs = [];
  const flagged = [];
  const textNewlineMismatches = [];
  const proofreading = [];
  const nameGroups = new Map();
  let scanned = 0;
  let processed = 0;

  for await (const item of readJsonLineRecords(contract.datasets?.items?.path)) {
    const itemId = Number(item.item_id);
    if (!Number.isSafeInteger(itemId)) continue;
    if (wantedIds !== null && !wantedIds.has(itemId)) continue;
    scanned += 1;

    const src = String(item.src ?? "");
    const dst = String(item.dst ?? "");
    if (item.status !== "PROCESSED" || dst === "") continue;
    processed += 1;

    const nameSrc = String(item.name_src ?? "").trim();
    const nameDst = String(item.name_dst ?? "").trim();
    if (nameSrc !== "" && nameDst !== "") {
      let values = nameGroups.get(nameSrc);
      if (values === undefined) {
        values = new Set();
        nameGroups.set(nameSrc, values);
      }
      values.add(nameDst);
    }

    if (patterns.length > 0) {
      const srcSegments = collectSegments(src, patterns);
      const dstSegments = collectSegments(dst, patterns);
      const srcMain = srcSegments.filter(
        (segment) => segment.value !== TEXT_NEWLINE && segment.value.trim() !== "",
      );
      const dstMain = dstSegments.filter(
        (segment) => segment.value !== TEXT_NEWLINE && segment.value.trim() !== "",
      );

      if (srcMain.length !== dstMain.length) {
        flagged.push({
          item_id: itemId,
          code: "SEGMENT_COUNT",
          src: srcMain.map((segment) => segment.value),
          dst: dstMain.map((segment) => segment.value),
        });
      } else {
        const replacements = new Map();
        let kindMismatch = false;
        for (let index = 0; index < srcMain.length; index += 1) {
          const source = srcMain[index].value;
          const translation = dstMain[index].value;
          if (source === translation) continue;
          if (segmentKind(source) !== segmentKind(translation)) {
            kindMismatch = true;
            break;
          }
          replacements.set(dstMain[index].index, source);
        }
        if (kindMismatch) {
          flagged.push({
            item_id: itemId,
            code: "SEGMENT_KIND",
            src: srcMain.map((segment) => segment.value),
            dst: dstMain.map((segment) => segment.value),
          });
        } else if (replacements.size > 0) {
          autoRepairs.push({
            item_id: itemId,
            fp: item.fp,
            dst: replaceSegments(dst, dstSegments, replacements),
          });
        }
      }

      const srcNewlines = srcSegments.filter((segment) => segment.value === TEXT_NEWLINE).length;
      const dstNewlines = dstSegments.filter((segment) => segment.value === TEXT_NEWLINE).length;
      if (srcNewlines !== dstNewlines) {
        textNewlineMismatches.push({
          item_id: itemId,
          src: srcNewlines,
          dst: dstNewlines,
        });
      }
    }

    if (dst.includes(K_SENTINEL)) {
      flagged.push({ item_id: itemId, code: "K_SENTINEL" });
    }

    const warnings = warningsById.get(itemId);
    if (warnings !== undefined) proofreading.push({ item_id: itemId, warnings });
  }

  const nameInconsistencies = [];
  for (const [nameSrc, values] of nameGroups) {
    if (values.size > 1) nameInconsistencies.push({ name_src: nameSrc, values: [...values] });
  }

  const warningCounts = {};
  const textPreserveDetail = { newline: 0, structure: 0 };
  for (const entry of proofreading) {
    for (const warning of entry.warnings) {
      const code = String(warning?.code ?? "UNKNOWN");
      warningCounts[code] = (warningCounts[code] ?? 0) + 1;
      if (code === "TEXT_PRESERVE") {
        // 只包含 TEXT_NEWLINE 的差异属于换行结构，其余保护段差异优先处理。
        const fragments = [
          ...(Array.isArray(warning.source_fragments) ? warning.source_fragments : []),
          ...(Array.isArray(warning.translation_fragments) ? warning.translation_fragments : []),
        ];
        if (fragments.every((fragment) => fragment === TEXT_NEWLINE || String(fragment).trim() === "")) {
          textPreserveDetail.newline += 1;
        } else {
          textPreserveDetail.structure += 1;
        }
      }
    }
  }

  const changesPath = contract.changes?.items?.updates?.path;
  if (typeof changesPath !== "string" || changesPath === "") {
    throw new Error("recheck: changes.items.updates.path is missing.");
  }
  await writeFile(
    changesPath,
    autoRepairs.map((repair) => JSON.stringify(repair)).join("\n") +
      (autoRepairs.length > 0 ? "\n" : ""),
    "utf8",
  );

  const reportDirectory = path.join(process.cwd(), "work", "recheck");
  await mkdir(reportDirectory, { recursive: true });
  const reportPath = path.join(
    reportDirectory,
    `report-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`,
  );
  const summary = {
    scanned,
    processed,
    text_preserve_rules: patterns.length,
    invalid_rules: invalid,
    auto_repairable: autoRepairs.length,
    flagged: flagged.length,
    text_newline_mismatches: textNewlineMismatches.length,
    proofreading_items: proofreading.length,
    warning_counts: warningCounts,
    text_preserve_detail: textPreserveDetail,
    name_inconsistencies: nameInconsistencies.length,
    report_path: reportPath,
    samples: {
      auto_repairable: autoRepairs.slice(0, 10).map((repair) => repair.item_id),
      flagged: flagged.slice(0, 10),
      text_newline_mismatches: textNewlineMismatches.slice(0, 10),
      name_inconsistencies: nameInconsistencies.slice(0, 10),
    },
  };
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        summary,
        auto_repairs: autoRepairs,
        flagged,
        text_newline_mismatches: textNewlineMismatches,
        proofreading,
        name_inconsistencies: nameInconsistencies,
      },
      null,
      2,
    ),
    "utf8",
  );
  return summary;
}

export default audit;
