import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { ComputerStreamFrame } from "./ComputerBackend.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";
import { makeStillFramePublisher } from "./stillFramePublisher.ts";

const FRAME_A = new Uint8Array([1, 2, 3]);
const FRAME_B = new Uint8Array([4, 5, 6, 7]);
const INTERVAL = "100 millis";

const captureFailed = () => new ComputerBackendError({ message: "capture failed" });

type Capture = (force: boolean) => Effect.Effect<Uint8Array | undefined, ComputerOperationError>;

/**
 * A publisher whose frames land in `frames`. Pathway backends have no attached
 * listener: the event stream `emit` feeds is the only receiver, so the
 * listener assertions of the original suite read `frames` instead, and timer
 * counts become "does a tick capture".
 */
const makeHarness = (
  capture: Capture,
  options: {
    readonly captureAvailable?: () => boolean;
    readonly prepare?: Effect.Effect<void, ComputerOperationError>;
  } = {},
) =>
  Effect.gen(function* () {
    const frames: ComputerStreamFrame[] = [];
    const counts = { captures: 0 };
    const publisher = yield* makeStillFramePublisher({
      capture: (force) =>
        Effect.suspend(() => {
          counts.captures += 1;
          return capture(force);
        }),
      isCaptureAvailable: options.captureAvailable ?? (() => true),
      emit: (frame) =>
        Effect.sync(() => {
          frames.push(frame);
        }),
      intervalMs: 100,
      ...(options.prepare ? { prepare: options.prepare } : {}),
    });
    return { publisher, frames, counts };
  });

/** A prepare step that reports when it starts and waits for `release`. */
const gatedPrepare = Effect.gen(function* () {
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  return {
    started,
    release,
    prepare: Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)),
  };
});

describe("StillFramePublisher", () => {
  it.effect("does not start capturing when detached during preparation", () =>
    Effect.gen(function* () {
      const gate = yield* gatedPrepare;
      const harness = yield* makeHarness(() => Effect.succeed(FRAME_A), {
        prepare: gate.prepare,
      });
      const attaching = yield* Effect.forkChild(harness.publisher.attach);
      yield* Deferred.await(gate.started);
      yield* harness.publisher.detach;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(attaching);
      yield* TestClock.adjust("500 millis");
      expect(harness.counts.captures).toBe(0);
      expect(harness.frames).toEqual([]);
    }),
  );

  it.effect("keeps the newest attach when preparations finish out of order", () =>
    Effect.gen(function* () {
      const first = yield* gatedPrepare;
      const second = yield* gatedPrepare;
      const preparations = [first.prepare, second.prepare];
      const harness = yield* makeHarness(() => Effect.succeed(FRAME_A), {
        prepare: Effect.suspend(() => preparations.shift() ?? Effect.void),
      });
      const firstAttach = yield* Effect.forkChild(harness.publisher.attach);
      yield* Deferred.await(first.started);
      const secondAttach = yield* Effect.forkChild(harness.publisher.attach);
      yield* Deferred.await(second.started);
      yield* Deferred.succeed(second.release, undefined);
      yield* Fiber.join(secondAttach);
      yield* Deferred.succeed(first.release, undefined);
      yield* Fiber.join(firstAttach);
      yield* harness.publisher.requestKeyframe;
      // The superseded attach published nothing: one forced first still, one keyframe.
      expect(harness.frames).toHaveLength(2);
      expect(harness.counts.captures).toBe(2);
      // Exactly one interval loop survives.
      yield* TestClock.adjust(INTERVAL);
      expect(harness.counts.captures).toBe(3);
    }),
  );

  it.effect("keeps one loop when attaches overlap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(FRAME_A));
      yield* Effect.all([harness.publisher.attach, harness.publisher.attach], {
        concurrency: "unbounded",
      });
      const settled = harness.counts.captures;
      yield* TestClock.adjust(INTERVAL);
      expect(harness.counts.captures).toBe(settled + 1);
      yield* harness.publisher.detach;
      yield* TestClock.adjust("500 millis");
      expect(harness.counts.captures).toBe(settled + 1);
    }),
  );

  it.effect.each([false, true])(
    "immediately serves a replacement attach after an old capture settles (failure: %s)",
    (fails) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const oldCapture = yield* Deferred.make<Uint8Array, ComputerOperationError>();
        let firstCapture = true;
        const harness = yield* makeHarness(() => {
          if (!firstCapture) return Effect.succeed(FRAME_B);
          firstCapture = false;
          return Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(oldCapture));
        });
        const firstAttach = yield* Effect.forkChild(harness.publisher.attach);
        yield* Deferred.await(started);
        expect(harness.counts.captures).toBe(1);
        yield* harness.publisher.detach;
        yield* harness.publisher.attach;
        if (fails) yield* Deferred.fail(oldCapture, captureFailed());
        else yield* Deferred.succeed(oldCapture, FRAME_A);
        yield* Fiber.join(firstAttach);
        expect(harness.counts.captures).toBe(2);
        expect(harness.frames.map((frame) => frame.data)).toEqual([FRAME_B]);
        // The replacement owns the one running loop.
        yield* TestClock.adjust(INTERVAL);
        expect(harness.counts.captures).toBe(3);
      }),
  );

  it.effect(
    "publishes the first frame, dedupes identical ones, and republishes on a keyframe",
    () =>
      Effect.gen(function* () {
        let bytes = FRAME_A;
        const harness = yield* makeHarness(() => Effect.sync(() => bytes));
        yield* harness.publisher.attach;
        expect(harness.frames).toHaveLength(1);
        expect(harness.frames[0]).toMatchObject({
          sequence: 1,
          keyframe: true,
          codecConfig: false,
        });

        yield* harness.publisher.publish();
        expect(harness.frames).toHaveLength(1);

        // A receiver with nothing to draw asks for one anyway.
        yield* harness.publisher.requestKeyframe;
        expect(harness.frames).toHaveLength(2);

        bytes = FRAME_B;
        yield* harness.publisher.publish();
        expect(harness.frames).toHaveLength(3);
        expect(harness.frames.map((frame) => frame.sequence)).toEqual([1, 2, 3]);
      }),
  );

  it.effect("passes keyframe force to native deduplication after idle ticks and reattach", () =>
    Effect.gen(function* () {
      const forces: boolean[] = [];
      const harness = yield* makeHarness((force) =>
        Effect.sync(() => {
          forces.push(force);
          return force ? FRAME_A : undefined;
        }),
      );
      yield* harness.publisher.attach;
      yield* harness.publisher.publish();
      yield* harness.publisher.publish();
      expect(harness.frames).toHaveLength(1);
      yield* harness.publisher.requestKeyframe;
      expect(harness.frames).toHaveLength(2);
      yield* harness.publisher.detach;
      yield* harness.publisher.attach;
      expect(harness.frames).toHaveLength(3);
      expect(forces).toEqual([true, false, false, true, true]);
    }),
  );

  it.effect("bounds the retries a failing forced capture buys", () =>
    Effect.gen(function* () {
      // The unbounded version re-armed the force on every failure and then
      // republished because a force was pending — a tight recursion that never
      // yielded to the timer for as long as captures failed.
      const harness = yield* makeHarness(() => Effect.fail(captureFailed()));
      yield* harness.publisher.attach;

      expect(harness.frames).toHaveLength(0);
      // The forced attach, plus exactly one immediate retry.
      expect(harness.counts.captures).toBe(2);

      // The timer cadence takes over from here: one capture per tick, not a loop.
      yield* TestClock.adjust(INTERVAL);
      expect(harness.counts.captures).toBe(3);
    }),
  );

  it.effect("treats a capture defect like a failure", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.die(new Error("capture crashed")));
      yield* harness.publisher.attach;
      expect(harness.counts.captures).toBe(2);
      yield* TestClock.adjust(INTERVAL);
      expect(harness.counts.captures).toBe(3);
    }),
  );

  it.effect("gives a fresh keyframe request its own retry budget", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.fail(captureFailed()));
      yield* harness.publisher.attach;
      expect(harness.counts.captures).toBe(2);

      // A later receiver's request must not inherit the exhausted budget of the
      // one before it: it has no picture either.
      yield* harness.publisher.requestKeyframe;
      expect(harness.counts.captures).toBe(4);
    }),
  );

  it.effect("serves a keyframe requested while a capture was already in flight", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let gated = false;
      const harness = yield* makeHarness(() => {
        if (!gated) return Effect.succeed(FRAME_A);
        gated = false;
        return Effect.andThen(
          Effect.andThen(Deferred.succeed(started, undefined), Deferred.await(release)),
          Effect.succeed(FRAME_A),
        );
      });

      yield* harness.publisher.attach;
      expect(harness.frames).toHaveLength(1);

      gated = true;
      const inFlight = yield* Effect.forkChild(harness.publisher.publish());
      yield* Deferred.await(started);
      // Asked for precisely because the pane is blank; dropping it left the
      // pane blank until the target happened to change on its own.
      yield* harness.publisher.requestKeyframe;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(inFlight);

      // The in-flight capture deduped against what it had just published, and
      // the deferred force then published anyway despite identical bytes.
      expect(harness.frames).toHaveLength(2);
    }),
  );

  it.effect("publishes nothing for a tick the backend has no target for", () =>
    Effect.gen(function* () {
      // `undefined` is "nothing to publish", not "failed": no window or tab is
      // the target right now, or the backend noticed mid-capture that another
      // request owns the capture path. A receiver with no picture must not be
      // sent a desktop-wide substitute.
      const harness = yield* makeHarness(() => Effect.succeed(undefined));
      yield* harness.publisher.attach;
      expect(harness.frames).toHaveLength(0);
      expect(harness.counts.captures).toBe(1);
    }),
  );

  it.effect("never captures while the backend says capture is unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(() => Effect.succeed(FRAME_A), {
        captureAvailable: () => false,
      });
      yield* harness.publisher.attach;
      yield* harness.publisher.publish();
      yield* harness.publisher.requestKeyframe;
      yield* TestClock.adjust("500 millis");
      expect(harness.counts.captures).toBe(0);
      expect(harness.frames).toHaveLength(0);
    }),
  );

  it.effect("stops the loop on detach", () =>
    Effect.gen(function* () {
      let bytes = FRAME_A;
      const harness = yield* makeHarness(() => Effect.sync(() => bytes));
      yield* harness.publisher.attach;
      yield* TestClock.adjust("250 millis");
      const whileAttached = harness.counts.captures;
      expect(whileAttached).toBe(3);

      yield* harness.publisher.detach;
      bytes = FRAME_B;
      yield* TestClock.adjust("500 millis");
      // A detached publisher owns no loop, so nothing keeps pulling captures
      // out of a target nobody is watching.
      expect(harness.counts.captures).toBe(whileAttached);
      expect(harness.frames).toHaveLength(1);
    }),
  );

  it.effect("cancels the first capture of an attach on detach", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let cancelled = false;
      const harness = yield* makeHarness(() =>
        Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.onInterrupt(() => Effect.sync(() => (cancelled = true))),
        ),
      );
      const attaching = yield* Effect.forkChild(harness.publisher.attach);
      yield* Deferred.await(started);
      yield* harness.publisher.detach;
      expect(cancelled).toBe(true);
      yield* Fiber.join(attaching);
      expect(harness.frames).toHaveLength(0);
    }),
  );

  it.effect("cancels a keyframe capture on detach so the next attach can capture", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let hang = false;
      let cancelled = false;
      const harness = yield* makeHarness(() => {
        if (!hang) return Effect.succeed(FRAME_A);
        hang = false;
        return Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
          Effect.onInterrupt(() => Effect.sync(() => (cancelled = true))),
        );
      });
      yield* harness.publisher.attach;
      hang = true;
      const keyframe = yield* Effect.forkChild(harness.publisher.requestKeyframe);
      yield* Deferred.await(started);
      yield* harness.publisher.detach;
      expect(cancelled).toBe(true);
      yield* Fiber.join(keyframe);
      // The slot is free: a replacement attach captures and publishes at once.
      yield* harness.publisher.attach;
      expect(harness.frames).toHaveLength(2);
    }),
  );

  it.effect("stops the loop when its scope closes", () =>
    Effect.gen(function* () {
      const counts = { captures: 0 };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const publisher = yield* makeStillFramePublisher({
            capture: () =>
              Effect.sync(() => {
                counts.captures += 1;
                return FRAME_A;
              }),
            isCaptureAvailable: () => true,
            emit: () => Effect.void,
            intervalMs: 100,
          });
          yield* publisher.attach;
        }),
      );
      yield* TestClock.adjust("500 millis");
      expect(counts.captures).toBe(1);
    }),
  );

  it.effect("keeps exactly the newest attach's loop when two attaches overlap", () =>
    Effect.gen(function* () {
      const gate = yield* gatedPrepare;
      const preparations = [gate.prepare];
      const harness = yield* makeHarness(() => Effect.succeed(FRAME_A), {
        prepare: Effect.suspend(() => preparations.shift() ?? Effect.void),
      });
      const firstAttach = yield* Effect.forkChild(harness.publisher.attach);
      yield* Deferred.await(gate.started);
      yield* harness.publisher.attach;
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(firstAttach);
      const settled = harness.counts.captures;
      yield* TestClock.adjust(INTERVAL);
      // One interval, not two: an orphaned loop nothing can stop would keep
      // capturing for the life of the process.
      expect(harness.counts.captures).toBe(settled + 1);
    }),
  );
});
