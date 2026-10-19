import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import { ComputerBackendError } from "./computerErrors.ts";
import {
  ComputerApprovalRequester,
  make as makeComputerApprovalGate,
  type ComputerApprovalPrompt,
} from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { assertDesktopOperationActive } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

const isComputerBackendError = Schema.is(ComputerBackendError);

it.layer(NodeServices.layer)("computer revoke", (it) => {
  it.effect("off revokes queued admission, aborts the active operation, and lands no click", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const active = yield* manager
          .withAgentActivity(
            "revoke-thread",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              yield* manager.click("revoke-thread", { x: 10, y: 10 });
              return "active-finished";
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        let queuedWorkCalls = 0;
        const queued = yield* manager
          .withAgentActivity(
            "revoke-thread",
            Effect.sync(() => {
              queuedWorkCalls += 1;
              return "queued";
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* manager.setControlEnabled("revoke-thread", false);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Effect.flip(Fiber.join(queued))).message).toContain("revoked");
        expect((yield* Effect.flip(Fiber.join(active))).message).toContain("revoked");
        expect(queuedWorkCalls).toBe(0);
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("a late accept for a prompt open at revoke settles false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = yield* Queue.unbounded<ComputerApprovalPrompt>();
        const gate = yield* makeComputerApprovalGate().pipe(
          Effect.provideService(ComputerApprovalRequester, {
            open: (prompt) => Queue.offer(opened, prompt).pipe(Effect.asVoid),
            resolve: () => Effect.void,
          }),
        );
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({
          backend,
          actionSettleMs: 0,
          approvals: gate,
        });
        const threadId = "revoke-gate-thread";
        const pending = yield* gate
          .request({ threadId, callKey: "click", toolName: "computer_click" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        const prompt = yield* Queue.take(opened);
        // Off settles pending prompts through the shared gate.
        yield* manager.setControlEnabled(threadId, false);
        expect(yield* gate.respond(threadId, prompt.requestId, "accept")).toBe(false);
        expect(yield* Fiber.join(pending)).toBe("denied");
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("revoke still stops input while the first of two overlapping calls is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        class StopCountingBackend extends FakeComputerBackend {
          stopInputCalls = 0;
          stopInput(): Effect.Effect<void> {
            return Effect.sync(() => {
              this.stopInputCalls++;
            });
          }
        }
        const backend = new StopCountingBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const entered = yield* Deferred.make<void>();
        const innerDone = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const first = yield* manager
          .withAgentActivity(
            "overlap-thread",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              // A nested overlapping authority on the same thread runs immediately
              // (same transaction) and completes while the outer call is active: its
              // cleanup must not drop the outer call's authority entry.
              yield* manager.withAgentActivity("overlap-thread", Effect.succeed("inner"));
              yield* Deferred.succeed(innerDone, undefined);
              yield* Deferred.await(release);
              // Post-release work goes through the revoked gate and throws.
              yield* manager.click("overlap-thread", { x: 10, y: 10 });
              return "first-finished";
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        // Let the nested call finish while the outer call is still blocked.
        yield* Deferred.await(innerDone);
        yield* manager.setControlEnabled("overlap-thread", false);
        expect(backend.stopInputCalls).toBe(1);
        yield* Deferred.succeed(release, undefined);
        expect((yield* Effect.flip(Fiber.join(first))).message).toContain("revoked");
      }),
    ),
  );

  it.effect(
    "a stale generation cannot revive control after stop, and re-enable mints a fresh one",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const threadId = "stale-generation-thread";
          // The turn admitted control at generation 0.
          expect(yield* manager.admitControl(threadId, "chat", 0, true)).toBe(true);
          // Stop latches: the generation bumps immediately, before any cleanup.
          const stopped = yield* manager.setControlEnabled(threadId, false);
          expect(stopped.enabled).toBe(false);
          expect(stopped.generation).toBe(1);
          // A request queued before Stop still carries generation 0: it must not
          // re-arm the thread or authorize anything.
          expect(yield* manager.admitControl(threadId, "request", 0, true)).toBe(false);
          expect(manager.canActivateControl(threadId, 0)).toBe(false);
          expect(manager.canContinueChatControl(threadId)).toBe(false);
          // The user's explicit re-enable is the only way back...
          const reenabled = yield* manager.setControlEnabled(threadId, true);
          expect(reenabled.enabled).toBe(true);
          // ...and it does not resurrect the stale generation: an old queued
          // request still answers false while the current one answers true.
          expect(yield* manager.admitControl(threadId, "request", 0, true)).toBe(false);
          expect(yield* manager.admitControl(threadId, "request", 1, true)).toBe(true);
          // Stop again and the current generation goes stale the same way.
          const stoppedAgain = yield* manager.setControlEnabled(threadId, false);
          expect(stoppedAgain.generation).toBe(2);
          expect(yield* manager.admitControl(threadId, "request", 1, true)).toBe(false);
          expect(backend.callsFor("click")).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "a queued invocation cannot slip the gap between the stop latch and the generation bump",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const backend = new FakeComputerBackend();
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const threadId = "stop-race-thread";
          expect(yield* manager.admitControl(threadId, "chat", 0, true)).toBe(true);
          // Stop without awaiting: the in-memory latch is held synchronously, but
          // the durable generation bump lands behind the control-state write chain.
          const stopping = yield* manager
            .setControlEnabled(threadId, false)
            .pipe(Effect.forkChild({ startImmediately: true }));
          // A request queued before Stop carries generation 0. Between the latch
          // and the bump it looks identical to a fresh invocation — only waiting
          // out the pending write keeps it from re-arming the thread.
          expect(yield* manager.admitControl(threadId, "request", 0, true)).toBe(false);
          const stopped = yield* Fiber.join(stopping);
          expect(stopped.enabled).toBe(false);
          expect(stopped.generation).toBe(1);
          // The thread stayed disabled through the whole race: generation 1 is the
          // current one and it still answers no.
          expect(manager.canActivateControl(threadId, 0)).toBe(false);
          expect(manager.canActivateControl(threadId, 1)).toBe(false);
        }),
      ),
  );

  it.effect("revocation aborts live work with a control-revoked reason, not a bare abort", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const active = yield* manager
          .withAgentActivity(
            "reason-thread",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              // The abort is only visible where the operation observes its signal —
              // this fails with the reason the controller was aborted with.
              yield* assertDesktopOperationActive;
            }),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        // The disable's revoke aborts the live authority at once; the stop it
        // queues drains once the call settles.
        const disabling = yield* manager
          .setControlEnabled("reason-thread", false)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(disabling);
        const rejection = yield* Effect.flip(Fiber.join(active));
        // A bare abort classifies as retryable; the reason must carry the
        // revocation flag the gateway's do-not-retry logic reads.
        expect(isComputerBackendError(rejection)).toBe(true);
        expect(isComputerBackendError(rejection) && rejection.controlRevoked).toBe(true);
      }),
    ),
  );
});
