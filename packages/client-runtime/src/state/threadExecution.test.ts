import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type OrchestrationV2RunStatus,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  deriveLatestThreadRun,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  deriveThreadRuntimeRun,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it.each(["running", "waiting", "completed"] as const)(
    "reports the run's account instead of the thread default while %s",
    (status) => {
      const workInstanceId = ProviderInstanceId.make("codex_work");
      const workRun = { ...run("work-run", 2, status), providerInstanceId: workInstanceId };
      const projection = {
        ...v2Projection,
        runs: [run("personal-run", 1, "completed"), workRun],
      };

      expect(deriveThreadRuntime(projection)?.providerInstanceId).toBe(workInstanceId);
      expect(projection.thread.providerInstanceId).not.toBe(workInstanceId);
    },
  );

  it("keeps the attached account and model after completion with another account queued", () => {
    const workInstanceId = ProviderInstanceId.make("codex_work");
    const providerThreadId = ProviderThreadId.make("work-provider-thread");
    const workRun = {
      ...run("work-run", 1, "completed"),
      providerInstanceId: workInstanceId,
      providerThreadId,
      modelSelection: { instanceId: workInstanceId, model: "gpt-5.3-codex-spark" },
    };
    const projection = {
      ...v2Projection,
      thread: { ...v2Projection.thread, activeProviderThreadId: providerThreadId },
      runs: [workRun, run("queued-personal-run", 2, "queued")],
    };

    expect(deriveThreadRuntime(projection)?.providerInstanceId).toBe(workInstanceId);
    expect(deriveThreadRuntimeRun(projection)?.modelSelection).toEqual(workRun.modelSelection);
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = {
      ...run("run-running", 1, "running"),
      providerInstanceId: ProviderInstanceId.make("codex_work"),
    };
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
      providerInstanceId: runningRun.providerInstanceId,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps checkpoint-wait activity visible without exposing a non-functional interrupt", () => {
    const waitingRun = run("run-waiting", 1, "waiting");
    const projection = { ...v2Projection, runs: [waitingRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: waitingRun.id,
      status: "waiting",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "waiting",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("does not expose a stale active run after the runtime parks at idle", () => {
    const runtime = {
      status: "idle" as const,
      activeRunId: RunId.make("run-stale"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it.each(["preparing", "starting"] as const)("keeps an active %s run interruptible", (status) => {
    const runtime = {
      status,
      activeRunId: RunId.make(`run-${status}`),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });
});
