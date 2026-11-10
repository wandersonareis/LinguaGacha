export const zh_cn_function_settings_page = {
  title: "功能设置",
  fields: {
    preceding_lines_threshold: {
      title: "参考前文条目数",
      description: "设置每个任务携带的参考前文条目数，会增加 Token 消耗，默认禁用",
    },
    following_lines_threshold: {
      title: "参考后文条目数",
      description: "设置每个任务携带的参考后文条目数，会增加 Token 消耗，默认禁用",
    },
    request_timeout: {
      title: "请求超时时间",
      description: "发起请求时等待模型回复的最长时间（秒），超时仍未收到回复，则会判断为任务失败",
    },
    project_snapshot_limit: {
      title: "自动工程快照数量",
      description:
        "在 Agent 应用变更、运行脚本、批量翻译或工程迁移前自动保存工程快照，用于从灾难性的脚本误改中恢复翻译。0 表示关闭",
    },
    project_backup_interval_hours: {
      title: "用户定时备份间隔（小时）",
      description:
        "应用打开时每隔 N 小时保存一份完整工程 .lg 到用户备份目录。它是最后手段，不做自动清理；App 关闭时延后到下次打开",
    },
    project_backup_directory: {
      title: "用户备份目录",
      description:
        "留空表示使用 .lg 所在目录。只复制完整工程 .lg，不包含 userdata、技能或 workspace",
      choose: "选择目录",
    },
    project_save_mode: {
      title: "工程文件保存位置",
      description: "设置创建工程时工程文件的保存位置",
      options: {
        manual: "每次手动选择",
        fixed: "固定目录",
        source: "源文件同目录",
      },
    },
    translation_save_mode: {
      title: "译文文件保存位置",
      description: "设置生成译文时译文文件的保存位置",
      options: { manual: "每次手动选择", fixed: "固定目录", project: "工程文件同目录" },
    },
    output_folder_open_on_finish: {
      title: "生成译文文件时打开输出文件夹",
      description: "启用此功能后，将在译文文件生成成功时自动打开输出文件夹",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid: "参考前文条目数必须填写为 0 至 9999999 的整数 …",
    following_lines_threshold_invalid: "参考后文条目数必须填写为 0 至 9999999 的整数 …",
    request_timeout_invalid: "请求超时时间必须填写为有效范围内的数字 …",
    project_snapshot_limit_invalid: "自动工程快照数量必须填写为 0 至 20 的整数 …",
    project_backup_interval_hours_invalid: "用户定时备份间隔必须填写为 1 至 24 的整数 …",
    pick_backup_directory_failed: "选择备份目录失败 …",
    pick_directory_failed: "目录选择失败 …",
  },
} as const;
