import type {
  AgentPendingWritePreview,
  AgentPendingWriteSummary,
} from "../../../shared/agent";

/** 工作区在授权前给出的完整风险计数，供 Agent 会话累计。 */
export type AgentWorkspaceWriteRisk = Readonly<{
  total: number;
  dst_counts: readonly Readonly<{ text: string; count: number }>[];
  project_item_count: number;
}>;

/** 一次写入审批请求：摘要、展示预览和仅供后端累计的完整计数。 */
export type AgentWorkspaceApprovalRequest = Readonly<{
  summary: AgentPendingWriteSummary;
  preview: AgentPendingWritePreview | null;
  risk: AgentWorkspaceWriteRisk | null;
}>;

/** 成功提交后才允许累计本批风险；失败时保持原累计。 */
export type AgentWorkspaceWriteCommit = () => void;

/** 工作区只负责在写入前请求一次裁决；是否等待用户由 Agent 会话决定。 */
export type AgentWorkspaceApprovalPort = Readonly<{
  before_write: (
    tool_call_id: string,
    request: AgentWorkspaceApprovalRequest,
    signal: AbortSignal | undefined,
  ) => Promise<AgentWorkspaceWriteCommit>;
}>;
