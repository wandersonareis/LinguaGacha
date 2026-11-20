import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { LocaleProvider } from "@frontend/app/locale/locale-provider";
import { create_text_resolver } from "@shared/i18n";
import { ProjectCreateDialog } from "./project-create-dialog";
import type { useProjectCreateFlow } from "./use-project-create-flow";

const t = create_text_resolver("zh-CN");

it.each([true, false])("创建对话框打开状态为 %s 时，语言确认仍可见并使用创建标题", async (open) => {
  const confirm = vi.fn();
  const flow: ReturnType<typeof useProjectCreateFlow> = {
    open,
    selected_source: null,
    formats: [],
    plugins: [],
    plugin_diagnostics: [],
    set_plugin_enabled: vi.fn(),
    source_selection_disabled: false,
    is_language_dialog_open: true,
    create_languages: { source_language: "JA", target_language: "ZH" },
    create_project_name: "demo",
    project_name_invalid: false,
    confirm_language_dialog: confirm,
    close: vi.fn(),
    show: vi.fn(),
    start_from_paths: vi.fn(async () => {}),
    clear_selected_source: vi.fn(),
    handle_select_source_file: vi.fn(),
    handle_select_source_folder: vi.fn(),
    handle_select_source_paths: vi.fn(),
    handle_drop_issue: vi.fn(),
    open_language_dialog: vi.fn(),
    set_create_languages: vi.fn(),
    set_create_project_name: vi.fn(),
    set_is_language_dialog_open: vi.fn(),
    pack_order: {
      dialog_props: { games: [], on_reorder: vi.fn(), on_confirm: vi.fn(), on_close: vi.fn() },
      request_order: vi.fn(),
      finish: vi.fn(),
    },
    backup_confirm: {
      dialog_props: {
        open: false,
        description: "",
        confirmDelay: true,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      },
      request_confirm: vi.fn(),
      finish: vi.fn(),
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <LocaleProvider locale="zh-CN">
          <ProjectCreateDialog flow={flow} />
        </LocaleProvider>,
      ),
    );
    const title = t("project.create.title");
    const dialog = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
      (element) => element.querySelector("input") !== null,
    );
    expect(dialog).toBeDefined();
    expect(document.getElementById(dialog!.getAttribute("aria-labelledby")!)?.textContent).toBe(
      title,
    );
    const name_input = dialog!.querySelector<HTMLInputElement>("input");
    expect(name_input?.value).toBe("demo");
    await act(async () => {
      const value_setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      value_setter?.call(name_input, "outro");
      name_input!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(flow.set_create_project_name).toHaveBeenCalledWith("outro");
    const button = [...dialog!.querySelectorAll("button")].find((element) =>
      element.textContent?.startsWith(t("app.action.confirm")),
    );
    await act(async () => button!.click());
    expect(confirm).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
