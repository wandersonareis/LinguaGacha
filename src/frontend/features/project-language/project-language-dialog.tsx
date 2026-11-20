import { useId, type JSX } from "react";

import type { ProjectLanguageKey } from "@domain/project-settings";
import { useI18n } from "@frontend/app/locale/locale-context";
import { ProjectLanguageSelect } from "@frontend/features/project-language/project-language-select";
import { Input } from "@frontend/shadcn/input";
import { AppPageDialog } from "@frontend/widgets/app-page-dialog";
import { SettingCardRow } from "@frontend/widgets/setting-card-row/setting-card-row";

/** 创建工程时额外展示的工程名字段，编辑语言时由调用方省略。 */
type ProjectNameField = {
  value: string;
  invalid: boolean;
  on_change: (next_value: string) => void;
};

type ProjectLanguageDialogProps = {
  open: boolean;
  title?: string | undefined;
  languages: Record<ProjectLanguageKey, string>; // 调用方持有本次编辑草稿
  disabled?: boolean;
  submitting?: boolean;
  name_field?: ProjectNameField;
  on_change: (field: ProjectLanguageKey, next_value: string) => void;
  on_confirm: () => void | Promise<void>;
  on_close: () => void;
};

/** 新建与编辑工程共用语言选择，调用方负责草稿和确认后的业务流程。 */
export function ProjectLanguageDialog(props: ProjectLanguageDialogProps): JSX.Element {
  const { t } = useI18n();
  const name_input_id = useId();
  const name_hint_id = useId();
  const name_error_id = useId();
  const name_field = props.name_field;

  return (
    <AppPageDialog
      open={props.open}
      title={props.title ?? t("project.language.title")}
      size="sm"
      onClose={props.on_close}
      submitting={props.submitting === true}
      primaryAction={{
        label: t("app.action.confirm"),
        shortcut: "submit",
        onSelect: props.on_confirm,
        disabled: props.disabled === true || props.name_field?.invalid === true,
      }}
    >
      <div className="flex flex-col gap-(--ui-list-gap-dense)">
        {name_field !== undefined ? (
          <div className="flex flex-col gap-2">
            <label
              className="text-[length:var(--ui-font-size-13)] font-medium"
              htmlFor={name_input_id}
            >
              {t("project.create.project_name.title")}
            </label>
            <Input
              id={name_input_id}
              autoFocus
              value={name_field.value}
              aria-invalid={name_field.invalid || undefined}
              aria-describedby={name_field.invalid ? name_error_id : name_hint_id}
              disabled={props.disabled === true || props.submitting === true}
              onChange={(event) => {
                name_field.on_change(event.target.value);
              }}
            />
            <p
              id={name_hint_id}
              className="text-[length:var(--ui-font-size-12)] text-muted-foreground"
            >
              {t("project.create.project_name.description")}
            </p>
            {name_field.invalid ? (
              <p
                id={name_error_id}
                className="text-[length:var(--ui-font-size-12)] text-destructive"
              >
                {t("project.create.project_name.invalid")}
              </p>
            ) : null}
          </div>
        ) : null}
        <SettingCardRow
          variant="group"
          action_width="content"
          title={t("app.language_role.source")}
          description={t("project.language.source_description")}
          action={
            <ProjectLanguageSelect
              disabled={props.disabled === true || props.submitting === true}
              field="source_language"
              value={props.languages.source_language}
              on_change={(next_value) => {
                props.on_change("source_language", next_value);
              }}
            />
          }
        />
        <SettingCardRow
          variant="group"
          action_width="content"
          title={t("app.language_role.target")}
          description={t("project.language.target_description")}
          action={
            <ProjectLanguageSelect
              disabled={props.disabled === true || props.submitting === true}
              field="target_language"
              value={props.languages.target_language}
              on_change={(next_value) => {
                props.on_change("target_language", next_value);
              }}
            />
          }
        />
      </div>
    </AppPageDialog>
  );
}
