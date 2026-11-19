import { Activity, type ComponentType, type JSX } from "react";

import { SCREEN_REGISTRY } from "./screen-registry";
import type { RouteId } from "./types";

type ScreenOutletProps = {
  selected_route: RouteId;
  active_component: ComponentType;
};

/**
 * Agent 页面跨路由保留 DOM 和局部状态，避免返回时重新解析长对话的 Markdown；
 * 其余路由保持按当前路由卸载，避免隐藏的大表格和编辑器长期占用内存。
 */
export function ScreenOutlet(props: ScreenOutletProps): JSX.Element {
  const AgentScreen = SCREEN_REGISTRY.agent.component;
  const ActiveScreen = props.active_component;
  const agent_active = props.selected_route === "agent";

  return (
    <>
      <Activity mode={agent_active ? "visible" : "hidden"}>
        <AgentScreen />
      </Activity>
      {agent_active ? null : <ActiveScreen />}
    </>
  );
}
