import type { JsonRecord } from "../../../domain/json";
import {
  AGENT_PENDING_WRITE_FILE_LIMIT,
  AGENT_PENDING_WRITE_SAMPLE_LIMIT,
  AGENT_PENDING_WRITE_TEXT_LIMIT,
  type AgentPendingWritePreview,
  type AgentPendingWriteSample,
} from "../../../shared/agent";
import type { ProjectItemWriteChange } from "../../project/project-write-request";
import type { AgentWorkspaceWriteRisk } from "./approval";

/** 文本只保留可核对的前缀；完整译文仍由工作区事务写入。 */
export function clip_agent_write_text(text: string): string {
  return text.length <= AGENT_PENDING_WRITE_TEXT_LIMIT
    ? text
    : `${text.slice(0, AGENT_PENDING_WRITE_TEXT_LIMIT - 1)}…`;
}

/** 汇总候选写入的旧值/新值、重复译文和文件分布，供授权前核对。 */
export function build_agent_write_preview(args: {
  changes: readonly ProjectItemWriteChange[];
  current_items: readonly JsonRecord[];
  project_item_count: number;
}): { preview: AgentPendingWritePreview; risk: AgentWorkspaceWriteRisk } {
  const current_by_id = new Map<string, JsonRecord>();
  for (const item of args.current_items) {
    const id = item["item_id"] ?? item["id"];
    if (id !== undefined && id !== null) current_by_id.set(String(id), item);
  }

  const dst_counts = new Map<string, number>();
  const file_counts = new Map<string, number>();
  let noop = 0;
  let empty = 0;
  for (const change of args.changes) {
    const before = change.current.dst ?? "";
    const after = change.next.dst ?? "";
    dst_counts.set(after, (dst_counts.get(after) ?? 0) + 1);
    if (before === after) noop += 1;
    if (after.trim() === "") empty += 1;
    const current = current_by_id.get(String(change.item_id));
    const file_path = typeof current?.["file_path"] === "string" ? current["file_path"] : "";
    if (file_path !== "") file_counts.set(file_path, (file_counts.get(file_path) ?? 0) + 1);
  }

  const top = [...dst_counts.entries()].sort(
    ([aText, aCount], [bText, bCount]) => bCount - aCount || aText.localeCompare(bText),
  )[0];
  const top_dst = top === undefined ? null : { text: clip_agent_write_text(top[0]), count: top[1] };
  const top_text = top?.[0] ?? null;

  const ordered =
    top_text === null
      ? args.changes
      : [...args.changes].sort((a, b) => {
          const a_top = (a.next.dst ?? "") === top_text ? 0 : 1;
          const b_top = (b.next.dst ?? "") === top_text ? 0 : 1;
          return a_top - b_top || a.item_id - b.item_id;
        });
  const sample: AgentPendingWriteSample[] = ordered
    .slice(0, AGENT_PENDING_WRITE_SAMPLE_LIMIT)
    .map((change) => {
      const current = current_by_id.get(String(change.item_id));
      return {
        item_id: change.item_id,
        file_path: typeof current?.["file_path"] === "string" ? current["file_path"] : "",
        src: clip_agent_write_text(typeof current?.["src"] === "string" ? current["src"] : ""),
        before: clip_agent_write_text(change.current.dst ?? ""),
        after: clip_agent_write_text(change.next.dst ?? ""),
      };
    });

  const files = [...file_counts.entries()]
    .sort(([aPath, aCount], [bPath, bCount]) => bCount - aCount || aPath.localeCompare(bPath))
    .slice(0, AGENT_PENDING_WRITE_FILE_LIMIT)
    .map(([path, count]) => ({ path, count }));

  return {
    preview: {
      total: args.changes.length,
      file_total: file_counts.size,
      files,
      distinct_dst: dst_counts.size,
      top_dst,
      sample,
      noop,
      empty,
      truncated: args.changes.length > sample.length,
      cumulative: null,
    },
    risk: {
      total: args.changes.length,
      dst_counts: [...dst_counts.entries()].map(([text, count]) => ({ text, count })),
      project_item_count: args.project_item_count,
    },
  };
}
