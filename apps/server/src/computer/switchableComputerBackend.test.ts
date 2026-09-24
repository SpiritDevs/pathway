import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { DESKTOP_OPERATION_QUEUE_LIMIT } from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import {
  CheckingComputerBackend,
  makeSwitchableComputerBackend,
} from "./switchableComputerBackend.ts";

/**
 * Collects the next `count` non-frame events the slot forwards, subscribed
 * before this returns. The fake answers an attach with frames, which are not
 * what these tests are about.
 */
const takeEvents = (events: Stream.Stream<ComputerBackendEvent> | undefined, count: number) =>
  (events ?? Stream.empty).pipe(
    Stream.filter((event) => event.type !== "frame"),
    Stream.take(count),
    Stream.runCollect,
    Effect.forkScoped({ startImmediately: true }),
  );

describe("SwitchableComputerBackend", () => {
  it.effect("reads every member, including optional ones, from the current occupant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        // The placeholder has no clipboard; presence checks must see that.
        expect(slot.backend.readClipboard).toBeUndefined();
        expect("readClipboard" in slot.backend).toBe(false);
        expect(yield* slot.backend.probeAvailability()).toEqual({
          kind: "checking",
          message: "Detecting.",
        });

        const fake = new FakeComputerBackend();
        yield* slot.swap(fake);
        expect(slot.backend.readClipboard).toBeTypeOf("function");
        expect(slot.backend).toBeInstanceOf(FakeComputerBackend);
        yield* slot.backend.writeClipboard!("hello");
        expect(yield* fake.readClipboard()).toBe("hello");
      }),
    ),
  );

  it.effect("carries event subscribers and an attached preview stream across a swap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = new FakeComputerBackend();
        const second = new FakeComputerBackend();
        const slot = yield* makeSwitchableComputerBackend(first);
        const seen = yield* takeEvents(slot.backend.events, 5);
        yield* slot.backend.attachStream();

        yield* slot.swap(second, { desktopChanged: true });
        expect(first.callsFor("detachStream")).toHaveLength(1);
        expect(second.callsFor("attachStream")).toHaveLength(1);

        // The replaced occupant no longer reaches the manager: the fifth event
        // is the new occupant's, not the one the old occupant said first.
        first.emitDesktopInterrupted();
        second.emitWindowsChanged([]);
        const events = yield* Fiber.join(seen);
        expect(events.map((event) => event.type)).toEqual([
          "desktop-interrupted",
          "windows-changed",
          "capabilities-changed",
          "health-changed",
          "windows-changed",
        ]);
      }),
    ),
  );

  it.effect("reports a gone desktop to the service and still forwards the event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const occupant = new FakeComputerBackend();
        const gone: string[] = [];
        const slot = yield* makeSwitchableComputerBackend(occupant, {
          onDesktopGone: (_backend, message) => Effect.sync(() => gone.push(message)),
        });
        const seen = yield* takeEvents(slot.backend.events, 1);
        occupant.emitDesktopGone("Instance exited.");
        const events = yield* Fiber.join(seen);
        expect(gone).toEqual(["Instance exited."]);
        expect(events.map((event) => event.type)).toEqual(["desktop-gone"]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("replacing the desktop under the manager", (it) => {
  it.effect("runs the swap between operations and ends the one that was in flight", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = new FakeComputerBackend();
        const second = new FakeComputerBackend();
        const slot = yield* makeSwitchableComputerBackend(first);
        const manager = yield* ComputerManager.make({ backend: slot.backend, actionSettleMs: 0 });
        const targeted = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let actionEnded = false;
        // An action that has targeted the old desktop and is about to send
        // its input when the desktop is replaced.
        const action = yield* manager
          .withAgentActivity(
            "thread-1",
            Effect.gen(function* () {
              yield* manager.moveCursor("thread-1", { x: 5, y: 5 });
              yield* Deferred.succeed(targeted, undefined);
              yield* Deferred.await(resume);
              return yield* manager.click("thread-1", { x: 10, y: 10 });
            }).pipe(Effect.onExit(() => Effect.sync(() => (actionEnded = true)))),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(targeted);

        // The swap waits for the operation; it does not land inside it.
        let endedBeforeSwap: boolean | undefined;
        const replacing = yield* manager
          .replaceDesktop(
            Effect.suspend(() => {
              endedBeforeSwap = actionEnded;
              return slot.swap(second, { desktopChanged: true });
            }),
          )
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(resume, undefined);

        const failure = yield* Effect.flip(Fiber.join(action));
        expect(failure).toMatchObject({ retryable: true });
        yield* Fiber.join(replacing);
        expect(endedBeforeSwap).toBe(true);
        expect(slot.current()).toBe(second);
        // Nothing of the old action reached either desktop after the swap began.
        expect(first.callsFor("click")).toHaveLength(0);
        expect(second.callsFor("click")).toHaveLength(0);

        // The next operation runs on the new desktop.
        yield* manager.withAgentActivity("thread-1", manager.click("thread-1", { x: 10, y: 10 }));
        expect(second.callsFor("click")).toHaveLength(1);
      }),
    ),
  );

  it.effect("keeps pane input off the new desktop even when the queue is full", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = new FakeComputerBackend();
        const second = new FakeComputerBackend();
        const slot = yield* makeSwitchableComputerBackend(first);
        const manager = yield* ComputerManager.make({ backend: slot.backend, actionSettleMs: 0 });
        const targeting = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        const readWindows = first.listWindows.bind(first);
        // A pane click paused while it reads the old desktop's windows.
        first.listWindows = () =>
          Effect.gen(function* () {
            yield* Deferred.succeed(targeting, undefined);
            yield* Deferred.await(resume);
            return yield* readWindows();
          });
        const pane = yield* manager
          .click(undefined, { x: 100, y: 100 })
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(targeting);
        // The pane click and the calls queued behind it reach the admission limit.
        yield* Effect.forEach(
          Array.from({ length: DESKTOP_OPERATION_QUEUE_LIMIT - 1 }),
          (_, index) =>
            manager
              .withAgentActivity(`queued-${index}`, Effect.void)
              .pipe(Effect.forkScoped({ startImmediately: true })),
        );

        const replacing = yield* manager
          .replaceDesktop(slot.swap(second))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.succeed(resume, undefined);
        yield* Fiber.join(replacing);
        expect(slot.current()).toBe(second);
        expect(yield* Effect.flip(Fiber.join(pane))).toMatchObject({ retryable: true });
        expect(first.callsFor("click")).toHaveLength(0);
        expect(second.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("swaps at once when nothing runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = new FakeComputerBackend();
        const second = new FakeComputerBackend();
        const slot = yield* makeSwitchableComputerBackend(first);
        const manager = yield* ComputerManager.make({ backend: slot.backend, actionSettleMs: 0 });
        yield* manager.replaceDesktop(slot.swap(second));
        expect(slot.current()).toBe(second);
      }),
    ),
  );
});
