/**
 * How a pointer glide and a key or button press are *sequenced* — as opposed to
 * how the individual events are transported.
 *
 * This is the timing and bookkeeping that has to be identical on every backend,
 * because it is what makes synthesized input look like a human's to a toolkit:
 * an eased path walked against a wall-clock deadline rather than a fixed sleep
 * per step, a shift that is released even when the stroke it wrapped failed, and
 * a hotkey whose modifiers come back up in the reverse of the order they went
 * down. Getting any of it wrong strands a modifier held on the user's real
 * keyboard, which is the worst failure mode this feature has.
 *
 * The transport is a sink the caller supplies, so the KWin and Hyprland
 * plugins' D-Bus calls go through the same sequencing. Time comes from the
 * Effect `Clock`, so a glide's deadlines and a button's hold follow whatever
 * clock the fiber runs under.
 *
 * @module computer/pointerSequencing
 */
import type { ComputerPoint } from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import { EVDEV_KEY_CODES, type QwertyKeyStroke } from "./evdevInput.ts";

/** One sample of an eased pointer path: where to move, and when it is due. */
export interface PointerGlideStep {
  readonly point: ComputerPoint;
  /** Wall-clock offset from the start of the glide at which this sample is due. */
  readonly offsetMs: number;
}

/** Longest gap between pointer samples. ~62 Hz reads as continuous motion. */
export const GLIDE_FRAME_INTERVAL_MS = 16;
/** Longest jump between samples, so a fast glide over a long path stays smooth. */
const GLIDE_MAX_STEP_PX = 80;
/**
 * Shorter than this, the pointer is already where it is going: the glide is
 * one move to the exact target, due at once. Twelve samples and 180 ms to
 * cross less than a pixel was the whole cost of every click on the spot the
 * cursor already sat on, and of every wheel notch sent from the pane.
 */
export const GLIDE_MIN_DISTANCE_PX = 1;
/**
 * How long a synthesized button stays down. Long enough that a toolkit's press
 * and release are not coalesced into nothing, short enough not to register as a
 * press-and-hold.
 */
export const BUTTON_HOLD_MS = 20;

/**
 * Names for the operations a sink performs, carried into the sink so a refusal
 * can say which half of a press/release pair the display server rejected.
 * "the plugin rejected key release" and "the plugin rejected key" are different
 * bugs, and a stranded modifier is only diagnosable from the difference.
 */
export const POINTER_SEQUENCE_OPERATIONS = {
  movePointer: "movePointer",
  buttonPress: "button",
  buttonRelease: "button release",
  keyPress: "key",
  keyRelease: "key release",
  shiftRelease: "shift release",
} as const;

/**
 * The transport a sequence drives. Each method must fail when the display
 * server refused the event; the sequencing here relies on that to abort a glide
 * and to still run its release path.
 */
export interface ComputerInputSink<E> {
  movePointer(x: number, y: number, operation: string): Effect.Effect<void, E>;
  button(code: number, pressed: boolean, operation: string): Effect.Effect<void, E>;
  key(code: number, pressed: boolean, operation: string): Effect.Effect<void, E>;
}

/**
 * Samples a smoothstep-eased path from `from` to `to` with a wall-clock
 * schedule attached.
 *
 * `offsetMs` is a deadline measured from the start of the glide, not a sleep
 * length. A caller sleeps only the remainder up to the deadline, so transport
 * latency is absorbed by the sleep budget instead of being added on top of it
 * and the glide lands at roughly `durationMs`. The final sample is due at
 * exactly `durationMs`; `durationMs === 0` makes every sample due immediately,
 * which degenerates to moving as fast as the transport allows. A path shorter
 * than `GLIDE_MIN_DISTANCE_PX` is a single sample, whatever the duration.
 */
export function pointerGlideSteps(
  from: ComputerPoint,
  to: ComputerPoint,
  durationMs: number,
  minimumSteps = 2,
): readonly PointerGlideStep[] {
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  if (!(distance >= GLIDE_MIN_DISTANCE_PX)) return [{ point: { x: to.x, y: to.y }, offsetMs: 0 }];
  const steps = Math.max(
    minimumSteps,
    Math.ceil(distance / GLIDE_MAX_STEP_PX),
    Math.ceil(duration / GLIDE_FRAME_INTERVAL_MS),
  );
  const path: PointerGlideStep[] = [];
  for (let index = 1; index <= steps; index += 1) {
    const linear = index / steps;
    const eased = linear * linear * (3 - 2 * linear);
    path.push({
      point: {
        x: from.x + (to.x - from.x) * eased,
        y: from.y + (to.y - from.y) * eased,
      },
      offsetMs: (duration * index) / steps,
    });
  }
  return path;
}

export interface PointerGlideOptions<E, EB> {
  readonly sink: Pick<ComputerInputSink<E>, "movePointer">;
  readonly from: ComputerPoint;
  readonly to: ComputerPoint;
  readonly durationMs: number;
  /**
   * Runs before every sample. Fails to abandon a glide whose backend went
   * away, which is what keeps a disposed backend from finishing a drag against
   * a connection nobody owns any more.
   */
  readonly beforeStep?: Effect.Effect<void, EB>;
  /** Reports where the pointer now is, so a caller's cached position tracks it. */
  readonly onStep?: (point: ComputerPoint) => void;
}

/**
 * Walks an eased path against a wall-clock deadline instead of a fixed sleep
 * per step, so a glide or drag lands at roughly the duration the caller asked
 * for. Each step sleeps only the remainder up to its deadline, which means a
 * slow transport round trip eats into that step's sleep budget rather than
 * adding to the total, and a duration of `0` sleeps not at all.
 */
export const glidePointerToDeadline = <E, EB = never>(
  options: PointerGlideOptions<E, EB>,
): Effect.Effect<void, E | EB> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    for (const step of pointerGlideSteps(options.from, options.to, options.durationMs)) {
      if (options.beforeStep !== undefined) yield* options.beforeStep;
      yield* options.sink.movePointer(
        step.point.x,
        step.point.y,
        POINTER_SEQUENCE_OPERATIONS.movePointer,
      );
      options.onStep?.(step.point);
      const remainingMs = startedAt + step.offsetMs - (yield* Clock.currentTimeMillis);
      if (remainingMs > 0) yield* Effect.sleep(Duration.millis(remainingMs));
    }
  });

/**
 * One complete key press: shift down if the stroke needs it, the key down and
 * up, then shift up. Shift is released whatever happened after it went down,
 * because a stroke that fails halfway must not leave shift latched on the
 * user's keyboard.
 */
export const pressKeyStroke = <E>(options: {
  readonly sink: Pick<ComputerInputSink<E>, "key">;
  readonly stroke: QwertyKeyStroke;
}): Effect.Effect<void, E> => {
  const { sink, stroke } = options;
  return releasingAfter<E>((held) =>
    Effect.gen(function* () {
      if (stroke.shift) {
        yield* sink.key(EVDEV_KEY_CODES.LeftShift, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
        held(sink.key(EVDEV_KEY_CODES.LeftShift, false, POINTER_SEQUENCE_OPERATIONS.shiftRelease));
      }
      yield* sink.key(stroke.code, true, POINTER_SEQUENCE_OPERATIONS.keyPress);
      yield* sink.key(stroke.code, false, POINTER_SEQUENCE_OPERATIONS.keyRelease);
    }),
  );
};

/**
 * A chord: every stroke pressed in order and held, then released in the reverse
 * order. The release list is built as the presses land, so a chord that fails
 * on its third key still releases the two that did go down — and only those.
 *
 * Every release is attempted even after one refuses: each release is its own
 * D-Bus call, and a transient refusal on the first would otherwise strand every
 * modifier behind it on the human's keyboard until the backend is disposed. The
 * first refusal is what surfaces, but only when the presses themselves had not
 * already failed — that error is the one worth acting on.
 */
export const pressHotkeyStrokes = <E>(options: {
  readonly sink: Pick<ComputerInputSink<E>, "key">;
  readonly strokes: readonly QwertyKeyStroke[];
}): Effect.Effect<void, E> => {
  const { sink, strokes } = options;
  const press = (code: number, held: (release: Effect.Effect<void, E>) => void) =>
    Effect.tap(sink.key(code, true, POINTER_SEQUENCE_OPERATIONS.keyPress), () =>
      Effect.sync(() => held(sink.key(code, false, POINTER_SEQUENCE_OPERATIONS.keyRelease))),
    );
  return releasingAfter<E>((held) =>
    Effect.gen(function* () {
      for (const stroke of strokes) {
        if (stroke.shift) yield* press(EVDEV_KEY_CODES.LeftShift, held);
        yield* press(stroke.code, held);
      }
    }),
  );
};

/** One key event as a batched sink takes it: evdev code, and pressed or released. */
export type KeyEvent = readonly [code: number, pressed: boolean];

/**
 * Most events one typing batch carries. A word is typically well under it; a
 * longer one is split at a character boundary. It bounds how much text lands
 * between two cancellation checks, which is what Stop waits for.
 */
export const TYPING_BATCH_MAX_EVENTS = 32;

/** The events one stroke is, in order: shift around the key when it needs it. */
export function keyStrokeEvents(stroke: QwertyKeyStroke): readonly KeyEvent[] {
  const key: readonly KeyEvent[] = [
    [stroke.code, true],
    [stroke.code, false],
  ];
  if (!stroke.shift) return key;
  return [[EVDEV_KEY_CODES.LeftShift, true], ...key, [EVDEV_KEY_CODES.LeftShift, false]];
}

/**
 * Text strokes grouped for batched delivery: a batch ends after a whitespace
 * character (one word per call) or before it would pass
 * `TYPING_BATCH_MAX_EVENTS`, and one character's events are never split
 * across two batches. `characters[i]` is what `strokes[i]` types.
 */
export function typingBatches(
  characters: readonly string[],
  strokes: readonly QwertyKeyStroke[],
): readonly (readonly QwertyKeyStroke[])[] {
  const batches: QwertyKeyStroke[][] = [];
  let batch: QwertyKeyStroke[] = [];
  let events = 0;
  strokes.forEach((stroke, index) => {
    const size = keyStrokeEvents(stroke).length;
    if (batch.length > 0 && events + size > TYPING_BATCH_MAX_EVENTS) {
      batches.push(batch);
      batch = [];
      events = 0;
    }
    batch.push(stroke);
    events += size;
    if (/\s/.test(characters[index] ?? "")) {
      batches.push(batch);
      batch = [];
      events = 0;
    }
  });
  if (batch.length > 0) batches.push(batch);
  return batches;
}

/**
 * The keys the first `delivered` of `events` left held, in release order
 * (newest first): a batch the display server stopped part-way through may
 * have pressed a key, or Shift, whose release never went out.
 */
export function keysHeldAfter(events: readonly KeyEvent[], delivered: number): readonly number[] {
  const held: number[] = [];
  for (const [code, pressed] of events.slice(0, delivered)) {
    const index = held.lastIndexOf(code);
    if (pressed) held.push(code);
    else if (index !== -1) held.splice(index, 1);
  }
  return held.toReversed();
}

/**
 * Types text in batches through a sink that delivers several key events per
 * call and answers how many it delivered (stopping at the first it could
 * not). Before every batch `beforeBatch` runs, so a cancelled operation stops
 * at a word boundary. A batch cut short has whatever it left held released,
 * one event at a time, before failing with `refused()`; `onProgress` has by
 * then been told how many characters landed in full, which is what a caller
 * reports instead of retrying the whole text.
 */
export const typeStrokesInBatches = <E, EB = never>(options: {
  readonly sink: Pick<ComputerInputSink<E>, "key"> & {
    keys(events: readonly KeyEvent[]): Effect.Effect<number, E>;
  };
  readonly characters: readonly string[];
  readonly strokes: readonly QwertyKeyStroke[];
  readonly beforeBatch?: Effect.Effect<void, EB>;
  readonly onProgress: (characters: number) => void;
  readonly refused: () => E;
}): Effect.Effect<void, E | EB> =>
  Effect.gen(function* () {
    let typed = 0;
    for (const batch of typingBatches(options.characters, options.strokes)) {
      if (options.beforeBatch !== undefined) yield* options.beforeBatch;
      const events = batch.flatMap(keyStrokeEvents);
      const answered = yield* options.sink.keys(events);
      const delivered = Math.max(0, Math.min(events.length, answered));
      if (delivered === events.length) {
        typed += batch.length;
        options.onProgress(typed);
        continue;
      }
      // Every release is attempted; the refusal, the earlier failure, is what
      // surfaces, as in `pressKeyStroke`.
      yield* Effect.uninterruptible(
        firstFailureOf(
          keysHeldAfter(events, delivered).map((code) =>
            options.sink.key(code, false, POINTER_SEQUENCE_OPERATIONS.keyRelease),
          ),
        ),
      );
      let covered = 0;
      for (const stroke of batch) {
        covered += keyStrokeEvents(stroke).length;
        if (covered > delivered) break;
        typed += 1;
      }
      options.onProgress(typed);
      return yield* Effect.fail(options.refused());
    }
  });

/** One button press held for long enough to register, released even on failure. */
export const pressButtonOnce = <E>(options: {
  readonly sink: Pick<ComputerInputSink<E>, "button">;
  readonly code: number;
  readonly holdMs?: number;
}): Effect.Effect<void, E> => {
  const { sink, code } = options;
  return releasingAfter<E>((held) =>
    Effect.gen(function* () {
      yield* sink.button(code, true, POINTER_SEQUENCE_OPERATIONS.buttonPress);
      held(sink.button(code, false, POINTER_SEQUENCE_OPERATIONS.buttonRelease));
      yield* Effect.sleep(Duration.millis(options.holdMs ?? BUTTON_HOLD_MS));
    }),
  );
};

/**
 * Runs `body`, then every release it registered through `held`, newest first,
 * whether the body succeeded, failed or was interrupted. The releases run
 * uninterruptibly: a Stop that lands mid-chord still lets its modifiers up.
 * The body's failure outranks a release's; a release's surfaces only when the
 * body had none.
 */
const releasingAfter = <E>(
  body: (held: (release: Effect.Effect<void, E>) => void) => Effect.Effect<void, E>,
): Effect.Effect<void, E> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const releases: Effect.Effect<void, E>[] = [];
      const exit = yield* Effect.exit(restore(body((release) => void releases.push(release))));
      const releaseFailure = yield* firstFailureOf(releases.toReversed());
      if (Exit.isFailure(exit)) return yield* exit;
      if (releaseFailure !== undefined) return yield* releaseFailure;
    }),
  );

/**
 * Runs every step even when some refuse, answering the first refusal.
 *
 * This is the shape every release path takes: one display-server refusal must
 * cost that one event, not every event queued behind it.
 */
const firstFailureOf = <E>(
  steps: readonly Effect.Effect<void, E>[],
): Effect.Effect<Exit.Failure<void, E> | undefined> =>
  Effect.gen(function* () {
    let first: Exit.Failure<void, E> | undefined;
    for (const step of steps) {
      const exit = yield* Effect.exit(step);
      if (Exit.isFailure(exit)) first ??= exit;
    }
    return first;
  });
