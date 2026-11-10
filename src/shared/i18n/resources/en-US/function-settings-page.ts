import { zh_cn_function_settings_page } from "../zh-CN/function-settings-page";
import type { LocaleMessageSchema } from "../../types";

export const en_us_function_settings_page = {
  title: "Function settings",
  fields: {
    preceding_lines_threshold: {
      title: "Preceding context entries",
      description:
        "Set the number of preceding text entries included as context in each task. This increases token usage. Disabled by default.",
    },
    following_lines_threshold: {
      title: "Following context entries",
      description:
        "Set the number of following text entries included as context in each task. This increases token usage. Disabled by default.",
    },
    request_timeout: {
      title: "Request timeout",
      description:
        "Maximum wait for a model reply, in seconds. The task fails if no reply arrives in time.",
    },
    project_backup_interval_hours: {
      title: "User backup interval (hours)",
      description:
        "While the app is open, saves a complete project .lg to the user backup folder every N hours. It is a last resort and has no automatic cleanup; while closed, it waits for the next launch.",
    },
    project_backup_directory: {
      title: "User backup folder",
      description:
        "Empty uses the .lg folder. Only the complete project .lg is copied; no userdata, skills, or workspace.",
      choose: "Choose folder",
    },
    project_snapshot_limit: {
      title: "Automatic project snapshots",
      description:
        "Saves project snapshots before Agent edits, scripts, batch translation, or migrations, so translations can be recovered after a catastrophic script mistake. 0 disables it.",
    },
    project_save_mode: {
      title: "Project save location",
      description: "Set the save location for project files when creating a new project",
      options: {
        manual: "Choose every time",
        fixed: "Fixed directory",
        source: "Next to source files",
      },
    },
    translation_save_mode: {
      title: "Translation save location",
      description: "Set where translation files are saved when generating translations",
      options: {
        manual: "Choose every time",
        fixed: "Fixed directory",
        project: "Next to the project file",
      },
    },
    output_folder_open_on_finish: {
      title: "Open output folder when translation file is generated",
      description:
        "When enabled, the output folder will be opened after the translated file is generated successfully",
    },
  },
  feedback: {
    preceding_lines_threshold_invalid:
      "The preceding context entry count must be an integer from 0 to 9999999 …",
    following_lines_threshold_invalid:
      "The following context entry count must be an integer from 0 to 9999999 …",
    request_timeout_invalid: "Request timeout must be a number within the valid range …",
    project_snapshot_limit_invalid:
      "The automatic project snapshot count must be an integer from 0 to 20 …",
    project_backup_interval_hours_invalid:
      "The user backup interval must be an integer from 1 to 24 …",
    pick_backup_directory_failed: "Backup folder selection failed …",
    pick_directory_failed:
      "Directory selection failed. Please choose the fixed save directory again …",
  },
} satisfies LocaleMessageSchema<typeof zh_cn_function_settings_page>;
