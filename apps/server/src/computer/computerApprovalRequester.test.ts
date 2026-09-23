import { assert, it } from "@effect/vitest";
import { CommandId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

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

      // The gate withdraws the card in the background.
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const settled = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
          (candidate) => candidate.id === request.id,
        );
        if (settled?.status === "resolved") return;
        yield* Effect.yieldNow;
      }
      assert.fail("the declined card was never settled");
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
