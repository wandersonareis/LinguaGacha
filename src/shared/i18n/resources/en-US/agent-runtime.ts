import { zh_cn_agent_runtime } from "../zh-CN/agent-runtime";
import type { LocaleMessageSchema } from "../../types";

export const en_us_agent_runtime = {
  message: {
    continue: "Continue",
    queue_pending:
      "# Queued input\nThe user has {COUNT} more queued messages. Handle only the current message in this turn and do not continue the interrupted task until the queue is empty.",
    queue_last:
      "# Queued input\nThis is the last queued message. Handle only this message and do not continue the interrupted task yet.",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_agent_runtime>;
