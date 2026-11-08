import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { create_text_resolver, type LocaleKey } from "@shared/i18n";
import {
  BUILTIN_FORMAT_CATALOG,
  PROJECT_SOURCE_FORMATS,
  type ProjectSourceFormatHitCounts,
} from "@shared/project-source-formats";

import { ProjectSourceFormats } from "./project-source-formats";

const t = create_text_resolver("zh-CN");

describe("ProjectSourceFormats", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  /** 按词典解析后的可见名称定位格式标签。 */
  function find_tag(title_key: LocaleKey): HTMLElement {
    return [...container.querySelectorAll<HTMLElement>(".project-lifecycle__format-tag")].find(
      (tag) => tag.querySelector("span")?.textContent === t(title_key),
    )!;
  }

  it("格式标签显示非零计数并隐藏内部格式，提示图标可聚焦", async () => {
    const format_hit_counts = Object.fromEntries(
      PROJECT_SOURCE_FORMATS.map((format) => [format.id, 0]),
    ) as ProjectSourceFormatHitCounts;
    format_hit_counts.txt = 3;
    format_hit_counts.trans = 2;
    format_hit_counts.generic = 7;
    await act(async () =>
      root.render(
        <LocaleProvider locale="zh-CN">
          <ProjectSourceFormats format_hit_counts={format_hit_counts} />
        </LocaleProvider>,
      ),
    );

    expect(find_tag("project.formats.txt").querySelector('[data-slot="badge"]')?.textContent).toBe(
      "3",
    );
    expect(
      find_tag("project.formats.trans").querySelector('[data-slot="badge"]')?.textContent,
    ).toBe("2");
    expect(find_tag("project.formats.generic")).toBeUndefined();
    for (const icon of container.querySelectorAll<HTMLElement>("h3 [tabindex]")) {
      expect(icon.textContent).toBe("");
      expect(icon.getAttribute("aria-label")).toBe(icon.closest("h3")?.textContent);
      act(() => icon.focus());
      expect(document.activeElement).toBe(icon);
    }
    expect(container.querySelectorAll("h3 [tabindex]").length).toBeGreaterThan(0);
    expect(find_tag("project.formats.md").querySelector('[data-slot="badge"]')).toBeNull();
  });

  it("列出插件、切换启停并显示未加载诊断", async () => {
    const toggle = vi.fn();
    await act(async () =>
      root.render(
        <LocaleProvider locale="zh-CN">
          <ProjectSourceFormats
            formats={[
              ...BUILTIN_FORMAT_CATALOG,
              {
                source_kind: "file",
                id: "sample",
                support_status: "supported",
                detection: "extension",
                extension: ".sample",
                extensions: [".sample"],
                title: "Sample",
                description: "Sample format",
                plugin_id: "sample",
              },
            ]}
            plugins={[
              {
                id: "sample",
                name: "Sample",
                description: "Sample format",
                version: "1.0.0",
                api_version: 1,
                extensions: [".sample"],
                file_types: ["SAMPLE"],
                detection: "extension",
                enabled: true,
              },
            ]}
            diagnostics={[{ directory: "E:/plugins/broken", message: "Invalid manifest." }]}
            on_plugin_toggle={toggle}
          />
        </LocaleProvider>,
      ),
    );

    expect(container.textContent).toContain(t("project.formats.plugin_title"));
    expect(find_tag("project.formats.txt")).toBeDefined();
    expect(container.textContent).toContain("Sample");
    const button = container.querySelector<HTMLButtonElement>("button[aria-pressed]");
    expect(button?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => button?.click());
    expect(toggle).toHaveBeenCalledWith("sample", false);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Invalid manifest.");
  });
});
