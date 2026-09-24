import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { ComputerEvent } from "@spiritdevs/contracts";
import { decodeComputerFrame } from "@spiritdevs/shared/computerFrame";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import type { ComputerBackendEvent } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { ComputerBackendError } from "./computerErrors.ts";
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

/** The availability the manager last pushed for `threadId`, from what `events` holds now. */
const lastPushedAvailability = (events: PubSub.Subscription<ComputerEvent>, threadId: string) =>
  Effect.map(PubSub.takeAll(events), (taken) =>
    taken
      .flatMap((event) =>
        event.type === "computer.thread-state" && event.state.threadId === threadId
          ? [event.state.availability]
          : [],
      )
      .at(-1),
  );

/** The next state the manager pushes for `threadId` that is past the selection placeholder. */
const nextPushedState = (events: PubSub.Subscription<ComputerEvent>, threadId: string) =>
  PubSub.take(events).pipe(
    Effect.repeat({
      until: (event) =>
        event.type === "computer.thread-state" &&
        event.state.threadId === threadId &&
        event.state.availability.kind !== "checking",
    }),
    Effect.map((event) => (event.type === "computer.thread-state" ? event.state : undefined)),
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

  it.effect("keeps the preview sequence rising across a replacement", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = new FakeComputerBackend();
        const second = new FakeComputerBackend();
        const slot = yield* makeSwitchableComputerBackend(first);
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        const frames = yield* Queue.unbounded<Uint8Array>();
        yield* manager.subscribeFrames({
          isOpen: () => true,
          bufferedAmount: () => 0,
          send: (bytes) => {
            Queue.offerUnsafe(frames, bytes);
            return true;
          },
        });
        const nextSequence = Effect.map(Queue.take(frames), (bytes) => {
          const decoded = decodeComputerFrame(bytes);
          return decoded.ok ? decoded.frame.header.sequence : undefined;
        });
        // The attach sends a codec config and a keyframe, then eight stills.
        const seen = [yield* nextSequence, yield* nextSequence];
        for (let index = 0; index < 8; index += 1) {
          yield* first.emitFrame(true);
          seen.push(yield* nextSequence);
        }
        expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

        // The replacement's own publisher counts from 1; a client still
        // holding 10 must see its frames as newer.
        yield* manager.replaceDesktop(slot.swap(second, { desktopChanged: true }));
        expect([yield* nextSequence, yield* nextSequence]).toEqual([11, 12]);
        yield* second.emitFrame(true, false, Uint8Array.of(0xff, 0xd8, 0xff), "image/jpeg");
        expect(yield* nextSequence).toBe(13);
      }),
    ),
  );

  it.effect("pushes a thread seeded during selection the selected desktop's availability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        expect((yield* manager.getThreadState("thread-1")).availability.kind).toBe("checking");
        const events = yield* manager.subscribeEvents;

        const selected = new FakeComputerBackend();
        yield* manager.replaceDesktop(slot.swap(selected));
        // Pushed with the swap: the thread never asks again.
        expect(yield* lastPushedAvailability(events, "thread-1")).toEqual({
          kind: "available",
          backend: "fake",
        });
        // Passive: finding the desktop does not set it up.
        expect(selected.callsFor("availability")).toHaveLength(0);
      }),
    ),
  );

  it.effect("pushes a replacement desktop's availability over the one that was gone", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gone = new FakeComputerBackend();
        gone.setAvailability({ kind: "backend-unavailable", message: "Instance exited." });
        const slot = yield* makeSwitchableComputerBackend(gone);
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        expect((yield* manager.getThreadState("thread-1")).availability.kind).toBe(
          "backend-unavailable",
        );
        const events = yield* manager.subscribeEvents;

        const replacement = new FakeComputerBackend();
        yield* manager.replaceDesktop(slot.swap(replacement, { desktopChanged: true }));
        expect(yield* lastPushedAvailability(events, "thread-1")).toEqual({
          kind: "available",
          backend: "fake",
        });
        expect(replacement.callsFor("availability")).toHaveLength(0);
      }),
    ),
  );

  it.effect("keeps a use of the selected desktop over its slower passive probe", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        expect((yield* manager.getThreadState("thread-1")).availability.kind).toBe("checking");
        // Asked for during detection: the placeholder refuses, but the
        // manager is engaged from here on.
        yield* Effect.ignore(manager.listWindows());
        const events = yield* manager.subscribeEvents;

        const selected = new FakeComputerBackend();
        selected.setAvailability({ kind: "backend-unavailable", message: "Not started." });
        const probing = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const probe = selected.probeAvailability.bind(selected);
        // The passive probe sees the desktop before anything starts it, and
        // answers late.
        selected.probeAvailability = () =>
          Effect.gen(function* () {
            const verdict = yield* probe();
            yield* Deferred.succeed(probing, undefined);
            yield* Deferred.await(answer);
            return verdict;
          });
        const establish = selected.availability.bind(selected);
        selected.availability = () =>
          Effect.suspend(() => {
            selected.setAvailability({ kind: "available", backend: "fake" });
            return establish();
          });
        const replacing = yield* manager
          .replaceDesktop(slot.swap(selected))
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(probing);
        expect((yield* manager.listWindows()).availability.kind).toBe("available");
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(replacing);

        expect((yield* nextPushedState(events, "thread-1"))?.availability).toEqual({
          kind: "available",
          backend: "fake",
        });
        // A health event republishes the cached verdict, not the probe's.
        selected.emitHealthChanged(selected.health());
        expect((yield* nextPushedState(events, "thread-1"))?.availability).toEqual({
          kind: "available",
          backend: "fake",
        });
      }),
    ),
  );

  it.effect("shows a use that succeeds after a failed read of the selected desktop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        yield* manager.getThreadState("thread-1");
        yield* Effect.ignore(manager.listWindows());
        const selected = new FakeComputerBackend();
        selected.setAvailability({ kind: "backend-unavailable", message: "Not started." });
        yield* manager.replaceDesktop(slot.swap(selected));
        const events = yield* manager.subscribeEvents;

        selected.failNext(
          "availability",
          new ComputerBackendError({ message: "Temporary establishing failure." }),
        );
        expect((yield* manager.getThreadState("thread-1")).lastError).toBe(
          "Temporary establishing failure.",
        );
        yield* PubSub.takeAll(events);
        selected.setAvailability({ kind: "available", backend: "fake" });
        expect((yield* manager.listWindows()).availability.kind).toBe("available");

        const recovered = yield* nextPushedState(events, "thread-1");
        expect(recovered?.availability).toEqual({ kind: "available", backend: "fake" });
        expect(recovered?.lastError).toBeNull();
        selected.emitHealthChanged(selected.health());
        expect((yield* nextPushedState(events, "thread-1"))?.availability.kind).toBe("available");
      }),
    ),
  );

  it.effect("keeps a use of the selected desktop over an older passive read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        yield* manager.getThreadState("thread-1");
        const selected = new FakeComputerBackend();
        selected.setAvailability({ kind: "backend-unavailable", message: "Not started." });
        yield* manager.replaceDesktop(slot.swap(selected));
        const events = yield* manager.subscribeEvents;

        const probing = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const probe = selected.probeAvailability.bind(selected);
        // The thread's own read sees the desktop before anything starts it,
        // and answers after a use has.
        selected.probeAvailability = () =>
          Effect.gen(function* () {
            const verdict = yield* probe();
            yield* Deferred.succeed(probing, undefined);
            yield* Deferred.await(answer);
            return verdict;
          });
        const reading = yield* manager
          .getThreadState("thread-1")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(probing);
        selected.setAvailability({ kind: "available", backend: "fake" });
        expect((yield* manager.listWindows()).availability.kind).toBe("available");
        yield* Deferred.succeed(answer, undefined);

        expect((yield* Fiber.join(reading)).availability.kind).toBe("available");
        expect((yield* lastPushedAvailability(events, "thread-1"))?.kind).toBe("available");
        selected.emitHealthChanged(selected.health());
        expect((yield* nextPushedState(events, "thread-1"))?.availability.kind).toBe("available");
      }),
    ),
  );

  it.effect("keeps a newer use of the selected desktop over an older establishing read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        yield* manager.getThreadState("thread-1");
        yield* Effect.ignore(manager.listWindows());
        const selected = new FakeComputerBackend();
        selected.setAvailability({ kind: "backend-unavailable", message: "Not started." });
        yield* manager.replaceDesktop(slot.swap(selected));
        const events = yield* manager.subscribeEvents;

        const reading = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const establish = selected.availability.bind(selected);
        let first = true;
        // The thread's own read answers "not started" after a later use has
        // found the desktop running.
        selected.availability = () =>
          Effect.gen(function* () {
            const verdict = yield* establish();
            if (first) {
              first = false;
              yield* Deferred.succeed(reading, undefined);
              yield* Deferred.await(answer);
            }
            return verdict;
          });
        const threadRead = yield* manager
          .getThreadState("thread-1")
          .pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(reading);
        selected.setAvailability({ kind: "available", backend: "fake" });
        expect((yield* manager.listWindows()).availability.kind).toBe("available");
        yield* Deferred.succeed(answer, undefined);

        const state = yield* Fiber.join(threadRead);
        expect(state.availability.kind).toBe("available");
        // The older read still supplies the windows it saw.
        expect(state.windows.length).toBeGreaterThan(0);
        expect((yield* lastPushedAvailability(events, "thread-1"))?.kind).toBe("available");
      }),
    ),
  );

  it.effect("never lets a push about one desktop start the next one", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const slot = yield* makeSwitchableComputerBackend(
          new CheckingComputerBackend("Detecting."),
        );
        const manager = yield* ComputerManager.make({ backend: slot.backend });
        // Enough threads that pushing to them yields to the scheduler midway.
        for (let n = 0; n < 256; n++) yield* manager.getThreadState(`thread-${n}`);
        yield* Effect.ignore(manager.listWindows());
        const first = new FakeComputerBackend();
        first.setAvailability({ kind: "backend-unavailable", message: "Not started." });
        yield* manager.replaceDesktop(slot.swap(first));

        const next = new FakeComputerBackend();
        const events = yield* manager.subscribeEvents;
        const probing = yield* Deferred.make<void>();
        const answer = yield* Deferred.make<void>();
        const probe = next.probeAvailability.bind(next);
        // Probed right after the swap: what was pushed before this is history.
        next.probeAvailability = () =>
          Effect.gen(function* () {
            yield* PubSub.takeAll(events);
            yield* Deferred.succeed(probing, undefined);
            yield* Deferred.await(answer);
            return yield* probe();
          });
        // The next desktop arrives while the first one's verdict is being
        // pushed: the push reads capabilities for each thread it visits.
        const pushing = yield* Deferred.make<void>();
        const replacing = yield* Deferred.await(pushing).pipe(
          Effect.andThen(manager.replaceDesktop(slot.swap(next))),
          Effect.forkScoped({ startImmediately: true }),
        );
        const capabilities = first.capabilities.bind(first);
        first.capabilities = () => {
          Deferred.doneUnsafe(pushing, Effect.void);
          return capabilities();
        };
        const internals = manager as unknown as {
          runFork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
        };
        const runFork = internals.runFork;
        const forked: Fiber.Fiber<unknown, unknown>[] = [];
        internals.runFork = (effect) => {
          const fiber = runFork(effect);
          forked.push(fiber);
          return fiber;
        };

        first.setAvailability({ kind: "available", backend: "fake" });
        expect((yield* manager.availability()).kind).toBe("available");
        yield* Deferred.await(probing);
        yield* Fiber.awaitAll(forked);
        // The first desktop's push stopped when it was replaced.
        expect(yield* lastPushedAvailability(events, "thread-255")).toBeUndefined();
        yield* Deferred.succeed(answer, undefined);
        yield* Fiber.join(replacing);
        // Nothing has asked to use the next desktop, so nothing started it.
        expect(next.callsFor("availability")).toHaveLength(0);
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
