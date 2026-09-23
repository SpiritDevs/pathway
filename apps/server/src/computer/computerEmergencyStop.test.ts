import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ComputerEvent } from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";

import { ComputerBackendError } from "./computerErrors.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { awaitDesktopSignal, desktopOperationSignal } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

/** Records the OS-level stop relay the manager hands to its backend. */
class StopInputBackend extends FakeComputerBackend {
  stopCalls = 0;
  stopInput(): Effect.Effect<void> {
    return Effect.sync(() => {
      this.stopCalls += 1;
    });
  }
}

/** Every event published since `manager` was subscribed, accumulated across reads. */
const recordEvents = Effect.fn(function* (manager: ComputerManager) {
  const subscription = yield* manager.subscribeEvents;
  const events: ComputerEvent[] = [];
  return Effect.map(PubSub.takeUpTo(subscription, 10_000), (batch) => {
    events.push(...batch);
    return events;
  });
});

it.layer(NodeServices.layer)("computer emergency stop", (it) => {
  it.effect("interrupts live work once and the next action succeeds without a re-arm", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new StopInputBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const readEvents = yield* recordEvents(manager);
        // Seed a thread record so the state read has somewhere to land.
        yield* manager.getThreadState("esc-thread");

        // Input is open before the press.
        yield* manager.click("esc-thread", { x: 10, y: 10 });

        // A live operation observes the stop through its operation signal, the
        // same cancellation an ordinary stop delivers.
        const entered = yield* Deferred.make<void>();
        const live = yield* Effect.forkChild(
          manager.withAgentActivity(
            "esc-thread",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              return yield* awaitDesktopSignal(yield* desktopOperationSignal);
            }),
          ),
        );
        yield* Deferred.await(entered);

        yield* manager.emergencyStopInput();
        expect(backend.stopCalls).toBe(1);
        expect(yield* Effect.flip(Fiber.join(live))).toMatchObject({ controlRevoked: true });
        // The interrupt is announced and closed out: one stopped, one cleared.
        const events = yield* readEvents;
        expect(
          events.filter((event) => event.type === "computer.input-stopped" && event.stopped),
        ).toHaveLength(1);
        expect(
          events.filter((event) => event.type === "computer.input-stopped" && !event.stopped),
        ).toHaveLength(1);

        // Momentary: the very next admission dispatches, with no re-arm step and
        // no stopped state left in any surface.
        expect(yield* manager.click("esc-thread", { x: 11, y: 11 })).toBeDefined();
        expect(backend.callsFor("click")).toHaveLength(2);
        expect((yield* manager.getStatus()).inputStopped).toBeUndefined();
        expect((yield* manager.getThreadState("esc-thread")).inputStopped).toBeUndefined();
      }),
    ),
  );

  it.effect("fails queued work at its wait, then admits the next call", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new StopInputBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const active = yield* Effect.forkChild(
          manager.withAgentActivity(
            "esc-queued",
            Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
              return "active-finished";
            }),
          ),
        );
        yield* Deferred.await(entered);
        let queuedWorkCalls = 0;
        const queued = yield* Effect.forkChild(
          manager.withAgentActivity(
            "esc-queued",
            Effect.sync(() => {
              queuedWorkCalls += 1;
              return "queued";
            }),
          ),
          { startImmediately: true },
        );
        yield* manager.emergencyStopInput();
        yield* Deferred.succeed(release, undefined);
        const queuedError = yield* Effect.flip(Fiber.join(queued));
        expect(queuedError.message).toContain("Escape");
        // The already-admitted work is untouched; the queued admission dies at
        // its wait rather than dispatching after the press.
        expect(yield* Fiber.join(active)).toBe("active-finished");
        expect(queuedWorkCalls).toBe(0);
        expect(backend.callsFor("click")).toHaveLength(0);
        // The aborted broadcast does not poison later calls: a fresh admission
        // after the press dispatches normally.
        expect(yield* manager.click("esc-queued", { x: 1, y: 1 })).toBeDefined();
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("does not latch when the backend stop relay fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        class FailingStopBackend extends FakeComputerBackend {
          stopCalls = 0;
          stopInput(): Effect.Effect<void, ComputerBackendError> {
            return Effect.suspend(() => {
              this.stopCalls += 1;
              // Only the first stop fails, so disposal's own stop is clean.
              return this.stopCalls === 1
                ? Effect.fail(new ComputerBackendError({ message: "backend wedged" }))
                : Effect.void;
            });
          }
        }
        const backend = new FailingStopBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        expect((yield* Effect.flip(manager.emergencyStopInput())).message).toContain(
          "backend wedged",
        );
        // Momentary by contract: a failed delivery is reported to the caller, but
        // no latch survives it — the next admitted action tries again instead of
        // demanding a manual re-arm.
        expect(yield* manager.click("esc-thread", { x: 1, y: 1 })).toBeDefined();
        expect(backend.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("treats a pane Escape as ordinary input, never as a stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new StopInputBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        const readEvents = yield* recordEvents(manager);

        expect(yield* manager.pressKey(undefined, "escape")).toBeDefined();
        expect(backend.callsFor("pressKey").map((call) => call.args[0])).toEqual(["escape"]);
        // No stop relay, no interrupt event: the key the pane sent is a keystroke.
        expect(backend.stopCalls).toBe(0);
        expect(
          (yield* readEvents).filter((event) => event.type === "computer.input-stopped"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps reads open through the interrupt", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new StopInputBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.emergencyStopInput();
        expect(yield* manager.listWindows()).toBeDefined();
        expect(yield* manager.getStatus()).toBeDefined();
      }),
    ),
  );
});
