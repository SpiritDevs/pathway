import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ProviderApprovalDecision } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  COMPUTER_APPROVAL_TIMEOUT,
  COMPUTER_APPROVAL_WAIT_BOUND,
  ComputerApprovalPublishError,
  ComputerApprovalRequester,
  computerApprovalPolicy,
  make,
  type ComputerApprovalPrompt,
} from "./ComputerApprovalGate.ts";

type Hook = (prompt: ComputerApprovalPrompt) => Effect.Effect<void, ComputerApprovalPublishError>;

const harness = Effect.fn(function* () {
  const opened = yield* Queue.unbounded<ComputerApprovalPrompt>();
  const resolved = yield* Queue.unbounded<ProviderApprovalDecision>();
  const hooks: { open: Hook; resolve: Hook } = {
    open: () => Effect.void,
    resolve: () => Effect.void,
  };
  const gate = yield* make().pipe(
    Effect.provideService(ComputerApprovalRequester, {
      open: (prompt) =>
        Queue.offer(opened, prompt).pipe(Effect.andThen(Effect.suspend(() => hooks.open(prompt)))),
      resolve: (prompt, decision) =>
        Queue.offer(resolved, decision).pipe(
          Effect.andThen(Effect.suspend(() => hooks.resolve(prompt))),
        ),
    }),
    Effect.provide(NodeServices.layer),
  );
  return { gate, opened, resolved, hooks };
});

const task = (threadId: string, turnId = "turn") => ({
  threadId,
  turnId,
  toolName: "computer_type_text",
});

const call = (threadId: string, callKey = "clipboard") => ({
  threadId,
  callKey,
  toolName: "computer_read_clipboard",
});

describe("ComputerApprovalGate", () => {
  it.effect("cancels a concurrent waiter without approving or cancelling another call", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      const first = yield* Effect.forkChild(gate.requestTask(task("a")));
      const prompt = yield* Queue.take(opened);
      const follower = yield* Effect.forkChild(gate.requestTask(task("a")));
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(follower);
      expect(Exit.hasInterrupts(yield* Fiber.await(follower))).toBe(true);
      expect(yield* gate.respond("a", prompt.requestId, "accept")).toBe(true);
      expect(yield* Fiber.join(first)).toBe("approved");
    }),
  );

  it.effect("does not reuse task consent for a separate clipboard approval", () =>
    Effect.gen(function* () {
      const { gate, opened, hooks } = yield* harness();
      hooks.open = (prompt) => gate.respond("a", prompt.requestId, "accept").pipe(Effect.asVoid);
      expect(yield* gate.requestTask(task("a"))).toBe("approved");
      expect(yield* gate.requestTask(task("a"))).toBe("approved");
      expect(yield* gate.request(call("a"))).toBe("approved");
      expect(yield* gate.request(call("a"))).toBe("approved");
      expect(yield* Queue.size(opened)).toBe(3);
    }),
  );

  it.effect("shares one consent across concurrent and later routine actions in the same turn", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      const first = yield* Effect.forkChild(gate.requestTask(task("a", "turn-1")));
      const prompt = yield* Queue.take(opened);
      const concurrent = yield* Effect.forkChild(gate.requestTask(task("a", "turn-1")));
      yield* Effect.yieldNow;
      expect(yield* Queue.size(opened)).toBe(0);
      yield* gate.respond("a", prompt.requestId, "accept");
      expect(yield* Fiber.join(first)).toBe("approved");
      expect(yield* Fiber.join(concurrent)).toBe("approved");
      expect(yield* gate.requestTask(task("a", "turn-1"))).toBe("approved");
      expect(yield* Queue.size(opened)).toBe(0);
      yield* gate.cancelThread("a", "old-turn");
      expect(yield* gate.requestTask(task("a", "turn-1"))).toBe("approved");
      yield* gate.cancelThread("a", "turn-1");
      const next = yield* Effect.forkChild(gate.requestTask(task("a", "turn-2")));
      const second = yield* Queue.take(opened);
      yield* gate.respond("a", second.requestId, "decline");
      expect(yield* Fiber.join(next)).toBe("denied");
      expect(yield* gate.requestTask(task("a", "turn-2"))).toBe("denied");
      expect(yield* Queue.size(opened)).toBe(0);
    }),
  );

  it.effect(
    "re-prompts a declined task next turn without leaking the decision into clipboard",
    () =>
      Effect.gen(function* () {
        const { gate, opened } = yield* harness();
        const answer = (decision: ProviderApprovalDecision, scope: "task" | "call") =>
          Effect.gen(function* () {
            const prompt = yield* Queue.take(opened);
            expect(prompt.scope).toBe(scope);
            yield* gate.respond("a", prompt.requestId, decision);
          });
        // Turn one declines the task prompt.
        const first = yield* Effect.forkChild(gate.requestTask(task("a", "turn-1")));
        yield* answer("decline", "task");
        expect(yield* Fiber.join(first)).toBe("denied");
        // A clipboard approval is a separate per-call consent: the task decline
        // neither answers it nor suppresses its prompt.
        const clipboardFirst = yield* Effect.forkChild(gate.request(call("a")));
        yield* answer("decline", "call");
        expect(yield* Fiber.join(clipboardFirst)).toBe("denied");
        // Turn two re-prompts instead of replaying the decline, and can accept.
        const second = yield* Effect.forkChild(gate.requestTask(task("a", "turn-2")));
        yield* answer("accept", "task");
        expect(yield* Fiber.join(second)).toBe("approved");
        // The clipboard decline never touched the task grant: the turn stays approved.
        expect(yield* gate.requestTask(task("a", "turn-2"))).toBe("approved");
        expect(yield* Queue.size(opened)).toBe(0);
        // And the task grant never answers a clipboard prompt either.
        const clipboardSecond = yield* Effect.forkChild(gate.request(call("a")));
        yield* answer("accept", "call");
        expect(yield* Fiber.join(clipboardSecond)).toBe("approved");
      }),
  );

  it.effect("cannot retain consent when Stop races an accepted response", () =>
    Effect.gen(function* () {
      const { gate, hooks } = yield* harness();
      hooks.open = (prompt) =>
        gate.respond("a", prompt.requestId, "accept").pipe(Effect.andThen(gate.cancelThread("a")));
      expect(yield* gate.requestTask(task("a"))).toBe("denied");
    }),
  );

  it.effect("settles only the disabled conversation's live prompt", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      const a = yield* Effect.forkChild(gate.request(call("a")));
      const promptA = yield* Queue.take(opened);
      const b = yield* Effect.forkChild(gate.request(call("b")));
      const promptB = yield* Queue.take(opened);
      yield* gate.cancelThread("a");
      expect(yield* Fiber.join(a)).toBe("denied");
      expect(yield* gate.respond("a", promptA.requestId, "accept")).toBe(false);
      expect(yield* gate.respond("b", promptB.requestId, "accept")).toBe(true);
      expect(yield* Fiber.join(b)).toBe("approved");
    }),
  );

  it.effect.each(["accept", "decline", "cancel", "acceptForSession"] as const)(
    "binds %s to the requesting conversation and one call",
    (decision) =>
      Effect.gen(function* () {
        const { gate, opened, resolved, hooks } = yield* harness();
        hooks.open = (prompt) =>
          Effect.gen(function* () {
            expect(yield* gate.respond("b", prompt.requestId, "accept")).toBe(false);
            expect(yield* gate.respond("a", prompt.requestId, decision)).toBe(true);
          });
        const result = yield* gate.request(call("a"));
        expect(result).toBe(decision === "accept" ? "approved" : "denied");
        const prompt = yield* Queue.take(opened);
        expect(yield* gate.respond("a", prompt.requestId, "accept")).toBe(false);
        expect(yield* Queue.take(resolved)).toBe(
          decision === "acceptForSession" ? "decline" : decision,
        );
      }),
  );

  it.effect("cancels a pending prompt and rejects late decisions", () =>
    Effect.gen(function* () {
      const { gate, opened, resolved } = yield* harness();
      const result = yield* Effect.forkChild(gate.request(call("a")));
      const prompt = yield* Queue.take(opened);
      yield* Fiber.interrupt(result);
      expect(Exit.hasInterrupts(yield* Fiber.await(result))).toBe(true);
      expect(yield* Queue.take(resolved)).toBe("cancel");
      expect(yield* gate.respond("a", prompt.requestId, "accept")).toBe(false);
    }),
  );

  it.effect("refuses a full per-thread queue retryably while other chats still prompt", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      for (let i = 0; i < 8; i++) {
        yield* Effect.forkChild(gate.request(call("busy", `call-${i}`)));
        yield* Queue.take(opened);
      }
      const error = yield* Effect.flip(gate.request(call("busy", "call-8")));
      expect(error).toMatchObject({ code: "approval_queue_full", retryable: true });
      // The thread cap is per chat: an uninvolved thread still gets its prompt.
      const other = yield* Effect.forkChild(gate.request(call("other")));
      const prompt = yield* Queue.take(opened);
      yield* gate.respond("other", prompt.requestId, "accept");
      expect(yield* Fiber.join(other)).toBe("approved");
      yield* gate.cancelThread("busy");
    }),
  );

  it.effect("refuses past the shared queue cap with the same retryable code", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      const threads = Array.from({ length: 16 }, (_, i) => `thread-${i}`);
      for (const threadId of threads) {
        for (let i = 0; i < 8; i++) {
          yield* Effect.forkChild(gate.request(call(threadId, `call-${i}`)));
          yield* Queue.take(opened);
        }
      }
      const error = yield* Effect.flip(gate.request(call("overflow")));
      expect(error).toMatchObject({ code: "approval_queue_full", retryable: true });
      yield* Effect.forEach(threads, (threadId) => gate.cancelThread(threadId));
    }),
  );

  it.effect("an interruption releases a consent whose publish never resolves", () =>
    Effect.gen(function* () {
      const { gate, opened, hooks } = yield* harness();
      hooks.open = () => Effect.never;
      const request = yield* Effect.forkChild(gate.request(call("stuck")));
      yield* Queue.take(opened);
      yield* Fiber.interrupt(request);
      expect(Exit.hasInterrupts(yield* Fiber.await(request))).toBe(true);
      // The slot was released: the thread can prompt again.
      const next = yield* Effect.forkChild(gate.request(call("stuck")));
      yield* Queue.take(opened);
      yield* gate.cancelThread("stuck");
      expect(yield* Fiber.join(next)).toBe("denied");
    }),
  );

  it.effect("a dismissal publish failure cannot convert an accepted consent into a rejection", () =>
    Effect.gen(function* () {
      const { gate, hooks } = yield* harness();
      hooks.open = (prompt) =>
        gate.respond("dismiss", prompt.requestId, "accept").pipe(Effect.asVoid);
      hooks.resolve = () =>
        Effect.fail(new ComputerApprovalPublishError({ message: "socket gone" }));
      expect(yield* gate.request(call("dismiss"))).toBe("approved");
    }),
  );

  it.effect("a desktop interruption revokes grants but keeps declines and live prompts", () =>
    Effect.gen(function* () {
      const { gate, opened } = yield* harness();
      const answer = (threadId: string, decision: ProviderApprovalDecision) =>
        Effect.gen(function* () {
          const prompt = yield* Queue.take(opened);
          expect(prompt.threadId).toBe(threadId);
          yield* gate.respond(threadId, prompt.requestId, decision);
        });
      // One thread holds a standing grant, another holds a standing decline,
      // and a third's prompt is still open when the interruption lands.
      const granted = yield* Effect.forkChild(gate.requestTask(task("granted")));
      yield* answer("granted", "accept");
      expect(yield* Fiber.join(granted)).toBe("approved");
      const declined = yield* Effect.forkChild(gate.requestTask(task("declined")));
      yield* answer("declined", "decline");
      expect(yield* Fiber.join(declined)).toBe("denied");
      const pending = yield* Effect.forkChild(gate.requestTask(task("pending")));
      const pendingPrompt = yield* Queue.take(opened);
      yield* gate.revokeTaskGrants;
      // The grant is gone: the next call republishes the prompt instead of
      // riding the pre-interruption answer.
      const reprompted = yield* Effect.forkChild(gate.requestTask(task("granted")));
      yield* answer("granted", "accept");
      expect(yield* Fiber.join(reprompted)).toBe("approved");
      // The decline stays declined without a new prompt: a refusal is not the
      // authority a lock needs to break.
      expect(yield* gate.requestTask(task("declined"))).toBe("denied");
      expect(yield* Queue.size(opened)).toBe(0);
      // The still-open prompt survives: its answer can only postdate the
      // interruption, so accepting it now is the re-auth itself.
      yield* gate.respond("pending", pendingPrompt.requestId, "accept");
      expect(yield* Fiber.join(pending)).toBe("approved");
      expect(yield* gate.requestTask(task("pending"))).toBe("approved");
      expect(yield* Queue.size(opened)).toBe(0);
    }),
  );

  describe("bounded wait", () => {
    it.effect("returns pending and keeps the card open for a later answer", () =>
      Effect.gen(function* () {
        const { gate, opened } = yield* harness();
        const first = yield* Effect.forkChild(gate.request(call("a", "type:hello")));
        const prompt = yield* Queue.take(opened);
        yield* TestClock.adjust(COMPUTER_APPROVAL_WAIT_BOUND);
        expect(yield* Fiber.join(first)).toBe("pending");
        expect(yield* gate.respond("a", prompt.requestId, "accept")).toBe(true);
        // A different call does not ride the answer.
        const other = yield* Effect.forkChild(gate.request(call("a", "type:bye")));
        yield* Queue.take(opened);
        yield* gate.cancelThread("a");
        expect(yield* Fiber.join(other)).toBe("denied");
      }),
    );

    it.effect("consumes a late per-call answer exactly once", () =>
      Effect.gen(function* () {
        const { gate, opened } = yield* harness();
        const first = yield* Effect.forkChild(gate.request(call("a", "type:hello")));
        const prompt = yield* Queue.take(opened);
        yield* TestClock.adjust(COMPUTER_APPROVAL_WAIT_BOUND);
        expect(yield* Fiber.join(first)).toBe("pending");
        yield* gate.respond("a", prompt.requestId, "accept");
        expect(yield* gate.request(call("a", "type:hello"))).toBe("approved");
        expect(yield* Queue.size(opened)).toBe(0);
        // The answer covered one call: the next identical call asks again.
        const again = yield* Effect.forkChild(gate.request(call("a", "type:hello")));
        expect((yield* Queue.take(opened)).requestId).not.toBe(prompt.requestId);
        yield* Fiber.interrupt(again);
      }),
    );

    it.effect("reattaches the next identical call to a card still open", () =>
      Effect.gen(function* () {
        const { gate, opened } = yield* harness();
        const first = yield* Effect.forkChild(gate.request(call("a", "type:hello")));
        const prompt = yield* Queue.take(opened);
        yield* TestClock.adjust(COMPUTER_APPROVAL_WAIT_BOUND);
        expect(yield* Fiber.join(first)).toBe("pending");
        const second = yield* Effect.forkChild(gate.request(call("a", "type:hello")));
        yield* Effect.yieldNow;
        expect(yield* Queue.size(opened)).toBe(0);
        yield* gate.respond("a", prompt.requestId, "decline");
        expect(yield* Fiber.join(second)).toBe("denied");
      }),
    );

    it.effect("applies a late task answer to the rest of the turn", () =>
      Effect.gen(function* () {
        const { gate, opened } = yield* harness();
        const first = yield* Effect.forkChild(gate.requestTask(task("a")));
        const prompt = yield* Queue.take(opened);
        yield* TestClock.adjust(COMPUTER_APPROVAL_WAIT_BOUND);
        expect(yield* Fiber.join(first)).toBe("pending");
        yield* gate.respond("a", prompt.requestId, "accept");
        expect(yield* gate.requestTask(task("a"))).toBe("approved");
        expect(yield* Queue.size(opened)).toBe(0);
      }),
    );

    it.effect("withdraws an unanswered card after the approval timeout", () =>
      Effect.gen(function* () {
        const { gate, opened, resolved } = yield* harness();
        const first = yield* Effect.forkChild(gate.requestTask(task("a")));
        const prompt = yield* Queue.take(opened);
        yield* TestClock.adjust(COMPUTER_APPROVAL_WAIT_BOUND);
        expect(yield* Fiber.join(first)).toBe("pending");
        yield* TestClock.adjust(COMPUTER_APPROVAL_TIMEOUT);
        expect(yield* Queue.take(resolved)).toBe("cancel");
        expect(yield* gate.respond("a", prompt.requestId, "accept")).toBe(false);
        // No standing decline: the next call asks again.
        const next = yield* Effect.forkChild(gate.requestTask(task("a")));
        yield* Queue.take(opened);
        yield* Fiber.interrupt(next);
      }),
    );
  });

  it.effect("fails the waiting call when the card cannot be posted", () =>
    Effect.gen(function* () {
      const { gate, hooks } = yield* harness();
      hooks.open = () => Effect.fail(new ComputerApprovalPublishError({ message: "offline" }));
      const error = yield* Effect.flip(gate.request(call("a")));
      expect(error._tag).toBe("ComputerApprovalPublishError");
    }),
  );

  describe("autonomy", () => {
    it("maps each level to the ADR 0043 table", () => {
      expect(computerApprovalPolicy("supervised")).toEqual({
        mutation: "every-call",
        extraApp: "once-per-app",
        foreground: "explicit-request",
        clipboardRead: "ask",
        unattended: false,
      });
      expect(computerApprovalPolicy("per-task")).toMatchObject({
        mutation: "once-per-task",
        extraApp: "once-per-app",
        clipboardRead: "ask",
        unattended: false,
      });
      expect(computerApprovalPolicy("auto")).toMatchObject({
        mutation: "none",
        extraApp: "none",
        foreground: "explicit-request",
        clipboardRead: "ask",
      });
      expect(computerApprovalPolicy("full-access")).toEqual({
        mutation: "none",
        extraApp: "none",
        foreground: "allowed",
        clipboardRead: "allowed",
        unattended: true,
      });
    });

    it.effect("skips exactly the approvals the level turns off", () =>
      Effect.gen(function* () {
        const { gate, opened, hooks } = yield* harness();
        hooks.open = (prompt) =>
          gate.respond(prompt.threadId, prompt.requestId, "accept").pipe(Effect.asVoid);
        const action = { ...call("a", "click"), turnId: "turn", toolName: "computer_click" };
        const app = { ...task("a"), app: "Notes" };
        for (const autonomy of ["auto", "full-access"] as const) {
          expect(yield* gate.authorizeAction({ ...action, autonomy })).toBe("approved");
          expect(yield* gate.authorizeApp({ ...app, autonomy })).toBe("approved");
        }
        expect(yield* gate.authorizeClipboardRead({ ...call("a"), autonomy: "full-access" })).toBe(
          "approved",
        );
        expect(yield* Queue.size(opened)).toBe(0);
        // Auto still asks for clipboard reads.
        expect(yield* gate.authorizeClipboardRead({ ...call("a"), autonomy: "auto" })).toBe(
          "approved",
        );
        expect((yield* Queue.take(opened)).scope).toBe("call");
      }),
    );

    it.effect("asks once per task and app under per-task, every call under supervised", () =>
      Effect.gen(function* () {
        const { gate, opened, hooks } = yield* harness();
        hooks.open = (prompt) =>
          gate.respond(prompt.threadId, prompt.requestId, "accept").pipe(Effect.asVoid);
        const action = { ...call("a", "click"), turnId: "turn", toolName: "computer_click" };
        const scopes = Effect.gen(function* () {
          return (yield* Queue.takeAll(opened)).map((prompt) => prompt.scope);
        });
        yield* gate.authorizeAction({ ...action, autonomy: "per-task" });
        yield* gate.authorizeAction({ ...action, autonomy: "per-task" });
        yield* gate.authorizeApp({ ...task("a"), app: "Notes", autonomy: "per-task" });
        yield* gate.authorizeApp({ ...task("a"), app: "notes", autonomy: "per-task" });
        yield* gate.authorizeApp({ ...task("a"), app: "Safari", autonomy: "per-task" });
        expect(yield* scopes).toEqual(["task", "app", "app"]);
        yield* gate.authorizeAction({ ...action, autonomy: "supervised" });
        yield* gate.authorizeAction({ ...action, autonomy: "supervised" });
        expect(yield* scopes).toEqual(["call", "call"]);
      }),
    );
  });
});
