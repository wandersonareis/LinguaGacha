import { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const pt_br_function_settings_page = {
  title: "Configurações de funções",
  fields: {
    preceding_lines_threshold: {
      title: "Entradas de contexto anterior",
      description:
        "Define o número de entradas de texto anteriores incluídas como contexto em cada tarefa. Isso aumenta o consumo de tokens. Desativado por padrão.",
    },
    following_lines_threshold: {
      title: "Entradas de contexto posterior",
      description:
        "Define o número de entradas de texto posteriores incluídas como contexto em cada tarefa. Isso aumenta o consumo de tokens. Desativado por padrão.",
    },
    request_timeout: {
      title: "Tempo limite de requisição",
      description:
        "Tempo máximo de espera por uma resposta do modelo, em segundos. A tarefa falha se nenhuma resposta for recebida a tempo.",
    },
    project_snapshot_limit: {
      title: "Snapshots automáticos do projeto",
      description:
        "Salva automaticamente um snapshot do projeto antes de edições do Agent, scripts, tradução em lote ou migrações, permitindo recuperar as traduções após um erro catastrófico de script. 0 desativa.",
    },
    project_save_mode: {
      title: "Local de salvamento do projeto",
      description: "Define o local de salvamento dos arquivos de projeto ao criar um novo projeto",
      options: {
        manual: "Escolher a cada vez",
        fixed: "Pasta fixa",
        source: "Junto aos arquivos de origem",
      },
    },
    translation_save_mode: {
      title: "Local de salvamento da tradução",
      description: "Define onde os arquivos traduzidos são salvos ao gerar as traduções",
      options: {
        manual: "Escolher a cada vez",
        fixed: "Pasta fixa",
        project: "Junto ao arquivo de projeto",
      },
    },
    output_folder_open_on_finish: {
      title: "Abrir pasta de saída ao gerar o arquivo traduzido",
      description:
        "Quando ativado, a pasta de saída será aberta após o arquivo traduzido ser gerado com sucesso",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "A contagem de entradas de contexto anterior deve ser um número inteiro de 0 a 9999999 …",
    following_lines_threshold_invalid:
      "A contagem de entradas de contexto posterior deve ser um número inteiro de 0 a 9999999 …",
    request_timeout_invalid:
      "O tempo limite de requisição deve ser um número dentro do intervalo válido …",
    project_snapshot_limit_invalid:
      "A quantidade de snapshots automáticos deve ser um número inteiro de 0 a 20 …",
    pick_directory_failed:
      "Falha na seleção da pasta. Escolha novamente a pasta fixa de salvamento …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
