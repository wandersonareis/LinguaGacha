import type { zh_cn_agent_runtime } from "../zh-CN/agent-runtime";
import type { LocaleMessageSchema } from "../../types";
export const ja_jp_agent_runtime = {
  message: {
    continue: "続ける",
    queue_pending:
      "# 入力キュー\nユーザーの未処理メッセージがあと {COUNT} 件あります。今回は現在のメッセージだけを処理し、キューが空になるまで中断されたタスクを続けないでください。",
    queue_last:
      "# 入力キュー\n最後の未処理メッセージです。このメッセージだけを処理し、中断されたタスクをまだ続けないでください。",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_agent_runtime>;
