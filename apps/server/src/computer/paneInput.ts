/**
 * Marks desktop input the human sends from the Computer pane.
 *
 * The pane forwards a click, a wheel notch or a key as it happens, through the
 * same manager and backend path an agent's action takes, so a backend cannot
 * tell the two apart from the call alone. It needs to for presentation only:
 * the eased glide that makes an agent's pointer readable to someone watching
 * is pure latency on input the human is making themselves, and on a wheel it
 * queues one glide per notch. Nothing here grants or relaxes anything — pane
 * input goes through every guard and lease an agent's input does.
 *
 * Carried as a `Context.Reference`, so the queued operation and every fiber it
 * forks see the mark without the manager handing it through.
 *
 * @module computer/paneInput
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

class PaneInput extends Context.Reference<boolean>("@spiritdevs/pathway/computer/PaneInput", {
  defaultValue: () => false,
}) {}

/** Runs `effect` as the human's own pane input. */
export const withPaneInput = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, PaneInput, true);

/** Whether the input being dispatched now came from the human at the pane. */
export const isPaneInput: Effect.Effect<boolean> = Effect.service(PaneInput);
