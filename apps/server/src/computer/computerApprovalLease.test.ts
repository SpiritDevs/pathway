import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import {
  ComputerApprovalRequester,
  make as makeComputerApprovalGate,
  type ComputerApprovalError,
  type ComputerApprovalGateShape,
  type ComputerApprovalOutcome,
  type ComputerApprovalPrompt,
} from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { withComputerTask } from "./computerTaskContext.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/**
 * The caller a Computer tool call runs for. Synara drives these cases through
 * the agent gateway's `computer_type_text` tool; Pathway has no gateway tool
 * layer yet, so `typeTextTool` below reproduces the part the lease depends on:
 * consent first, then the caller-turn check inside the admitted activity, then
 * the dispatch.
 */
class CallerTurnEndedError extends Schema.TaggedErrorClass<CallerTurnEndedError>()(
  "CallerTurnEndedError",
  { message: Schema.String },
) {}

interface Caller {
  readonly threadId: string;
  readonly turnId: string;
  readonly assertCallerTurnActive: Effect.Effect<void, CallerTurnEndedError>;
}

const caller = (threadId: string, turnId: string): Caller => ({
  threadId,
  turnId,
  assertCallerTurnActive: Effect.void,
});

type Authorize = (caller: Caller) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;

const typeTextTool =
  (manager: ComputerManager, authorize?: Authorize) => (text: string, context: Caller) =>
    Effect.gen(function* () {
      if (authorize !== undefined) {
        // A failed or unanswered consent reads as denied: nothing is sent.
        const outcome = yield* authorize(context).pipe(Effect.orElseSucceed(() => "denied"));
        if (outcome !== "approved") return { isError: true };
      }
      return yield* manager
        .withAgentActivity(
          context.threadId,
          Effect.andThen(
            context.assertCallerTurnActive,
            withComputerTask(
              { threadId: context.threadId, turnId: context.turnId },
              manager.typeText(context.threadId, text),
            ),
          ),
          undefined,
          context.turnId,
        )
        .pipe(
          Effect.as({ isError: false }),
          Effect.orElseSucceed(() => ({ isError: true })),
        );
    });

/** A gate whose posted cards land in `opened`, with a hook that may answer them. */
const gateHarness = Effect.fn(function* () {
  const opened = yield* Queue.unbounded<ComputerApprovalPrompt>();
  const hooks: { open: (prompt: ComputerApprovalPrompt) => Effect.Effect<void> } = {
    open: () => Effect.void,
  };
  const gate: ComputerApprovalGateShape = yield* makeComputerApprovalGate().pipe(
    Effect.provideService(ComputerApprovalRequester, {
      open: (prompt) =>
        Queue.offer(opened, prompt).pipe(Effect.andThen(Effect.suspend(() => hooks.open(prompt)))),
      resolve: () => Effect.void,
    }),
  );
  return { gate, opened, hooks };
});

it.layer(NodeServices.layer)("computer approval lease", (it) => {
  it.effect("a turn-end accept for the previous turn settles false and dispatches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gate, opened, hooks } = yield* gateHarness();
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const threadId = "approval-lease-thread";
        const tool = typeTextTool(manager, (context) =>
          gate.requestTask({
            threadId: context.threadId,
            turnId: context.turnId,
            toolName: "computer_type_text",
          }),
        );
        // Turn one opens its consent prompt and waits for the user.
        const first = yield* tool("late", caller(threadId, "turn-1")).pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        const previous = yield* Queue.take(opened);
        // The turn ends and a new one prompts: the boundary cancels the old
        // prompt, so the user's late accept for turn one settles false.
        hooks.open = (prompt) =>
          prompt.turnId === "turn-2"
            ? gate.respond(threadId, prompt.requestId, "accept").pipe(Effect.asVoid)
            : Effect.void;
        const next = yield* gate
          .requestTask({ threadId, turnId: "turn-2", toolName: "computer_type_text" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(yield* gate.respond(threadId, previous.requestId, "accept")).toBe(false);
        expect(yield* Fiber.join(next)).toBe("approved");
        const result = yield* Fiber.join(first);
        expect(result.isError).toBe(true);
        expect(backend.callsFor("typeText")).toHaveLength(0);
      }),
    ),
  );

  it.effect("an approval that expired before the user answered dispatches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { gate, opened, hooks } = yield* gateHarness();
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const threadId = "approval-expiry-thread";
        // Synara hands the gate an already-aborted signal. Here the approval
        // window expiring is the request's fiber being interrupted before it runs.
        const tool = typeTextTool(manager, (context) =>
          Effect.gen(function* () {
            const request = yield* gate
              .request({
                threadId: context.threadId,
                turnId: context.turnId,
                callKey: "computer_type_text:expired",
                toolName: "computer_type_text",
              })
              .pipe(Effect.forkChild);
            yield* Fiber.interrupt(request);
            const exit = yield* Fiber.await(request);
            return Exit.isSuccess(exit) ? exit.value : ("denied" as const);
          }),
        );
        const result = yield* tool("expired", caller(threadId, "turn-1"));
        // Expired approval reads as denied, the prompt never even opened, and no
        // input was dispatched.
        expect(result.isError).toBe(true);
        expect(yield* Queue.size(opened)).toBe(0);
        expect(backend.callsFor("typeText")).toHaveLength(0);
        // The gate is unpoisoned: a fresh prompt still works.
        hooks.open = (prompt) =>
          gate.respond(threadId, prompt.requestId, "accept").pipe(Effect.asVoid);
        expect(
          yield* gate.request({
            threadId,
            callKey: "computer_type_text:live",
            toolName: "computer_type_text",
          }),
        ).toBe("approved");
      }),
    ),
  );

  it.effect("a turn that ended before dispatch approves nothing and dispatches nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const threadId = "approval-pause-thread";
        const failingCaller = (active: boolean): Caller => ({
          ...caller(threadId, "turn-1"),
          assertCallerTurnActive: active
            ? Effect.void
            : Effect.fail(new CallerTurnEndedError({ message: "original turn ended" })),
        });
        const tool = typeTextTool(manager);
        // A late accept after the turn ended dispatches nothing even though the
        // approval itself would have been granted.
        const denied = yield* tool("late", failingCaller(false));
        expect(denied.isError).toBe(true);
        expect(backend.callsFor("typeText")).toHaveLength(0);
        // The same turn still live dispatches exactly once.
        const accepted = yield* tool("live", failingCaller(true));
        expect(accepted.isError).not.toBe(true);
        expect(backend.callsFor("typeText")).toHaveLength(1);
      }),
    ),
  );

  it.effect("a desktop interruption revokes standing consent before the next mutating call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // The manager wires the backend's interruption report into the shared
        // gate, so this runs through the real authorize path: the answer that
        // carried the pre-lock turn does not authorize the post-lock call.
        const { gate, opened } = yield* gateHarness();
        const revoked = yield* Deferred.make<void>();
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({
          backend,
          actionSettleMs: 0,
          approvals: {
            cancelThread: gate.cancelThread,
            revokeTaskGrants: gate.revokeTaskGrants.pipe(
              Effect.andThen(Deferred.succeed(revoked, undefined)),
            ),
          },
        });
        const threadId = "interruption-consent-thread";
        const tool = typeTextTool(manager, (context) =>
          gate.requestTask({
            threadId: context.threadId,
            turnId: context.turnId,
            toolName: "computer_type_text",
          }),
        );
        const ctx = caller(threadId, "turn-1");
        const first = yield* tool("before", ctx).pipe(Effect.forkChild({ startImmediately: true }));
        const firstPrompt = yield* Queue.take(opened);
        yield* gate.respond(threadId, firstPrompt.requestId, "accept");
        yield* Fiber.join(first);
        expect(backend.callsFor("typeText")).toHaveLength(1);
        // The screen locked and unlocked between calls: the host's
        // interruption count advanced, the backend announced it, and the
        // standing grant is gone — the same tool republishes its prompt
        // instead of riding the pre-interruption answer.
        backend.emitDesktopInterrupted(["screen-lock"]);
        yield* Deferred.await(revoked);
        const second = yield* tool("after", ctx).pipe(Effect.forkChild({ startImmediately: true }));
        const secondPrompt = yield* Queue.take(opened);
        yield* gate.respond(threadId, secondPrompt.requestId, "accept");
        yield* Fiber.join(second);
        expect(backend.callsFor("typeText")).toHaveLength(2);
        yield* gate.cancelThread(threadId);
      }),
    ),
  );
});
