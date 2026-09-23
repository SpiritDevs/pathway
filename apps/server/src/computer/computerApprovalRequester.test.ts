import { assert, it } from "@effect/vitest";
import { CommandId, EventId } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import * as ComputerApprovalGate from "./ComputerApprovalGate.ts";
import {
  ComputerApprovalsTestLayer,
  pendingComputerRequest,
  seedRunningTurn,
} from "./computerApprovals.testkit.ts";

it.layer(ComputerApprovalsTestLayer)("computerApprovalRequester", (it) => {
  it.effect("posts a Computer card and routes the user's answer to the waiting call", () =>
    Effect.gen(function* () {
      const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
      const orchestrator = yield* OrchestratorV2;
      const { threadId, runId } = yield* seedRunningTurn("approve");
      const waiting = yield* Effect.forkChild(
        gate.authorizeAction({
          threadId,
          turnId: runId,
          callKey: "computer_click:{}",
          toolName: "computer_click",
          autonomy: "supervised",
        }),
      );
      const { request, projection } = yield* pendingComputerRequest(threadId);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
      );
      assert.equal(item?.type === "approval_request" ? item.requestKind : null, "computer");
      assert.equal(
        item?.type === "approval_request" ? item.prompt : null,
        "Computer action needs approval: computer_click",
      );

      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("approve-respond"),
        threadId,
        requestId: request.id,
        decision: "accept",
      });
      assert.equal(yield* Fiber.join(waiting), "approved");
    }),
  );

  it.effect("settles the card when the user declines", () =>
    Effect.gen(function* () {
      const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
      const orchestrator = yield* OrchestratorV2;
      const { threadId, runId } = yield* seedRunningTurn("decline");
      const waiting = yield* Effect.forkChild(
        gate.authorizeAction({
          threadId,
          turnId: runId,
          callKey: "computer_click:{}",
          toolName: "computer_click",
          autonomy: "per-task",
        }),
      );
      const { request, projection } = yield* pendingComputerRequest(threadId);
      const item = projection.turnItems.find(
        (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
      );
      assert.equal(
        item?.type === "approval_request" ? item.prompt : null,
        "Allow Computer for this task",
      );
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("decline-respond"),
        threadId,
        requestId: request.id,
        decision: "decline",
      });
      assert.equal(yield* Fiber.join(waiting), "denied");
      // The answer settles the card in the same command.
      const settled = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
        (candidate) => candidate.id === request.id,
      );
      assert.equal(settled?.status, "resolved");
    }),
  );

  it.effect("marks a cancelled card cancelled, not resolved", () =>
    Effect.gen(function* () {
      const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
      const orchestrator = yield* OrchestratorV2;
      const { threadId, runId } = yield* seedRunningTurn("cancel");
      const waiting = yield* Effect.forkChild(
        gate.authorizeAction({
          threadId,
          turnId: runId,
          callKey: "computer_click:{}",
          toolName: "computer_click",
          autonomy: "supervised",
        }),
      );
      const { request } = yield* pendingComputerRequest(threadId);
      yield* orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("cancel-respond"),
        threadId,
        requestId: request.id,
        decision: "cancel",
      });
      assert.equal(yield* Fiber.join(waiting), "denied");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.runtimeRequests.find((candidate) => candidate.id === request.id)?.status,
        "cancelled",
      );
      const card = projection.turnItems.find(
        (item) => item.type === "approval_request" && item.requestId === request.id,
      );
      assert.equal(card?.status, "cancelled");
    }),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "withdraws the card when its run ends %s",
    (status) =>
      Effect.gen(function* () {
        const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
        const orchestrator = yield* OrchestratorV2;
        const eventSink = yield* EventSinkV2;
        const { threadId, runId } = yield* seedRunningTurn(`ended-${status}`);
        const waiting = yield* Effect.forkChild(
          gate.authorizeAction({
            threadId,
            turnId: runId,
            callKey: "computer_click:{}",
            toolName: "computer_click",
            autonomy: "supervised",
          }),
        );
        const { request, projection } = yield* pendingComputerRequest(threadId);
        const withdrawn = yield* eventSink
          .stream({ threadId, afterSequence: yield* eventSink.latestSequence({ threadId }) })
          .pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "runtime-request.updated" &&
                event.payload.id === request.id &&
                event.payload.status !== "pending",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
        const run = projection.runs.find((candidate) => candidate.id === runId);
        assert.isDefined(run);
        const now = yield* DateTime.now;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`ended-${status}-run-end`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...run, status, completedAt: now },
            },
          ],
        });

        assert.equal(yield* Fiber.join(waiting), "denied");
        yield* Fiber.join(withdrawn);
        const settled = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          settled.runtimeRequests.find((candidate) => candidate.id === request.id)?.status,
          "cancelled",
        );
        const card = settled.turnItems.find(
          (item) => item.type === "approval_request" && item.requestId === request.id,
        );
        assert.equal(card?.status, "cancelled");
      }),
  );

  it.effect("refuses an answer to a card the gate no longer holds", () =>
    Effect.gen(function* () {
      const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
      const orchestrator = yield* OrchestratorV2;
      const { threadId, runId } = yield* seedRunningTurn("stale");
      const waiting = yield* Effect.forkChild(
        gate.request({
          threadId,
          turnId: runId,
          callKey: "computer_read_clipboard:{}",
          toolName: "computer_read_clipboard",
        }),
      );
      const { request } = yield* pendingComputerRequest(threadId);
      yield* TestClock.adjust(ComputerApprovalGate.COMPUTER_APPROVAL_WAIT_BOUND);
      assert.equal(yield* Fiber.join(waiting), "pending");
      yield* gate.cancelThread(threadId);

      const answered = yield* orchestrator
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make("stale-respond"),
          threadId,
          requestId: request.id,
          decision: "accept",
        })
        .pipe(Effect.exit);
      // The withdrawal may already have settled the card, or the gate refuses it.
      assert.isTrue(Exit.isFailure(answered));
    }),
  );

  it.effect("refuses to post a card for a turn that is not running", () =>
    Effect.gen(function* () {
      const gate = yield* ComputerApprovalGate.ComputerApprovalGate;
      const { threadId } = yield* seedRunningTurn("gone");
      const outcome = yield* gate
        .authorizeAction({
          threadId,
          turnId: "gone-other-run",
          callKey: "computer_click:{}",
          toolName: "computer_click",
          autonomy: "supervised",
        })
        .pipe(Effect.flip);
      assert.equal(outcome._tag, "ComputerApprovalPublishError");
    }),
  );
});
