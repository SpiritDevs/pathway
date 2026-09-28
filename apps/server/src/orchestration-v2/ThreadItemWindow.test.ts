import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

import { threadItemsBefore, windowThreadProjection } from "./ThreadItemWindow.ts";

const threadId = ThreadId.make("thread:item-window");
const providerInstanceId = ProviderInstanceId.make("codex");
const at = DateTime.makeUnsafe("2026-09-29T09:00:00.000Z");

function row(position: number): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`turn-item:${position}`);
  return {
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: id,
    item: {
      id,
      threadId,
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: position,
      status: "completed",
      title: "Forked from conversation",
      startedAt: null,
      completedAt: at,
      updatedAt: at,
      type: "fork",
      forkKind: "manual",
      source: { type: "run", threadId, runId: RunId.make("run:source") },
      targetThreadId: threadId,
    },
  };
}

function projection(count: number): OrchestrationV2ThreadProjection {
  const visibleTurnItems = Array.from({ length: count }, (_, position) => row(position));
  return {
    thread: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:item-window"),
      title: "Long thread",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
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
    turnItems: visibleTurnItems.map(({ item }) => item),
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: at,
  };
}

const positions = (rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) =>
  rows.map((row) => row.position);

it("windows a long thread to its latest items and pages back to the start", () => {
  const full = projection(7);
  const window = windowThreadProjection(full, 3);
  assert.deepStrictEqual(positions(window.projection.visibleTurnItems), [4, 5, 6]);
  assert.deepStrictEqual(window.projection.turnItems, []);
  assert.strictEqual(window.olderItemsBefore, 4);

  const middle = threadItemsBefore(full, 4, 3);
  assert.deepStrictEqual(positions(middle.items), [1, 2, 3]);
  assert.strictEqual(middle.olderItemsBefore, 1);

  const start = threadItemsBefore(full, 1, 3);
  assert.deepStrictEqual(positions(start.items), [0]);
  assert.strictEqual(start.olderItemsBefore, undefined);
});

it("marks a short thread as complete", () => {
  const window = windowThreadProjection(projection(3), 3);
  assert.deepStrictEqual(positions(window.projection.visibleTurnItems), [0, 1, 2]);
  assert.strictEqual(window.olderItemsBefore, undefined);
});
