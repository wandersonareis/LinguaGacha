import { describe, expect, it } from "vitest";

import type { JsonRecord } from "../../../domain/json";
import {
  AGENT_PENDING_WRITE_SAMPLE_LIMIT,
  AGENT_PENDING_WRITE_TEXT_LIMIT,
} from "../../../shared/agent";
import type { ProjectItemWriteChange } from "../../project/project-write-request";
import { build_agent_write_preview, clip_agent_write_text } from "./write-preview";

function change(
  item_id: number,
  before: string,
  after: string,
): ProjectItemWriteChange {
  return {
    item_id,
    current: { dst: before, name_dst: "", status: "NONE" },
    next: { dst: after, name_dst: "", status: "PROCESSED" },
  };
}

function current(item_id: number, file_path: string): JsonRecord {
  return { item_id, src: `source ${item_id}`, file_path };
}

describe("build_agent_write_preview", () => {
  it("resume o valor repetido, os arquivos e uma amostra limitada", () => {
    const changes = Array.from({ length: 12 }, (_, index) =>
      change(index + 1, `old ${index + 1}`, "Same text"),
    );
    const current_items = changes.map((row) =>
      current(row.item_id, row.item_id <= 4 ? "a.po" : "b.po"),
    );

    const { preview, risk } = build_agent_write_preview({
      changes,
      current_items,
      project_item_count: 200,
    });

    expect(preview.total).toBe(12);
    expect(preview.file_total).toBe(2);
    expect(preview.files).toEqual([
      { path: "b.po", count: 8 },
      { path: "a.po", count: 4 },
    ]);
    expect(preview.distinct_dst).toBe(1);
    expect(preview.top_dst).toEqual({ text: "Same text", count: 12 });
    expect(preview.sample).toHaveLength(AGENT_PENDING_WRITE_SAMPLE_LIMIT);
    expect(preview.sample[0]).toEqual({
      item_id: 1,
      file_path: "a.po",
      src: "source 1",
      before: "old 1",
      after: "Same text",
    });
    expect(preview.truncated).toBe(true);
    expect(preview.cumulative).toBeNull();
    expect(risk).toEqual({
      total: 12,
      dst_counts: [{ text: "Same text", count: 12 }],
      project_item_count: 200,
    });
  });

  it("conta valores vazios e itens sem mudança", () => {
    const { preview } = build_agent_write_preview({
      changes: [change(1, "", ""), change(2, "old", "old"), change(3, "old", "")],
      current_items: [current(1, "a.po"), current(2, "a.po"), current(3, "a.po")],
      project_item_count: 10,
    });

    expect(preview.noop).toBe(2);
    expect(preview.empty).toBe(2);
    expect(preview.distinct_dst).toBe(2);
  });

  it("trunca textos longos no limite do evento", () => {
    const text = "x".repeat(AGENT_PENDING_WRITE_TEXT_LIMIT + 20);
    const clipped = clip_agent_write_text(text);

    expect(clipped).toHaveLength(AGENT_PENDING_WRITE_TEXT_LIMIT);
    expect(clipped.endsWith("…")).toBe(true);
  });
});
