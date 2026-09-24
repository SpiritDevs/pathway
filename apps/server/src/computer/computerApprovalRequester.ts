/**
 * Posts Computer approval cards as orchestration runtime requests (ADR 0048).
 *
 * A card is an ordinary pending `approval_request` of kind `computer` on the
 * caller's active run, so every client renders and answers it the way it
 * answers a provider approval. No provider is waiting on it: the orchestrator
 * routes the answer to `ComputerApprovalGate.respond` through
 * `ServerOwnedRuntimeRequests` and resolves the card in the same command.
 * `resolve` here covers the rest - Stop, turn boundaries and timeouts
 * withdrawing a card nobody answered - and skips a card already settled.
 *
 * @module computer/computerApprovalRequester
 */
import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
  RuntimeRequestId,
  ThreadId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerOwnedRuntimeRequests } from "../orchestration-v2/ServerOwnedRuntimeRequests.ts";
import {
  ComputerApprovalGate,
  type ComputerApprovalPrompt,
  ComputerApprovalPublishError,
  ComputerApprovalRequester,
} from "./ComputerApprovalGate.ts";

/** The line the card shows; `detail` is already display-safe (no typed text). */
export function computerApprovalCardText(prompt: ComputerApprovalPrompt): string {
  switch (prompt.scope) {
    case "task":
      return "Allow Computer for this task";
    case "app":
      // Without a named app the answer is task consent; the card must not
      // read "another app" as an app's name.
      return prompt.app === undefined
        ? "Allow Computer for this task"
        : `Allow Computer to use ${prompt.app} in this task`;
    case "call":
      return prompt.detail === undefined
        ? `Computer action needs approval: ${prompt.toolName}`
        : `Computer action needs approval: ${prompt.toolName} ${prompt.detail}`;
  }
}

const publishError = (message: string, cause?: unknown) =>
  new ComputerApprovalPublishError({ message, ...(cause === undefined ? {} : { cause }) });

const asPublishError = (message: string) => (cause: unknown) =>
  Schema.is(ComputerApprovalPublishError)(cause) ? cause : publishError(message, cause);

export const makeComputerApprovalRequester = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSinkV2;
  const ids = yield* IdAllocatorV2;

  const commandIdFor = (prompt: ComputerApprovalPrompt, step: string) =>
    CommandId.make(`command:computer-approval:${prompt.requestId}:${step}`);

  const open = Effect.fn("ComputerApprovalRequester.open")(
    function* (prompt: ComputerApprovalPrompt) {
      const threadId = ThreadId.make(prompt.threadId);
      const projection = yield* projections.getThreadProjection(threadId);
      const run = projection.runs.find((candidate) => candidate.id === prompt.turnId);
      const attempt =
        run?.activeAttemptId == null
          ? undefined
          : projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      if (run === undefined || attempt === undefined) {
        return yield* publishError("The turn asking for Computer approval is no longer running.");
      }
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === attempt.providerThreadId,
      );
      if (providerThread?.providerSessionId == null) {
        return yield* publishError("The turn asking for Computer approval has no live session.");
      }
      const now = yield* DateTime.now;
      const requestId = RuntimeRequestId.make(prompt.requestId);
      const nodeId = ids.derive.approvalNode({ requestId });
      const node: OrchestrationV2ExecutionNode = {
        id: nodeId,
        threadId,
        runId: run.id,
        parentNodeId: attempt.rootNodeId,
        rootNodeId: attempt.rootNodeId,
        kind: "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: attempt.providerThreadId,
        providerTurnId: attempt.providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const request: OrchestrationV2RuntimeRequest = {
        id: requestId,
        nodeId,
        providerTurnId: attempt.providerTurnId,
        nativeRequestRef: null,
        kind: "computer",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: providerThread.providerSessionId },
        createdAt: now,
        resolvedAt: null,
      };
      const turnItem: OrchestrationV2TurnItem = {
        id: ids.derive.approvalTurnItem({ requestId }),
        threadId,
        runId: run.id,
        nodeId,
        providerThreadId: attempt.providerThreadId,
        providerTurnId: attempt.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "approval_request",
        requestId,
        requestKind: "computer",
        prompt: computerApprovalCardText(prompt),
      };
      const commandId = commandIdFor(prompt, "open");
      const event = ids.allocate.event({ threadId, commandId });
      const base = {
        threadId,
        runId: run.id,
        nodeId,
        driver: providerThread.driver,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
      };
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        { ...base, id: yield* event, type: "node.updated", payload: node },
        { ...base, id: yield* event, type: "runtime-request.updated", payload: request },
        { ...base, id: yield* event, type: "turn-item.updated", payload: turnItem },
      ];
      const written = yield* eventSink.writeIfRunCurrent({
        commandId,
        threadId,
        runId: run.id,
        activeAttemptId: attempt.id,
        expectedStatus: run.status,
        events,
      });
      if (!written.committed) {
        return yield* publishError("The turn asking for Computer approval moved on.");
      }
    },
    Effect.mapError(asPublishError("The approval card could not be posted.")),
  );

  const resolve = Effect.fn("ComputerApprovalRequester.resolve")(
    function* (prompt: ComputerApprovalPrompt, decision: ProviderApprovalDecision) {
      const threadId = ThreadId.make(prompt.threadId);
      const projection = yield* projections.getThreadProjection(threadId);
      const request = projection.runtimeRequests.find(
        (candidate) => candidate.id === prompt.requestId,
      );
      // Never posted, or already settled: nothing to withdraw.
      if (request === undefined || request.status !== "pending") return;
      const now = yield* DateTime.now;
      const accepted = decision === "accept";
      const node = projection.nodes.find((candidate) => candidate.id === request.nodeId);
      const turnItem = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request.id,
      );
      const commandId = commandIdFor(prompt, "resolve");
      const event = ids.allocate.event({ threadId, commandId });
      const base = {
        threadId,
        ...(node?.runId == null ? {} : { runId: node.runId }),
        nodeId: request.nodeId,
        occurredAt: now,
      };
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          ...base,
          id: yield* event,
          type: "runtime-request.updated",
          payload: {
            ...request,
            status: decision === "cancel" ? "cancelled" : "resolved",
            resolvedAt: now,
          },
        },
      ];
      if (node !== undefined) {
        events.push({
          ...base,
          id: yield* event,
          type: "node.updated",
          payload: { ...node, status: accepted ? "completed" : "cancelled", completedAt: now },
        });
      }
      if (turnItem !== undefined) {
        events.push({
          ...base,
          id: yield* event,
          type: "turn-item.updated",
          payload: {
            ...turnItem,
            status: accepted ? "completed" : "cancelled",
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      yield* eventSink.write({ commandId, events });
    },
    Effect.mapError(asPublishError("The approval card could not be settled.")),
  );

  return ComputerApprovalRequester.of({ open, resolve });
});

export const computerApprovalRequesterLayer = Layer.effect(
  ComputerApprovalRequester,
  makeComputerApprovalRequester,
);

/** Routes answers to Computer cards, and the end of their run, to the gate. */
export const computerServerOwnedRuntimeRequestsLayer = Layer.effect(
  ServerOwnedRuntimeRequests,
  Effect.gen(function* () {
    const gate = yield* ComputerApprovalGate;
    return {
      respond: ({ threadId, requestId, decision }) => gate.respond(threadId, requestId, decision),
      endRun: ({ threadId, runId }) => gate.endTurn(threadId, runId),
    };
  }),
);
