import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";

import type { JsonRecord } from "../../../domain/json";
import type {
  ProjectSnapshot,
  ProjectSnapshotDescription,
} from "../../project/project-snapshot-service";
import { AgentToolError, agent_tool_result, define_agent_tool } from "../tool-definition";

export type AgentProjectSnapshotPort = {
  list: () => Promise<ProjectSnapshotDescription>;
  create: () => Promise<ProjectSnapshot | null>;
  restore: (file: string, signal: AbortSignal | undefined) => Promise<JsonRecord>;
};

/**
 * 工程自动快照的模型入口。恢复会覆盖工程数据但不覆盖当前对话，
 * 用于脚本误改、批量写入或迁移后的灾难性翻译恢复。
 */
export function create_agent_project_snapshot_tool(options: {
  project: AgentProjectSnapshotPort;
}): ToolRegistration {
  return define_agent_tool({
    name: "project_snapshot",
    description: [
      "查看或恢复当前工程的自动快照。应用在 `workspace_apply`、每轮第一个 `workspace_run`、批量翻译和工程迁移前自动保存快照，用于从灾难性的脚本误改中恢复翻译。",
      "",
      "### 操作",
      "",
      "- `list`：列出当前工程的快照（时间、原因、大小、应用版本）。恢复前必须先调用。",
      "- `create`：立即保存一个手动快照，适合在用户要求前或执行高风险批量修改前使用。",
      "- `restore`：用 `list` 返回的 `file` 精确恢复。只覆盖工程数据，保留当前对话和聊天历史；恢复前应用会先保存当前状态。",
      "",
      "### 恢复规则",
      "",
      "- 只有用户明确要求恢复并确认目标快照后才调用 `restore`。",
      "- 先调用 `ask_user`，说明最近快照的时间、原因和将回滚的修改；用户未确认时不恢复。",
      "- 恢复后重新读取工程事实，不要继续使用旧快照中的条目或译文。",
      "- 快照不包含游戏目录；游戏目录仍由用户自己的备份恢复。",
      "- 如果用户报告译文在脚本执行后大范围丢失或错乱，先 `list`，不要重新翻译或覆盖现有内容。",
    ].join("\n"),
    executionMode: "sequential",
    parameters: Type.Object(
      {
        action: Type.Union(
          [Type.Literal("list"), Type.Literal("create"), Type.Literal("restore")],
          {
            description: "`list` 列出快照，`create` 保存手动快照，`restore` 恢复指定快照。",
          },
        ),
        file: Type.Optional(
          Type.String({ description: "`restore` 必填，取值为 `list` 返回的 `file` 字段。" }),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (params, _api, context) => {
      if (params.action === "list") {
        return agent_tool_result(await options.project.list());
      }
      if (params.action === "create") {
        return agent_tool_result({ created: await options.project.create() });
      }
      if (typeof params.file !== "string" || params.file === "") {
        throw new AgentToolError({
          code: "request.validation_failed",
          message: "`file` is required when action is `restore`.",
        });
      }
      return agent_tool_result(await options.project.restore(params.file, context.abortSignal));
    },
  });
}
