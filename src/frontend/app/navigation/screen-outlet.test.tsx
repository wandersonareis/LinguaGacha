import { act, useEffect, useState, type JSX } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ScreenOutlet } from "./screen-outlet";
import type { RouteId } from "./types";

const mounts = vi.hoisted(() => ({ agent: 0, other: 0 }));

// Agent 夹具由注册表提供，验证壳层只切换可见性而不替换组件实例。
vi.mock("./screen-registry", async () => {
  const { createElement, useEffect: use_effect, useState: use_state } = await import("react");

  function AgentScreen(): ReturnType<typeof createElement> {
    const [count, set_count] = use_state(0);
    use_effect(() => {
      mounts.agent += 1;
    }, []);
    return createElement(
      "button",
      {
        "data-testid": "agent-count",
        onClick: () => set_count((current) => current + 1),
      },
      count,
    );
  }

  return {
    SCREEN_REGISTRY: {
      agent: { component: AgentScreen, title_key: "agent_page.title" },
    },
  };
});

let root: Root;
let container: HTMLDivElement;

/** 普通页面每次进入都应重新挂载，用于对照 Agent 的保留行为。 */
function OtherScreen(): null {
  useEffect(() => {
    mounts.other += 1;
  }, []);
  return null;
}

function Harness(): JSX.Element {
  const [route, set_route] = useState<RouteId>("agent");
  return (
    <>
      <button data-testid="go-other" onClick={() => set_route("proofreading")} />
      <button data-testid="go-agent" onClick={() => set_route("agent")} />
      <ScreenOutlet selected_route={route} active_component={OtherScreen} />
    </>
  );
}

beforeEach(() => {
  mounts.agent = 0;
  mounts.other = 0;
  container = window.document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

it("Agent 跨路由保留实例，其他页面继续按路由卸载", async () => {
  await act(async () => root.render(<Harness />));
  expect(mounts.agent).toBe(1);

  const counter = container.querySelector<HTMLElement>('[data-testid="agent-count"]')!;
  await act(async () => counter.click());
  expect(counter.textContent).toBe("1");

  await act(async () => container.querySelector<HTMLElement>('[data-testid="go-other"]')!.click());
  expect(mounts.other).toBe(1);
  // Agent 的 DOM 仍在，普通页面的 DOM 已替换。
  expect(container.querySelector('[data-testid="agent-count"]')).not.toBeNull();

  await act(async () => container.querySelector<HTMLElement>('[data-testid="go-agent"]')!.click());
  // 局部状态证明实例被复用；Activity 显示时会重新建立 Effects。
  expect(container.querySelector('[data-testid="agent-count"]')?.textContent).toBe("1");
  expect(mounts.other).toBe(1);

  await act(async () => container.querySelector<HTMLElement>('[data-testid="go-other"]')!.click());
  expect(mounts.other).toBe(2);
});

it("返回 Agent 后保留局部状态", async () => {
  await act(async () => root.render(<Harness />));

  const counter = container.querySelector<HTMLElement>('[data-testid="agent-count"]')!;
  await act(async () => counter.click());
  await act(async () => counter.click());
  expect(counter.textContent).toBe("2");

  await act(async () => container.querySelector<HTMLElement>('[data-testid="go-other"]')!.click());
  await act(async () => container.querySelector<HTMLElement>('[data-testid="go-agent"]')!.click());

  expect(container.querySelector('[data-testid="agent-count"]')?.textContent).toBe("2");
});
