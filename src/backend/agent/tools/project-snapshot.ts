import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { JsonRecord } from "../../../domain/json";
import type { AgentRestoreScope } from "../../../shared/agent";
import type {
  ProjectSnapshot,
  ProjectSnapshotDescription,
} from "../../project/project-snapshot-service";
import { AgentToolError, agent_tool_result, define_agent_tool } from "../tool-definition";

export type AgentProjectSnapshotPort = {
  list: () => Promise<ProjectSnapshotDescription>;
  create: () => Promise<ProjectSnapshot | null>;
  rollback: (signal: AbortSignal | undefined) => Promise<JsonRecord>;
  restoreAnchor: (scope: AgentRestoreScope, signal: AbortSignal | undefined) => Promise<JsonRecord>;
  restore: (
    file: string,
    scope: AgentRestoreScope,
    signal: AbortSignal | undefined,
  ) => Promise<JsonRecord>;
};

/**
 * 工程自动快照的模型入口。恢复会覆盖工程数据，但 translations/project 保留当前对话；
 * 用于脚本误改、批量写入或迁移后的灾难性翻译恢复。
 */
export function create_agent_project_snapshot_tool(options: {
  project: AgentProjectSnapshotPort;
}): ToolRegistration {
  return define_agent_tool({
    name: "project_snapshot",
    description: [
      "查看或恢复当前工程的自动快照。应用在 `workspace_run`、`workspace_apply`、批量翻译和工程迁移前自动保存快照，用于从灾难性的脚本/批量误改中恢复。",
      "",
      "### 操作",
      "",
      "- `list`：列出当前工程的快照（时间、原因、大小、应用版本、`anchor`/`protect`）。恢复前必须先调用。",
      "- `create`：立即保存一个手动快照，适合在执行高风险批量修改前使用。",
      "- `rollback`：恢复最近一个非安全快照的 `translations`，适合一次 apply/批量写入出错。",
      "- `restore_anchor`：恢复当前任务锚点（多次修正都失败后的整体回退）。",
      "- `restore`：用 `list` 返回的 `file` 精确恢复；可指定 `scope`。",
      "",
      "### 恢复范围",
      "",
      "- `translations`（默认）：只恢复条目/PDF 译文与翻译统计；保留 glossário、text preserve、prompts、qualidade、conhecimento、assets e chat。",
      "- `project`：恢复所有工程表，保留当前聊天/SDK。",
      "- `file`：用快照替换整个 `.lg`，包括聊天、glossário 等；这是最后手段，损失最大。",
      "",
      "### 恢复规则",
      "",
      "- 只有用户明确确认目标/范围后才执行恢复；先 `ask_user`。",
      "- 如果 `workspace_run` 返回 `external_project_write: true`，停止修正，优先恢复 `restore_point`（脚本前 full），不要继续叠加写入。",
      "- 如果是批量 `workspace_apply` 造成的破坏，优先恢复写入前的完整点，再重建正确的批量变更；不要把多个失败批次叠在一起。",
      "- 恢复后重新读取工程事实，核对丢失范围和真实状态；不要继续使用旧快照中的条目。",
      "- 快照不包含游戏目录；游戏目录仍由用户自己的备份恢复。",
      "- 恢复会话快照会把当前状态先保存为 `before-restore`；用户定时备份不在 Agent 的可见范围内。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        action: Type.Union(
          [
            Type.Literal("list"),
            Type.Literal("create"),
            Type.Literal("rollback"),
            Type.Literal("restore_anchor"),
            Type.Literal("restore"),
          ],
          {
            description:
              "`list` 列出快照，`create` 保存手动快照，`rollback` 回退最近一次，`restore_anchor` 回退任务锚点，`restore` 恢复指定文件。",
          },
        ),
        file: Type.Optional(
          Type.String({ description: "`restore` 必填，取值为 `list` 返回的 `file` 字段。" }),
        ),
        scope: Type.Optional(
          Type.Union(
            [Type.Literal("translations"), Type.Literal("project"), Type.Literal("file")],
            {
              description:
                "恢复范围；默认 translations。file 会替换整个 .lg，损失包括聊天和所有规则。",
            },
          ),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      const scope: AgentRestoreScope = params.scope ?? "translations";
      if (params.action === "list") {
        return agent_tool_result(await options.project.list());
      }
      if (params.action === "create") {
        return agent_tool_result({ created: await options.project.create() });
      }
      if (params.action === "rollback") {
        return agent_tool_result(await options.project.rollback(context.abortSignal));
      }
      if (params.action === "restore_anchor") {
        return agent_tool_result(
          await options.project.restoreAnchor(scope, context.abortSignal),
        );
      }
      if (typeof params.file !== "string" || params.file === "") {
        throw new AgentToolError({
          code: "request.validation_failed",
          message: "`file` is required when action is `restore`.",
        });
      }
      return agent_tool_result(
        await options.project.restore(params.file, scope, context.abortSignal),
      );
    },
  });
}
