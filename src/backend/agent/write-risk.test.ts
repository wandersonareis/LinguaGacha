import { describe, expect, it } from "vitest";

import type { AgentWorkspaceWriteRisk } from "./workspace/approval";
import {
  acknowledge_agent_write_risk,
  accumulate_agent_write_risk,
  type AgentWriteRiskState,
} from "./write-risk";

function same_dst_risk(count: number, text = "Same text", project = 100_000): AgentWorkspaceWriteRisk {
  return {
    total: count,
    dst_counts: [{ text, count }],
    project_item_count: project,
  };
}

describe("accumulate_agent_write_risk", () => {
  it("só interrompe o automático quando o acumulado cruza o limite", () => {
    const first = accumulate_agent_write_risk(null, "round-1", same_dst_risk(60));
    expect(first.cumulative).toMatchObject({ total: 60, same_dst: 60, risky: false });
    expect(first.requires_approval).toBe(false);

    const second = accumulate_agent_write_risk(
      acknowledge_agent_write_risk(first),
      "round-1",
      same_dst_risk(60),
    );
    expect(second.cumulative).toMatchObject({ total: 120, same_dst: 120, risky: true });
    expect(second.requires_approval).toBe(true);
  });

  it("não repete a aprovação para o mesmo valor já confirmado", () => {
    const risky = accumulate_agent_write_risk(null, "round-1", same_dst_risk(120));
    expect(risky.requires_approval).toBe(true);

    const acknowledged = acknowledge_agent_write_risk(risky);
    const next = accumulate_agent_write_risk(acknowledged, "round-1", same_dst_risk(20));
    expect(next.cumulative).toMatchObject({ total: 140, same_dst: 140, risky: true });
    expect(next.requires_approval).toBe(false);
  });

  it("volta a pedir quando um novo valor passa a dominar", () => {
    const first = accumulate_agent_write_risk(null, "round-1", same_dst_risk(100, "A"));
    const acknowledged = acknowledge_agent_write_risk(first);
    const second = accumulate_agent_write_risk(acknowledged, "round-1", same_dst_risk(100, "B"));
    expect(second.requires_approval).toBe(false); // A 100 vs B 100: empate resolvido por texto

    const third = accumulate_agent_write_risk(second.state, "round-1", same_dst_risk(800, "B"));
    expect(third.cumulative.top_dst).toEqual({ text: "B", count: 900 });
    expect(third.requires_approval).toBe(true);
  });

  it("confirma uma vez a proporção do projeto e não repete na mesma rodada", () => {
    const unique = Array.from({ length: 100 }, (_, index) => ({
      text: `value-${index}`,
      count: 1,
    }));
    const first = accumulate_agent_write_risk(null, "round-1", {
      total: 100,
      dst_counts: unique,
      project_item_count: 200,
    });
    expect(first.project_risky).toBe(true);
    expect(first.requires_approval).toBe(true);

    const next = accumulate_agent_write_risk(
      acknowledge_agent_write_risk(first),
      "round-1",
      { total: 10, dst_counts: unique.slice(0, 10), project_item_count: 200 },
    );
    expect(next.project_risky).toBe(true);
    expect(next.requires_approval).toBe(false);
  });

  it("isola a rodada e reinicia o acumulado", () => {
    const first = accumulate_agent_write_risk(null, "round-1", same_dst_risk(120));
    const next = accumulate_agent_write_risk(first.state, "round-2", null);
    expect(next.cumulative.total).toBe(0);
    expect(next.cumulative.risky).toBe(false);
    expect(next.state.round_id).toBe("round-2");
  });

  it("mantém o estado anterior quando nenhum risco é informado", () => {
    const first = accumulate_agent_write_risk(null, "round-1", same_dst_risk(20));
    const state: AgentWriteRiskState = first.state;
    const next = accumulate_agent_write_risk(state, "round-1", null);
    expect(next.cumulative.total).toBe(20);
    expect(next.requires_approval).toBe(false);
  });
});
