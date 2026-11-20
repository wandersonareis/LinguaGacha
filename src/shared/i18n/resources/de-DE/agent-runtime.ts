import { zh_cn_agent_runtime } from "../zh-CN/agent-runtime";
import type { LocaleMessageSchema } from "../../types";

export const de_de_agent_runtime = {
  message: {
    continue: "Fortfahren",
    queue_pending:
      "# Eingabewarteschlange\nDer Benutzer hat noch {COUNT} wartende Nachrichten. Bearbeite in diesem Durchlauf nur die aktuelle Nachricht und setze die unterbrochene Aufgabe erst fort, wenn die Warteschlange leer ist.",
    queue_last:
      "# Eingabewarteschlange\nDies ist die letzte wartende Nachricht. Bearbeite nur diese Nachricht und setze die unterbrochene Aufgabe noch nicht fort.",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_agent_runtime>;
