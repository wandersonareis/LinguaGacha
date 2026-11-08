import { describe, expect, it } from "vitest";

import { PROJECT_SOURCE_FORMATS } from "./project-source-formats";

describe("PROJECT_SOURCE_FORMATS", () => {
  it("格式 ID 唯一，普通文件格式的扩展名互斥", () => {
    const format_ids = PROJECT_SOURCE_FORMATS.map((format) => format.id);
    // 按内容识别的格式可以与扩展名格式共享后缀，不能参与扩展名唯一性检查。
    const non_content_detected_formats = PROJECT_SOURCE_FORMATS.filter(
      (format) =>
        format.source_kind === "file" &&
        (!("detection" in format) || format.detection !== "content"),
    );
    const extensions = non_content_detected_formats.map((format) => format.extension);

    expect(new Set(format_ids).size).toBe(format_ids.length);
    expect(new Set(extensions).size).toBe(extensions.length);
  });
});
