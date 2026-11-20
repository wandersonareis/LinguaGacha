export const zh_cn_agent_runtime = {
  message: {
    continue: "继续",
    queue_pending:
      "# 输入队列\n用户还有 {COUNT} 条排队消息待处理。本轮只处理当前消息，不要继续被打断的旧任务；队列清空后再恢复旧任务。",
    queue_last: "# 输入队列\n当前是最后一条排队消息。只处理这条消息，不要继续被打断的旧任务。",
  },
} as const;
