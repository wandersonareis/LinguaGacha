import type { zh_cn_agent_runtime } from "../zh-CN/agent-runtime";
import type { LocaleMessageSchema } from "../../types";
export const ko_kr_agent_runtime = {
  message: {
    continue: "계속",
    queue_pending:
      "# 입력 대기열\n사용자의 대기 메시지가 {COUNT}개 더 있습니다. 이번에는 현재 메시지만 처리하고 대기열이 빌 때까지 중단된 작업을 계속하지 마세요.",
    queue_last:
      "# 입력 대기열\n마지막 대기 메시지입니다. 이 메시지만 처리하고 중단된 작업을 아직 계속하지 마세요.",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_agent_runtime>;
