import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  EVDEV_BUTTON_CODES,
  EVDEV_KEY_CODES,
  keyStrokeForKey,
  qwertyTextKeyStrokes,
} from "./evdevInput.ts";
import {
  BUTTON_HOLD_MS,
  GLIDE_FRAME_INTERVAL_MS,
  glidePointerToDeadline,
  keysHeldAfter,
  keyStrokeEvents,
  POINTER_SEQUENCE_OPERATIONS,
  pointerGlideSteps,
  pressButtonOnce,
  pressHotkeyStrokes,
  pressKeyStroke,
  TYPING_BATCH_MAX_EVENTS,
  typeStrokesInBatches,
  typingBatches,
  type ComputerInputSink,
  type KeyEvent,
} from "./pointerSequencing.ts";

class Refused extends Schema.TaggedErrorClass<Refused>()("Refused", {
  message: Schema.String,
}) {}

/** Records every event a sequence emits, in order, with its operation name. */
function recordingSink(options: { readonly failOn?: (call: string) => boolean } = {}): {
  readonly sink: ComputerInputSink<Refused>;
  readonly calls: string[];
} {
  const calls: string[] = [];
  const push = (call: string) =>
    Effect.suspend(() => {
      calls.push(call);
      return options.failOn?.(call)
        ? Effect.fail(new Refused({ message: `refused ${call}` }))
        : Effect.void;
    });
  return {
    calls,
    sink: {
      movePointer: (x, y, operation) => push(`${operation} ${x},${y}`),
      button: (code, pressed, operation) => push(`${operation} ${code} ${pressed}`),
      key: (code, pressed, operation) => push(`${operation} ${code} ${pressed}`),
    },
  };
}

/**
 * A clock that only moves when told to: `sleep` records its length and jumps
 * the clock by it at once, and `advance` is a transport's round trip.
 */
const manualClock = Effect.gen(function* () {
  const base = yield* TestClock.testClockWith(Effect.succeed);
  let now = 0;
  const sleeps: number[] = [];
  const clock: Clock.Clock = {
    ...base,
    currentTimeMillis: Effect.sync(() => now),
    sleep: (duration) =>
      Effect.sync(() => {
        const millis = Duration.toMillis(duration);
        sleeps.push(millis);
        now += millis;
      }),
  };
  return {
    sleeps,
    now: () => now,
    advance: (millis: number) =>
      Effect.sync(() => {
        now += millis;
      }),
    provide: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.provideService(effect, Clock.Clock, clock),
  };
});

describe("pointerGlideSteps", () => {
  const origin = { x: 0, y: 0 };

  it("schedules the last sample at the requested duration with even spacing", () => {
    const steps = pointerGlideSteps(origin, { x: 200, y: 0 }, 1_500);
    const offsets = steps.map((step) => step.offsetMs);

    expect(offsets.at(-1)).toBeCloseTo(1_500, 6);
    // The gaps are what a paced caller actually waits, so they must add up to
    // the requested duration rather than to steps x a fixed sleep.
    const gaps = offsets.map((offset, index) => offset - (offsets[index - 1] ?? 0));
    expect(gaps.reduce((total, gap) => total + gap, 0)).toBeCloseTo(1_500, 6);
    expect(Math.min(...gaps)).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(GLIDE_FRAME_INTERVAL_MS);
  });

  it("keeps every sample gap inside one frame interval for a long duration", () => {
    // A 1500ms drag used to be sampled at 40ms and then walked with fixed 8ms
    // sleeps, so it ran in a fraction of the duration it asked for.
    const steps = pointerGlideSteps(origin, { x: 10, y: 10 }, 1_500);
    expect(steps.length).toBeGreaterThanOrEqual(Math.ceil(1_500 / GLIDE_FRAME_INTERVAL_MS));
    for (const step of steps) expect(step.offsetMs).toBeLessThanOrEqual(1_500);
  });

  it("keeps the smoothstep easing", () => {
    const steps = pointerGlideSteps(origin, { x: 100, y: 200 }, 0, 4);

    expect(steps).toEqual([
      { point: { x: 15.625, y: 31.25 }, offsetMs: 0 },
      { point: { x: 50, y: 100 }, offsetMs: 0 },
      { point: { x: 84.375, y: 168.75 }, offsetMs: 0 },
      { point: { x: 100, y: 200 }, offsetMs: 0 },
    ]);
  });

  it("moves once, at once, when the pointer is already within a pixel of the target", () => {
    // Twelve samples over 180 ms used to cross zero pixels on every click at
    // the cursor's own position and every wheel notch from the pane.
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 10.4, y: 10.3 }, 180)).toEqual([
      { point: { x: 10.4, y: 10.3 }, offsetMs: 0 },
    ]);
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 10, y: 10 }, 1_500)).toHaveLength(1);
    // A real pixel still glides.
    expect(pointerGlideSteps({ x: 10, y: 10 }, { x: 11, y: 10 }, 180).length).toBeGreaterThan(1);
  });

  it("keeps the distance minimum so a fast glide over a long path stays smooth", () => {
    const steps = pointerGlideSteps(origin, { x: 800, y: 0 }, 0);

    expect(steps.length).toBeGreaterThanOrEqual(10);
    expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    expect(steps.at(-1)?.point).toEqual({ x: 800, y: 0 });
  });

  it("treats a negative or non-finite duration as immediate", () => {
    for (const duration of [-1_000, Number.NaN, Number.POSITIVE_INFINITY]) {
      const steps = pointerGlideSteps(origin, { x: 40, y: 0 }, duration);
      expect(steps).toHaveLength(2);
      expect(steps.every((step) => step.offsetMs === 0)).toBe(true);
    }
  });
});

describe("glidePointerToDeadline", () => {
  it.effect("sleeps only the remainder up to each deadline, so transport latency is absorbed", () =>
    Effect.gen(function* () {
      // A transport that costs 10ms a hop against 16ms deadlines must leave 6ms
      // of sleep, not 16 — otherwise a slow desktop stretches every drag.
      const clock = yield* manualClock;
      const { sink } = recordingSink();
      yield* clock.provide(
        glidePointerToDeadline({
          sink: {
            movePointer: (...args) => Effect.andThen(clock.advance(10), sink.movePointer(...args)),
          },
          from: { x: 0, y: 0 },
          to: { x: 4, y: 0 },
          durationMs: 64,
        }),
      );

      expect(clock.sleeps).toHaveLength(4);
      for (const slept of clock.sleeps) expect(slept).toBeCloseTo(6, 6);
      expect(clock.now()).toBe(64);
    }),
  );

  it.effect("abandons the glide when beforeStep fails, without emitting that step", () =>
    Effect.gen(function* () {
      const { sink, calls } = recordingSink();
      let steps = 0;
      const error = yield* Effect.flip(
        glidePointerToDeadline({
          sink,
          from: { x: 0, y: 0 },
          to: { x: 400, y: 0 },
          durationMs: 0,
          beforeStep: Effect.suspend(() => {
            steps += 1;
            return steps > 2 ? Effect.fail(new Refused({ message: "disposed" })) : Effect.void;
          }),
        }),
      );

      expect(error.message).toBe("disposed");
      expect(calls).toHaveLength(2);
    }),
  );
});

describe("pressKeyStroke", () => {
  it.effect("wraps a shifted stroke in a shift press and release", () =>
    Effect.gen(function* () {
      const { sink, calls } = recordingSink();
      yield* pressKeyStroke({ sink, stroke: keyStrokeForKey("A") });

      expect(calls).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftShift} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.A} false`,
        `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
      ]);
    }),
  );

  it.effect("still releases shift when the stroke it wrapped was refused", () =>
    Effect.gen(function* () {
      // A shift left latched down is the worst failure this feature has: it
      // silently rewrites everything the human types next.
      const { sink, calls } = recordingSink({
        failOn: (call) =>
          call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true`,
      });
      const error = yield* Effect.flip(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") }));

      expect(error.message).toContain("refused");
      expect(calls.at(-1)).toBe(
        `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
      );
    }),
  );

  it.effect("reports the stroke failure when the shift release refuses on top of it", () =>
    Effect.gen(function* () {
      const { sink } = recordingSink({
        failOn: (call) =>
          call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A} true` ||
          call === `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
      });
      const error = yield* Effect.flip(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") }));
      expect(error.message).toContain(
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.A}`,
      );
    }),
  );
});

describe("pressHotkeyStrokes", () => {
  it.effect("releases the chord in the reverse of the order it went down", () =>
    Effect.gen(function* () {
      const { sink, calls } = recordingSink();
      yield* pressHotkeyStrokes({ sink, strokes: ["ctrl", "shift", "t"].map(keyStrokeForKey) });

      expect(calls).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftControl} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftShift} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.T} false`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftShift} false`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
      ]);
    }),
  );

  it.effect("releases exactly the keys that went down when a later key is refused", () =>
    Effect.gen(function* () {
      const { sink, calls } = recordingSink({
        failOn: (call) =>
          call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
      });
      const error = yield* Effect.flip(
        pressHotkeyStrokes({ sink, strokes: ["ctrl", "t"].map(keyStrokeForKey) }),
      );

      expect(error.message).toContain("refused");
      expect(calls).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.LeftControl} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
      ]);
    }),
  );

  /**
   * Each release is one D-Bus notify that can fail transiently while the
   * session survives; aborting the loop on the first refusal would leave every
   * modifier behind it latched on the human's keyboard until disposal.
   */
  it.effect("runs every chord release even after one refuses, and surfaces the first refusal", () =>
    Effect.gen(function* () {
      const refusedRelease = `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftShift} false`;
      const { sink, calls } = recordingSink({ failOn: (call) => call === refusedRelease });
      const error = yield* Effect.flip(
        pressHotkeyStrokes({ sink, strokes: ["ctrl", "shift", "t"].map(keyStrokeForKey) }),
      );

      expect(error.message).toBe(`refused ${refusedRelease}`);
      // Shift's release refused, but T's and Ctrl's still happened.
      expect(calls.slice(-3)).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.T} false`,
        refusedRelease,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
      ]);
    }),
  );

  it.effect("keeps reporting the press failure when a chord release also refuses", () =>
    Effect.gen(function* () {
      const { sink } = recordingSink({
        failOn: (call) =>
          call === `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T} true` ||
          call === `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
      });
      const error = yield* Effect.flip(
        pressHotkeyStrokes({ sink, strokes: ["ctrl", "t"].map(keyStrokeForKey) }),
      );
      expect(error.message).toContain(
        `${POINTER_SEQUENCE_OPERATIONS.keyPress} ${EVDEV_KEY_CODES.T}`,
      );
    }),
  );

  it.effect("lets every held key up when the chord is interrupted", () =>
    Effect.gen(function* () {
      // Stop can land between two presses; the releases must still run.
      const { sink, calls } = recordingSink();
      const interrupting: ComputerInputSink<Refused> = {
        ...sink,
        key: (code, pressed, operation) =>
          code === EVDEV_KEY_CODES.T && pressed
            ? Effect.andThen(sink.key(code, pressed, operation), Effect.interrupt)
            : sink.key(code, pressed, operation),
      };
      yield* Effect.exit(
        pressHotkeyStrokes({ sink: interrupting, strokes: ["ctrl", "t"].map(keyStrokeForKey) }),
      );

      expect(calls.slice(-1)).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${EVDEV_KEY_CODES.LeftControl} false`,
      ]);
    }),
  );
});

describe("pressButtonOnce", () => {
  it.effect("holds the button long enough for a toolkit to register the press", () =>
    Effect.gen(function* () {
      const clock = yield* manualClock;
      const { sink, calls } = recordingSink();
      yield* clock.provide(pressButtonOnce({ sink, code: EVDEV_BUTTON_CODES.left }));

      expect(clock.sleeps).toEqual([BUTTON_HOLD_MS]);
      expect(calls).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.buttonPress} ${EVDEV_BUTTON_CODES.left} true`,
        `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`,
      ]);
    }),
  );

  it.effect("releases a button whose hold was interrupted", () =>
    Effect.gen(function* () {
      // A button left down drags the desktop under every later pointer move, so
      // the release has to survive anything that ends the hold early. The sink
      // answers synchronously, so the forked press is down and holding by the
      // time forkChild returns.
      const { sink, calls } = recordingSink();
      const press = yield* Effect.forkChild(
        pressButtonOnce({ sink, code: EVDEV_BUTTON_CODES.left }),
        {
          startImmediately: true,
        },
      );
      expect(calls).toHaveLength(1);
      yield* Fiber.interrupt(press);

      expect(calls.at(-1)).toBe(
        `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`,
      );
    }),
  );

  it.effect("reports an interrupted hold rather than a refused release on top of it", () =>
    Effect.gen(function* () {
      // Both halves went wrong; the interruption is the cause worth acting on.
      const { sink } = recordingSink({
        failOn: (call) => call.includes(POINTER_SEQUENCE_OPERATIONS.buttonRelease),
      });
      const press = yield* Effect.forkChild(
        pressButtonOnce({ sink, code: EVDEV_BUTTON_CODES.left }),
        {
          startImmediately: true,
        },
      );
      const exit = yield* Fiber.interrupt(press).pipe(Effect.andThen(Fiber.await(press)));

      expect(Exit.hasInterrupts(exit)).toBe(true);
      expect(Exit.hasFails(exit)).toBe(false);
    }),
  );
});

describe("input cleanup failures", () => {
  it.effect("reports a refused shift release after a successful stroke", () =>
    Effect.gen(function* () {
      const release = `${POINTER_SEQUENCE_OPERATIONS.shiftRelease} ${EVDEV_KEY_CODES.LeftShift} false`;
      const { sink, calls } = recordingSink({ failOn: (call) => call === release });

      const error = yield* Effect.flip(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") }));
      expect(error.message).toBe(`refused ${release}`);
      expect(calls.at(-1)).toBe(release);
    }),
  );

  it.effect("reports a refused button release after a successful hold", () =>
    Effect.gen(function* () {
      const release = `${POINTER_SEQUENCE_OPERATIONS.buttonRelease} ${EVDEV_BUTTON_CODES.left} false`;
      const { sink, calls } = recordingSink({ failOn: (call) => call === release });
      const clock = yield* manualClock;

      const error = yield* Effect.flip(
        clock.provide(pressButtonOnce({ sink, code: EVDEV_BUTTON_CODES.left })),
      );
      expect(error.message).toBe(`refused ${release}`);
      expect(calls.at(-1)).toBe(release);
    }),
  );

  it.effect("preserves a non-Error action failure when cleanup also fails", () =>
    Effect.gen(function* () {
      for (const failure of [undefined, null, "interrupted"]) {
        const calls: string[] = [];
        type Failure = Refused | string | null | undefined;
        const sink: ComputerInputSink<Failure> = {
          movePointer: () => Effect.void,
          key: (code, pressed, operation) =>
            Effect.suspend((): Effect.Effect<void, Failure> => {
              calls.push(operation);
              if (!pressed) return Effect.fail(new Refused({ message: "release refused" }));
              return code === EVDEV_KEY_CODES.A ? Effect.fail(failure) : Effect.void;
            }),
          button: (_code, pressed, operation) =>
            Effect.suspend(() => {
              calls.push(operation);
              return pressed
                ? Effect.void
                : Effect.fail(new Refused({ message: "release refused" }));
            }),
        };

        expect(yield* Effect.flip(pressKeyStroke({ sink, stroke: keyStrokeForKey("A") }))).toBe(
          failure,
        );
        expect(calls.at(-1)).toBe(POINTER_SEQUENCE_OPERATIONS.shiftRelease);
        expect(
          yield* Effect.flip(
            pressHotkeyStrokes({ sink, strokes: ["ctrl", "A"].map(keyStrokeForKey) }),
          ),
        ).toBe(failure);
        expect(calls.slice(-2)).toEqual([
          POINTER_SEQUENCE_OPERATIONS.keyRelease,
          POINTER_SEQUENCE_OPERATIONS.keyRelease,
        ]);
      }
    }),
  );
});

describe("batched typing", () => {
  const SHIFT = EVDEV_KEY_CODES.LeftShift;

  it("wraps a shifted stroke in Shift and leaves a plain one bare", () => {
    const [upper, lower] = qwertyTextKeyStrokes("Aa");
    expect(keyStrokeEvents(upper!)).toEqual([
      [SHIFT, true],
      [upper!.code, true],
      [upper!.code, false],
      [SHIFT, false],
    ]);
    expect(keyStrokeEvents(lower!)).toEqual([
      [lower!.code, true],
      [lower!.code, false],
    ]);
  });

  it("batches a word per call, bounded, never splitting a character", () => {
    const text = "Hello world, " + "x".repeat(40);
    const characters = [...text];
    const batches = typingBatches(characters, qwertyTextKeyStrokes(text));
    const texts: string[] = [];
    let at = 0;
    for (const batch of batches) {
      texts.push(characters.slice(at, at + batch.length).join(""));
      at += batch.length;
      const events = batch.flatMap(keyStrokeEvents).length;
      expect(events).toBeLessThanOrEqual(TYPING_BATCH_MAX_EVENTS);
    }
    expect(texts).toEqual(["Hello ", "world, ", "x".repeat(16), "x".repeat(16), "x".repeat(8)]);
  });

  it("names the keys a cut-short batch left held, newest first", () => {
    const events: KeyEvent[] = [
      [SHIFT, true],
      [30, true],
      [30, false],
      [SHIFT, false],
    ];
    expect(keysHeldAfter(events, 2)).toEqual([30, SHIFT]);
    expect(keysHeldAfter(events, 3)).toEqual([SHIFT]);
    expect(keysHeldAfter(events, 4)).toEqual([]);
  });

  it.effect("releases what a refused batch left held and reports the characters that landed", () =>
    Effect.gen(function* () {
      const text = "ab CD";
      const { sink, calls } = recordingSink();
      const batches: KeyEvent[][] = [];
      const progress: number[] = [];
      const refusal = new Refused({ message: "refused" });
      const error = yield* Effect.flip(
        typeStrokesInBatches({
          sink: {
            key: sink.key,
            // The first word lands; the second stops after D's key press.
            keys: (events) =>
              Effect.sync(() => {
                batches.push([...events]);
                return batches.length === 1 ? events.length : 6;
              }),
          },
          characters: [...text],
          strokes: qwertyTextKeyStrokes(text),
          onProgress: (typed) => progress.push(typed),
          refused: () => refusal,
        }),
      );
      expect(error).toBe(refusal);
      expect(batches).toHaveLength(2);
      // "ab " landed, then C in full (4 events) and D's Shift and press (2).
      expect(progress).toEqual([3, 4]);
      const d = qwertyTextKeyStrokes("D")[0]!.code;
      expect(calls).toEqual([
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${d} false`,
        `${POINTER_SEQUENCE_OPERATIONS.keyRelease} ${SHIFT} false`,
      ]);
    }),
  );

  it.effect("stops between words when the operation is cancelled", () =>
    Effect.gen(function* () {
      const text = "one two three";
      let sent = 0;
      const cancelled = new Refused({ message: "cancelled" });
      const error = yield* Effect.flip(
        typeStrokesInBatches({
          sink: {
            key: () => Effect.void,
            keys: (events) =>
              Effect.sync(() => {
                sent += 1;
                return events.length;
              }),
          },
          characters: [...text],
          strokes: qwertyTextKeyStrokes(text),
          beforeBatch: Effect.suspend(() => (sent === 2 ? Effect.fail(cancelled) : Effect.void)),
          onProgress: () => undefined,
          refused: () => new Refused({ message: "refused" }),
        }),
      );
      expect(error).toBe(cancelled);
      expect(sent).toBe(2);
    }),
  );
});
