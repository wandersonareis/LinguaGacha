import { zh_cn_agent_runtime } from "../zh-CN/agent-runtime";
import type { LocaleMessageSchema } from "../../types";

export const pt_br_agent_runtime = {
  message: {
    continue: "Continuar",
    queue_pending:
      "# Fila de entrada\nO usuário ainda tem {COUNT} mensagens na fila. Resolva apenas a mensagem atual e não retome a tarefa interrompida até a fila esvaziar.",
    queue_last:
      "# Fila de entrada\nEsta é a última mensagem da fila. Resolva apenas esta mensagem e não retome ainda a tarefa interrompida.",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_agent_runtime>;
