/** 工程文件统一使用 `.lg` 扩展名，用户只输入名称部分。 */
const PROJECT_FILE_EXTENSION = ".lg";
// Windows 文件名禁止的字符与控制字符（Cc 类别）。
const INVALID_PROJECT_NAME_CHARACTERS = /[<>:"/\\|?*\p{Cc}]/u;
// Windows 设备名即使带扩展名也不能作为文件名。
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CLOCK$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

/** 去掉用户输入中重复的 `.lg` 后缀；扩展名统一由创建流程追加。 */
export function normalize_project_name(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(PROJECT_FILE_EXTENSION)
    ? trimmed.slice(0, -PROJECT_FILE_EXTENSION.length).trimEnd()
    : trimmed;
}

/** 空名称表示沿用自动生成的名称，其余情况校验 Windows 文件名约束。 */
export function is_project_name_valid(value: string): boolean {
  if (value === "") return true;
  if (INVALID_PROJECT_NAME_CHARACTERS.test(value) || /[. ]$/u.test(value)) return false;
  const stem = value.split(".")[0] ?? "";
  return !WINDOWS_RESERVED_NAMES.has(stem.toUpperCase());
}

/** 用户名称优先，留空时回退到本次创建的默认名称。 */
export function build_project_file_name(value: string, fallback_name: string): string {
  return `${normalize_project_name(value) || fallback_name}${PROJECT_FILE_EXTENSION}`;
}
