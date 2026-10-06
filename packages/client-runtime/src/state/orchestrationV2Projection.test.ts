import { describe, expect, it } from "vite-plus/test";
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

const now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const threadId = ThreadId.make("thread-reducer");
const runId = RunId.make("run-reducer");
const run = {
  id: runId,
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  providerThreadId: null,
  userMessageId: MessageId.make("message-reducer"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
} satisfies OrchestrationV2Run;

function commandItem(
  id: string,
  output = "done",
  ordinal = 1,
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> {
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "pwd",
    output,
    exitCode: 0,
  };
}
const emptyProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("project-reducer"),
    title: "Reducer",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: now,
} as OrchestrationV2ThreadProjection;

describe("applyOrchestrationV2ProjectionEvent", () => {
  it("does not revisit historical visible rows during a streamed item update", () => {
    const oldItem = commandItem("old-item");
    let historicalReads = 0;
    const oldRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: oldItem.id,
      get item() {
        historicalReads += 1;
        return oldItem;
      },
    };
    const current = commandItem("current-item", "first", 2);
    const currentRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: current.id,
      item: current,
    };
    const projection = {
      ...emptyProjection,
      runs: [run, { ...run, id: RunId.make("old-cancelled-run"), status: "cancelled" as const }],
      turnItems: [oldItem, current],
      visibleTurnItems: [oldRow, currentRow],
    };
    const next = applyOrchestrationV2ProjectionEvent(projection, {
      id: EventId.make("stream-update"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: { ...current, output: "second" },
    });
    expect(historicalReads).toBe(0);
    expect(next?.visibleTurnItems[0]).toBe(oldRow);
    expect(next?.visibleTurnItems[1]?.item).toMatchObject({ output: "second" });
  });

  it("does not sweep history when a run updates without a hiding transition", () => {
    const item = commandItem("historical-item");
    let historicalReads = 0;
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      get item() {
        historicalReads += 1;
        return item;
      },
    };
    const cancelled = { ...run, id: RunId.make("cancelled-run"), status: "cancelled" as const };
    const projection = { ...emptyProjection, runs: [run, cancelled], visibleTurnItems: [row] };
    for (const payload of [run, cancelled]) {
      const next = applyOrchestrationV2ProjectionEvent(projection, {
        id: EventId.make("run-update"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload,
      });
      expect(next?.visibleTurnItems).toBe(projection.visibleTurnItems);
    }
    expect(historicalReads).toBe(0);
  });

  it("sweeps superseded interrupt results once while retaining paired stop requests", () => {
    const nodeId = NodeId.make("superseded-node");
    const attempt = {
      id: RunAttemptId.make("attempt"),
      runId,
      attemptOrdinal: 1,
      rootNodeId: nodeId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: ProviderThreadId.make("provider-thread"),
      providerTurnId: null,
      reason: "initial" as const,
      status: "interrupted" as const,
      startedAt: now,
      completedAt: now,
    };
    const result: OrchestrationV2TurnItem = {
      ...commandItem("interrupt-result"),
      nodeId,
      type: "run_interrupt_result",
      message: "Stopped",
    };
    const request: OrchestrationV2TurnItem = {
      ...commandItem("interrupt-request", "", 2),
      nodeId,
      type: "run_interrupt_request",
      message: "Stop",
    };
    const row = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: result.id,
      item: result,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      attempts: [attempt],
      turnItems: [result],
      visibleTurnItems: [row],
    };
    const event = {
      id: EventId.make("supersede"),
      type: "run-attempt.updated" as const,
      threadId,
      occurredAt: now,
      payload: { ...attempt, status: "superseded" as const },
    };
    const next = applyOrchestrationV2ProjectionEvent(projection, event)!;
    expect(next.visibleTurnItems).toEqual([]);
    expect(applyOrchestrationV2ProjectionEvent(next, event)?.visibleTurnItems).toBe(
      next.visibleTurnItems,
    );
    expect(
      applyOrchestrationV2ProjectionEvent({ ...projection, turnItems: [result, request] }, event)
        ?.visibleTurnItems,
    ).toBe(projection.visibleTurnItems);
    const lateUpdate = applyOrchestrationV2ProjectionEvent(next, {
      id: EventId.make("late-interrupt-update"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: { ...result, message: "Still stopped" },
    });
    expect(lateUpdate?.visibleTurnItems).toEqual([]);
  });

  it("patches reported configuration without resetting titles or other metadata", () => {
    const updatedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const modelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-6-astra",
      options: [],
    };
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("event-reported-model"),
      type: "thread.model-reported",
      threadId,
      occurredAt: updatedAt,
      payload: { modelSelection },
    };
    const result = applyOrchestrationV2ProjectionEvent(emptyProjection, event);
    expect(result?.thread).toEqual({ ...emptyProjection.thread, modelSelection, updatedAt });
  });

  it("applies thread lifecycle payloads instead of leaving stale metadata", () => {
    const archivedAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
    const event = {
      id: "event-archive",
      type: "thread.archived",
      threadId,
      occurredAt: archivedAt,
      payload: { ...emptyProjection.thread, archivedAt, updatedAt: archivedAt },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(emptyProjection, event);
    expect(next?.thread.archivedAt).toEqual(archivedAt);
    expect(next?.updatedAt).toEqual(archivedAt);
  });

  it("ignores events for another thread", () => {
    const event = {
      id: "event-other",
      type: "thread.deleted",
      threadId: ThreadId.make("thread-other"),
      occurredAt: now,
      payload: { ...emptyProjection.thread, id: ThreadId.make("thread-other"), deletedAt: now },
    } as OrchestrationV2DomainEvent;

    expect(applyOrchestrationV2ProjectionEvent(emptyProjection, event)).toBe(emptyProjection);
  });

  it("preserves visible row identity when run updates do not change membership", () => {
    const item = commandItem("item-stable");
    const visibleTurnItems = [
      {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      },
    ];
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [item],
      visibleTurnItems,
    };
    const event = {
      id: "event-run-update",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "completed" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toBe(visibleTurnItems);
    expect(next?.visibleTurnItems[0]).toBe(visibleTurnItems[0]);
  });

  it("replaces only the updated visible item when membership is unchanged", () => {
    const first = commandItem("item-first", "first");
    const second = commandItem("item-second", "second");
    const firstRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: first.id,
      item: first,
    };
    const secondRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: second.id,
      item: second,
    };
    const updated = commandItem("item-first", "streamed output");
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [first, second],
      visibleTurnItems: [firstRow, secondRow],
    };
    const event = {
      id: "event-item-update",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: updated,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).not.toBe(projection.visibleTurnItems);
    expect(next?.visibleTurnItems[0]).not.toBe(firstRow);
    expect(next?.visibleTurnItems[0]?.item).toBe(updated);
    expect(next?.visibleTurnItems[1]).toBe(secondRow);
  });

  it("inserts live turn items by authoritative ordinal", () => {
    const queuedFuture = commandItem("item-queued-future", "queued", 300);
    const activeAssistant = commandItem("item-active-assistant", "done", 201);
    const queuedRow = {
      position: 0,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: queuedFuture.id,
      item: queuedFuture,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [queuedFuture],
      visibleTurnItems: [queuedRow],
    };
    const event = {
      id: "event-active-assistant",
      type: "turn-item.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: activeAssistant,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
      activeAssistant.id,
      queuedFuture.id,
    ]);
    expect(next?.visibleTurnItems.map((row) => row.position)).toEqual([0, 1]);
  });

  it("removes only hidden local items while preserving inherited rows", () => {
    const inherited = commandItem("item-inherited");
    const local = commandItem("item-local");
    const inheritedRow = {
      position: 0,
      visibility: "inherited" as const,
      sourceThreadId: ThreadId.make("thread-source"),
      sourceItemId: inherited.id,
      item: inherited,
    };
    const localRow = {
      position: 1,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: local.id,
      item: local,
    };
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: [local],
      visibleTurnItems: [inheritedRow, localRow],
    };
    const event = {
      id: "event-run-rollback",
      type: "run.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: { ...run, status: "rolled_back" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems).toEqual([inheritedRow]);
    expect(next?.visibleTurnItems[0]).toBe(inheritedRow);
  });

  it("inserts a new item between rows by ordinal", () => {
    const rows = [1, 5, 9].map((ordinal, position) => {
      const item = commandItem(`item-${ordinal}`, "done", ordinal);
      return {
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      };
    });
    const inserted = commandItem("item-7", "done", 7);
    const projection = {
      ...emptyProjection,
      runs: [run],
      turnItems: rows.map((row) => row.item),
      visibleTurnItems: rows,
    };
    const event = {
      id: "event-insert",
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: inserted,
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.ordinal)).toEqual([1, 5, 7, 9]);
    expect(next?.visibleTurnItems.map((row) => row.position)).toEqual([0, 1, 2, 3]);
    expect(next?.visibleTurnItems[0]).toBe(rows[0]);
  });

  it("hides a cancelled queued message while keeping other rows of that run", () => {
    const cancelledRunId = RunId.make("run-cancelled");
    const kept = commandItem("item-kept", "done", 1);
    const queued: OrchestrationV2TurnItem = {
      ...commandItem("item-queued", "done", 2),
      runId: cancelledRunId,
      type: "user_message",
      messageId: MessageId.make("message-queued"),
      inputIntent: "queued_turn",
      text: "later",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    };
    const sibling = { ...commandItem("item-sibling", "done", 3), runId: cancelledRunId };
    const rows = [kept, queued, sibling].map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));
    const cancelledRun = { ...run, id: cancelledRunId, ordinal: 2, status: "queued" as const };
    const projection = {
      ...emptyProjection,
      runs: [run, cancelledRun],
      turnItems: [kept, queued, sibling],
      visibleTurnItems: rows,
    };
    const event = {
      id: "event-cancel",
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...cancelledRun, status: "cancelled" },
    } as OrchestrationV2DomainEvent;

    const next = applyOrchestrationV2ProjectionEvent(projection, event);
    expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([kept.id, sibling.id]);
    expect(next?.visibleTurnItems[0]).toBe(rows[0]);
  });
});
