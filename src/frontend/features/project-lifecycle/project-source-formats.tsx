import { Info } from "lucide-react";
import { useId, type JSX } from "react";

import { useI18n } from "@frontend/app/locale/locale-context";
import { Badge } from "@frontend/shadcn/badge";
import { badgeVariants } from "@frontend/shadcn/badge-variants";
import { Tooltip, TooltipContent, TooltipTrigger } from "@frontend/shadcn/tooltip";
import {
  BUILTIN_FORMAT_CATALOG,
  type FormatCatalogEntry,
  type FormatPluginDiagnostic,
  type FormatPluginInfo,
  type ProjectSourceFormatHitCounts,
} from "@shared/project-source-formats";

/** 按支持状态依次展示分组，组内沿用目录顺序。 */
const FORMAT_GROUPS = [
  {
    support_status: "supported",
    title_key: "project.formats.title",
    tooltip_key: "project.formats.title_tooltip",
  },
  {
    support_status: "deprecated",
    title_key: "project.formats.deprecated_title",
    tooltip_key: "project.formats.deprecated_tooltip",
  },
] as const;

type ProjectSourceFormatsProps = {
  format_hit_counts?: ProjectSourceFormatHitCounts | undefined; // 尚未选择来源时没有摘要
  formats?: readonly FormatCatalogEntry[] | undefined; // 缺省使用内置目录
  plugins?: readonly FormatPluginInfo[] | undefined;
  diagnostics?: readonly FormatPluginDiagnostic[] | undefined;
  on_plugin_toggle?: ((plugin_id: string, enabled: boolean) => void) | undefined;
};

/** 展示来源格式、插件启停与命中数；内置项使用 i18n，插件项使用原始文本。 */
export function ProjectSourceFormats(props: ProjectSourceFormatsProps): JSX.Element {
  const { t } = useI18n();
  const id_prefix = useId(); // 为每个实例的分组标题生成独立 ID，供列表关联。
  const catalog = props.formats ?? BUILTIN_FORMAT_CATALOG;

  return (
    <>
      {FORMAT_GROUPS.map((group) => {
        const title_id = `${id_prefix}-${group.support_status}`;
        return (
          <section
            key={group.support_status}
            className="project-lifecycle__format-group"
            aria-labelledby={title_id}
          >
            <h3 id={title_id} className="project-lifecycle__section-title">
              {t(group.title_key)}
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span tabIndex={0} className="inline-flex" aria-label={t(group.title_key)}>
                      <Info aria-hidden="true" />
                    </span>
                  }
                />
                <TooltipContent>{t(group.tooltip_key)}</TooltipContent>
              </Tooltip>
            </h3>
            <ul aria-labelledby={title_id} className="project-lifecycle__format-tags">
              {catalog
                .filter((format) => format.support_status === group.support_status)
                .map((format) => {
                  const hit_count = props.format_hit_counts?.[format.id] ?? 0;
                  const title =
                    format.title_key === undefined
                      ? (format.title ?? format.id)
                      : t(format.title_key);
                  const descriptions =
                    format.description_keys !== undefined && format.description_keys.length > 0
                      ? format.description_keys.map((key) => t(key))
                      : [format.description ?? title];
                  return (
                    <Tooltip key={format.id}>
                      <TooltipTrigger
                        render={
                          <li
                            className={badgeVariants({
                              className: "project-lifecycle__format-tag",
                            })}
                          >
                            <span>{title}</span>
                            <span className="project-lifecycle__format-extension">
                              {format.extension}
                            </span>
                            {hit_count > 0 ? <Badge tone="brand">{hit_count}</Badge> : null}
                          </li>
                        }
                      />
                      <TooltipContent className="flex-col items-start gap-1">
                        {descriptions.map((description) => (
                          <span key={description}>{description}</span>
                        ))}
                      </TooltipContent>
                    </Tooltip>
                  );
                })}
            </ul>
          </section>
        );
      })}
      {props.plugins !== undefined && props.plugins.length > 0 ? (
        <section className="project-lifecycle__format-group" aria-labelledby={`${id_prefix}-plugins`}>
          <h3 id={`${id_prefix}-plugins`} className="project-lifecycle__section-title">
            {t("project.formats.plugin_title")}
          </h3>
          <p className="project-lifecycle__notice-text">
            {t("project.formats.plugin_hint")}
          </p>
          <ul aria-labelledby={`${id_prefix}-plugins`}>
            {props.plugins.map((plugin) => (
              <li key={plugin.id}>
                <span>{plugin.name}</span>
                <span className="project-lifecycle__format-extension">v{plugin.version}</span>
                <button
                  type="button"
                  aria-pressed={plugin.enabled}
                  onClick={() => props.on_plugin_toggle?.(plugin.id, !plugin.enabled)}
                >
                  {t(
                    plugin.enabled
                      ? "project.formats.plugin_enabled"
                      : "project.formats.plugin_disabled",
                  )}
                </button>
              </li>
            ))}
          </ul>
          {props.diagnostics !== undefined && props.diagnostics.length > 0 ? (
            <div role="alert">
              <p>{t("project.formats.plugin_diagnostics")}</p>
              <ul>
                {props.diagnostics.map((diagnostic) => (
                  <li key={diagnostic.directory}>{diagnostic.message}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
