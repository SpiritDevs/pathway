import { RunId, ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  turnItemIsWorkspacePreparation,
  workspacePreparationPresentation,
} from "./turnItemPresentation.ts";

function command(input: string): OrchestrationV2TurnItem {
  const now = DateTime.makeUnsafe("2026-08-03T00:00:00.000Z");
  return {
    id: TurnItemId.make("item-command"),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Workspace ready",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input,
    output: "Workspace preparation completed.",
    exitCode: 0,
  };
}

describe("turnItemIsWorkspacePreparation", () => {
  it("identifies the synthetic workspace preparation command", () => {
    expect(turnItemIsWorkspacePreparation(command("Preparing workspace"))).toBe(true);
    expect(turnItemIsWorkspacePreparation(command("prepare workspace"))).toBe(false);
  });
});

describe("workspacePreparationPresentation", () => {
  function preparation(
    overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> = {},
  ) {
    const item = command("Preparing workspace");
    if (item.type !== "command_execution") throw new Error("Expected command");
    return {
      ...item,
      status: "running" as const,
      workspacePreparation: { phase: "worktree" as const, workspaceKind: "worktree" as const },
      ...overrides,
    };
  }
  it("uses server milestones while checkout is running", () => {
    const result = workspacePreparationPresentation(preparation());
    expect(result.title).toBe("Creating a worktree");
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "running", "pending"]);
  });
  it("keeps future stages pending after a checkout failure", () => {
    const result = workspacePreparationPresentation(preparation({ status: "failed" }));
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "failed", "pending"]);
  });
  it("shows interruption without claiming checkout succeeded", () => {
    const result = workspacePreparationPresentation(preparation({ status: "interrupted" }));
    expect(result.steps.map((step) => step.status)).toEqual(["completed", "stopped", "pending"]);
  });
  it("omits checkout for local and existing workspaces", () => {
    for (const workspaceKind of ["root", "existing_worktree"] as const) {
      const result = workspacePreparationPresentation(
        preparation({ workspacePreparation: { phase: "setup", workspaceKind } }),
      );
      expect(result.steps.map((step) => step.label)).toEqual([
        "Preparing workspace",
        "Starting setup script",
      ]);
    }
  });
  it("distinguishes a launched script from no setup script", () => {
    const withoutScript = workspacePreparationPresentation(
      preparation({
        status: "completed",
        workspacePreparation: { phase: "setup", workspaceKind: "worktree" },
      }),
    );
    expect(withoutScript.title).toBe("Worktree created");
    expect(withoutScript.steps[2]?.label).toBe("No setup script configured");
    const withScript = workspacePreparationPresentation(
      preparation({
        status: "completed",
        workspacePreparation: { phase: "setup", workspaceKind: "worktree", terminalId: "setup-1" },
      }),
    );
    expect(withScript.steps[2]?.label).toBe("Starting setup script");
    expect(withScript.steps.every((step) => step.status === "completed")).toBe(true);
  });
  it("still renders preparation history from older servers", () => {
    const result = workspacePreparationPresentation(
      preparation({ workspacePreparation: undefined, title: "Starting setup script" }),
    );
    expect(result.steps.at(-1)?.status).toBe("running");
  });
});
