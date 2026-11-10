import type { JSX } from "react";

import { Input } from "@frontend/shadcn/input";
import { AppButton } from "@frontend/widgets/app-button";
import { SettingCardRow } from "@frontend/widgets/setting-card-row/setting-card-row";

type BackupDirectoryRowProps = {
  title: string;
  description: string;
  path: string;
  choose_label: string;
  pending: boolean;
  on_choose: () => Promise<void>;
};

/** 用户定时备份目录只做展示和原生选择，空值表示沿用 .lg 同目录。 */
export function BackupDirectoryRow(props: BackupDirectoryRowProps): JSX.Element {
  return (
    <SettingCardRow
      action_width="content"
      title={props.title}
      description={props.description}
      action={
        <div className="function-settings-page__backup-directory">
          <Input
            readOnly
            aria-label={props.title}
            value={props.path}
            placeholder="…"
            className="function-settings-page__backup-directory-input"
          />
          <AppButton
            type="button"
            variant="outline"
            size="sm"
            disabled={props.pending}
            onClick={() => void props.on_choose()}
          >
            {props.choose_label}
          </AppButton>
        </div>
      }
    />
  );
}
