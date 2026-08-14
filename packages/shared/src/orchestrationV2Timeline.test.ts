import { NodeId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildOrchestrationErrorFixPrompt,
  isOrchestrationV2TurnItemVisible,
} from "./orchestrationV2Timeline.ts";

const runId = RunId.make("run:timeline-visibility");
const nodeId = NodeId.make("node:timeline-visibility");

describe("buildOrchestrationErrorFixPrompt", () => {
  it("places a short fix request before the structured error context", () => {
    const prompt = buildOrchestrationErrorFixPrompt({
      id: "error-1",
      threadId: "thread-1",
      runId,
      nodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "failed",
      title: "Workspace preparation failed",
      startedAt: null,
      completedAt: null,
      updatedAt: null,
      type: "error",
      failure: {
        class: "validation_error",
        message: "Git command exited with a non-zero status.",
        code: null,
        retryable: false,
      },
    } as never);

    expect(prompt).toMatch(/^Please investigate and fix this error\.\n\nError context:\n{/);
    expect(prompt).toContain('"title": "Workspace preparation failed"');
    expect(prompt).toContain('"message": "Git command exited with a non-zero status."');
  });
});

describe("isOrchestrationV2TurnItemVisible", () => {
  it("hides unpaired interruption results from superseded attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps paired interruption results from superseded attempts", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "running" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "superseded" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts without a request", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps interruption results from terminal attempts with a request", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [{ runId, rootNodeId: nodeId, status: "interrupted" }],
        items: [
          { type: "run_interrupt_request", runId, nodeId },
          { type: "run_interrupt_result", runId, nodeId },
        ],
      }),
    ).toBe(true);
  });

  it("hides queued user messages once their run is cancelled", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(false);
  });

  it("keeps queued user messages while their run is queued", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "queued_turn", runId, nodeId },
        runs: [{ id: runId, status: "queued" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "queued_turn", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("keeps non-queued user messages on cancelled runs", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "user_message", inputIntent: "turn_start", runId, nodeId },
        runs: [{ id: runId, status: "cancelled" }],
        attempts: [],
        items: [{ type: "user_message", inputIntent: "turn_start", runId, nodeId }],
      }),
    ).toBe(true);
  });

  it("does not hide an interruption because another attempt was superseded", () => {
    expect(
      isOrchestrationV2TurnItemVisible({
        item: { type: "run_interrupt_result", runId, nodeId },
        runs: [{ id: runId, status: "interrupted" }],
        attempts: [
          {
            runId,
            rootNodeId: NodeId.make("node:timeline-visibility:older"),
            status: "superseded",
          },
          { runId, rootNodeId: nodeId, status: "interrupted" },
        ],
        items: [{ type: "run_interrupt_result", runId, nodeId }],
      }),
    ).toBe(true);
  });
});
