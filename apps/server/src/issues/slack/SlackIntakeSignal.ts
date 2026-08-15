/**
 * SlackIntakeSignal - the one-bit channel between a settings write and the poll loop.
 *
 * The loop sleeps for thirty seconds between passes. Without this, watching a new channel or
 * saving a token would do nothing visible for up to half a minute, which reads as broken. With
 * it, the write wakes the loop and the next pass starts immediately.
 *
 * A sliding queue of one rather than a semaphore or a deferred: three writes while the loop is
 * mid-pass are one thing to do afterwards, not three, and offering into a sliding queue never
 * blocks — which matters, because {@link SlackIntakeEngineShape.notifyWatchesChanged} is called
 * inside a settings write that must not fail because the poller was busy.
 *
 * Its own tag rather than a field on the engine or the poller, because it is the one thing both
 * halves hold: the engine offers, the poller takes, and neither has to know the other exists.
 *
 * @module issues/slack/SlackIntakeSignal
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";

export interface SlackIntakeSignalShape {
  /** Ask for a pass now. Never blocks, never fails, and coalesces with any pending ask. */
  readonly notify: Effect.Effect<void>;
  /** Wait for the next ask. The poller races this against its interval. */
  readonly awaitNotification: Effect.Effect<void>;
}

export class SlackIntakeSignal extends Context.Service<SlackIntakeSignal, SlackIntakeSignalShape>()(
  "@spiritdevs/pathway/issues/slack/SlackIntakeSignal",
) {}

export const make = Effect.gen(function* () {
  const pending = yield* Queue.sliding<void>(1);
  return {
    notify: Effect.asVoid(Queue.offer(pending, undefined)),
    awaitNotification: Effect.asVoid(Effect.orDie(Queue.take(pending))),
  } satisfies SlackIntakeSignalShape;
});

export const layer = Layer.effect(SlackIntakeSignal, make);
