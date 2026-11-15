import type { AgentWorkspaceWriteRisk } from "./workspace/approval";
import { clip_agent_write_text } from "./workspace/write-preview";

/** 单批与累计共用的风险阈值：100 条起、同一译文 90% 或覆盖项目 10%。 */
export const AGENT_MASS_CHANGE_MIN_ITEMS = 100;
export const AGENT_MASS_CHANGE_SAME_DST_RATIO = 0.9;
export const AGENT_MASS_CHANGE_PROJECT_RATIO = 0.1;

/** 一轮对话内已批准写入的累计风险；按 roundId 隔离。 */
export type AgentWriteRiskState = Readonly<{
  round_id: string;
  total: number;
  dst_counts: ReadonlyMap<string, number>;
  project_item_count: number;
  acknowledged_text: string | null;
  acknowledged_project: boolean;
}>;

export type AgentWriteRiskCumulative = Readonly<{
  total: number;
  same_dst: number;
  top_dst: Readonly<{ text: string; count: number }> | null;
  risky: boolean;
}>;

export type AgentWriteRiskResult = Readonly<{
  state: AgentWriteRiskState;
  cumulative: AgentWriteRiskCumulative;
  requires_approval: boolean;
  same_risky: boolean;
  project_risky: boolean;
}>;

/** 新一轮从空累计开始；旧轮身份由调用方自然丢弃。 */
export function empty_agent_write_risk(round_id: string): AgentWriteRiskState {
  return {
    round_id,
    total: 0,
    dst_counts: new Map(),
    project_item_count: 0,
    acknowledged_text: null,
    acknowledged_project: false,
  };
}

/** 合并本批完整 dst 计数，返回累计预览和是否必须打断自动审批。 */
export function accumulate_agent_write_risk(
  previous: AgentWriteRiskState | null,
  round_id: string,
  risk: AgentWorkspaceWriteRisk | null,
): AgentWriteRiskResult {
  const base = previous?.round_id === round_id ? previous : empty_agent_write_risk(round_id);
  const counts = new Map(base.dst_counts);
  let total = base.total;
  const project_item_count = risk?.project_item_count ?? base.project_item_count;
  if (risk !== null && risk.total > 0) {
    total += risk.total;
    for (const item of risk.dst_counts) {
      counts.set(item.text, (counts.get(item.text) ?? 0) + item.count);
    }
  }

  const top = top_dst_counts(counts);
  const same_dst = top?.count ?? 0;
  const project_ratio = total / Math.max(project_item_count, 1);
  const same_risky =
    total >= AGENT_MASS_CHANGE_MIN_ITEMS && same_dst / total >= AGENT_MASS_CHANGE_SAME_DST_RATIO;
  const project_risky =
    total >= AGENT_MASS_CHANGE_MIN_ITEMS && project_ratio >= AGENT_MASS_CHANGE_PROJECT_RATIO;
  const cumulative = {
    total,
    same_dst,
    top_dst: top === null ? null : { text: clip_agent_write_text(top.text), count: top.count },
    risky: same_risky || project_risky,
  };
  const requires_approval =
    (same_risky && cumulative.top_dst?.text !== base.acknowledged_text) ||
    (project_risky && !base.acknowledged_project);

  return {
    state: { ...base, total, dst_counts: counts, project_item_count },
    cumulative,
    requires_approval,
    same_risky,
    project_risky,
  };
}

/** 用户允许本次写入后，记录已确认的重复译文或项目比例，避免连续重复弹窗。 */
export function acknowledge_agent_write_risk(result: AgentWriteRiskResult): AgentWriteRiskState {
  return {
    ...result.state,
    acknowledged_text:
      result.same_risky && result.cumulative.top_dst !== null
        ? result.cumulative.top_dst.text
        : result.state.acknowledged_text,
    acknowledged_project: result.state.acknowledged_project || result.project_risky,
  };
}

/** 最大重复组；同票按文本排序，保证累计提示稳定。 */
function top_dst_counts(
  counts: ReadonlyMap<string, number>,
): Readonly<{ text: string; count: number }> | null {
  let top: { text: string; count: number } | null = null;
  for (const [text, count] of counts) {
    if (top === null || count > top.count || (count === top.count && text < top.text)) {
      top = { text, count };
    }
  }
  return top;
}
