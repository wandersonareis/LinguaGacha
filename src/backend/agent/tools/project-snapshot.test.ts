import { describe, expect, it, vi } from "vitest";

import { agent_tool_call } from "../../../test/agent-tool-fixture";
import { AgentToolError } from "../tool-definition";
import { create_agent_project_snapshot_tool } from "./project-snapshot";

describe("project_snapshot", () => {
  it("列出快照并把精确文件名和范围交给恢复入口", async () => {
    const list = vi.fn(async () => ({
      directory: "E:/backups",
      limit: 5,
      latest: {
        file: "snapshot.lg",
        created_at: "2026-11-09T18:00:00.000Z",
        reason: "before-agent-apply" as const,
        app_version: "1.2.3",
        size: 42,
        kind: "full" as const,
        project_hash: "hash",
        fingerprint: "fp",
        anchor: false,
        protect: true,
        task: "task",
      },
      count: 1,
    }));
    const restore = vi.fn(async () => ({ restored: "snapshot.lg", safety_snapshot: null }));
    const create = vi.fn(async () => null);
    const rollback = vi.fn(async () => ({ restored: "snapshot.lg", scope: "translations" }));
    const restoreAnchor = vi.fn(async () => ({ restored: "anchor.lg", scope: "translations" }));
    const tool = create_agent_project_snapshot_tool({
      project: { list, create, rollback, restoreAnchor, restore },
    });

    const listed = await tool.execute({ action: "list" }, ...agent_tool_call("snapshot-list"));
    expect(listed.details).toMatchObject({ limit: 5, count: 1 });

    const created = await tool.execute({ action: "create" }, ...agent_tool_call("snapshot-create"));
    expect(create).toHaveBeenCalledOnce();
    expect(created.details).toEqual({ created: null });

    await tool.execute({ action: "rollback" }, ...agent_tool_call("snapshot-rollback"));
    expect(rollback).toHaveBeenCalledOnce();

    await tool.execute(
      { action: "restore_anchor", scope: "project" },
      ...agent_tool_call("snapshot-anchor"),
    );
    expect(restoreAnchor).toHaveBeenCalledWith("project", undefined);

    const restored = await tool.execute(
      { action: "restore", file: "snapshot.lg", scope: "translations" },
      ...agent_tool_call("snapshot-restore"),
    );
    expect(restore).toHaveBeenCalledWith("snapshot.lg", "translations", undefined);
    expect(restored.details).toMatchObject({ restored: "snapshot.lg" });
  });

  it("restore 缺少文件时拒绝调用", async () => {
    const tool = create_agent_project_snapshot_tool({
      project: {
        list: vi.fn(),
        create: vi.fn(),
        rollback: vi.fn(),
        restoreAnchor: vi.fn(),
        restore: vi.fn(),
      },
    });
    await expect(
      tool.execute({ action: "restore" }, ...agent_tool_call("missing")),
    ).rejects.toThrow(AgentToolError);
  });
});
