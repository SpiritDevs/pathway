/**
 * Per-computer-call context for the action path, carried on a
 * `Context.Reference` so one tool call's dispatch, settle, and observation see
 * the same record without the caller handing anything through.
 *
 * The context carries two things:
 *
 * - `timing` — a `ComputerCallTiming` the manager and backend record legs
 *   into (resolve, dispatch, settle, observe, the native calls beneath them),
 *   logged as one `[computer-timing]` line when the outermost call ends.
 *   `PATHWAY_CUA_TIMING_LOG=1` only; unset, no record exists and the leg
 *   helpers are passthroughs.
 * - `actionProof` — the delivery verdict of the most recent action in the
 *   call, consumed once by the post-action observer when a proven effect
 *   waives the fixed settle. Scoped to the call so a stale verdict can never
 *   waive a later call's wait. This consumer is on by default; only
 *   `PATHWAY_CUA_CONDITIONAL_SETTLE=0` turns it off.
 *
 * When neither consumer is enabled no context is created at all, so a call
 * with both off still allocates nothing.
 *
 * Usage: the manager opens one context per tool call and runs the call under
 * it; everything beneath reads it back.
 *
 * ```ts
 * const context = yield* createComputerCallContext;
 * const run = markComputerCall("computer_click").pipe(
 *   Effect.andThen(timedComputerLeg("dispatch", backend.click(target))),
 * );
 * yield* context === undefined ? run : withComputerCallContext(context, run);
 * // …later, anywhere inside the call:
 * const proof = (yield* currentComputerCall)?.takeActionProof();
 * ```
 *
 * Like the other computer contexts, a detached continuation stops seeing the
 * context once the call that opened it ends.
 *
 * This module is also where the computer path's other env flags live. The ones
 * still gated default to the previous behavior so a live run can isolate a
 * single optimization at a time; the graduated ones default on with an
 * explicit-off kill switch.
 *
 * @module computer/computerCallContext
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type { ComputerBackendActionResult } from "./ComputerBackend.ts";

function envFlagEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/**
 * The graduated flags' kill switch: they ship on, and only an explicit
 * `0`/`false`/`off`/`no` turns them back off. Anything else — unset included —
 * leaves the optimization on.
 */
function envFlagDisabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "0" || normalized === "false" || normalized === "off" || normalized === "no"
  );
}

/** `PATHWAY_CUA_TIMING_LOG=1` logs one `[computer-timing]` line per computer call. */
export function cuaTimingLogEnabled(): boolean {
  return envFlagEnabled(process.env.PATHWAY_CUA_TIMING_LOG);
}

/**
 * The post-action settle is skipped when the action's own delivery result
 * already proves its effect. Graduated to the default: the skip still needs
 * positive proof on the same call, so opting out is only a kill switch for a
 * regression — `PATHWAY_CUA_CONDITIONAL_SETTLE=0` restores the always-wait.
 */
export function cuaConditionalSettleEnabled(): boolean {
  return !envFlagDisabled(process.env.PATHWAY_CUA_CONDITIONAL_SETTLE);
}

/**
 * `PATHWAY_CUA_ACTION_SETTLE_MS` overrides the fixed post-action settle.
 * Unset or unparsable means the compiled-in default; an explicit 0 removes
 * the wait entirely.
 */
export function cuaActionSettleMsOverride(): number | undefined {
  const raw = process.env.PATHWAY_CUA_ACTION_SETTLE_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Explicit perception reads reuse the latest delivered frame's
 * `screenshotId` when the fresh capture is byte-for-byte identical with the
 * same coordinate frame, instead of shipping the same pixels again. The
 * capture itself always happens — only identical bytes prove nothing
 * changed — so no stale picture is ever served; what is saved is the image
 * part of the tool result. Graduated to the default;
 * `PATHWAY_CUA_CAPTURE_REUSE=0` is the kill switch.
 */
export function cuaCaptureReuseEnabled(): boolean {
  return !envFlagDisabled(process.env.PATHWAY_CUA_CAPTURE_REUSE);
}

/**
 * `PATHWAY_CUA_PREVIEW_STILL_MS` overrides the pane's still-capture cadence
 * (the backend default is 1000 ms). Unset or unparsable means the compiled-in default; the
 * caller clamps the resolved value to the publisher's floor.
 */
export function cuaPreviewStillMsOverride(): number | undefined {
  const raw = process.env.PATHWAY_CUA_PREVIEW_STILL_MS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * What the backend established about the input it just delivered, verbatim:
 * `effect` is `verified` only when the driver proved the outcome, and
 * `verified` is `confirmed` only when an independent read-back saw it.
 */
export interface ComputerActionProof {
  readonly effect: ComputerBackendActionResult["effect"];
  readonly verified: ComputerBackendActionResult["verified"];
}

/**
 * One line per computer call: the operation name, each instrumented leg's
 * summed milliseconds, counters for repeated or skipped work, and the call's
 * wall time. Durations, counts, and fixed operation names only — window
 * titles, labels, pixels, and payload bytes never appear here.
 *
 * Build one with `makeComputerCallTiming`; the start time comes from `Clock`.
 */
export class ComputerCallTiming {
  readonly #startedAt: number;
  readonly #legs = new Map<string, number>();
  readonly #counts = new Map<string, number>();
  #operation: string | undefined;
  #failed = false;
  #finished = false;

  constructor(startedAt: number) {
    this.#startedAt = startedAt;
  }

  /** First writer wins: the outermost instrumented method names the call. */
  setOperation(operation: string): void {
    this.#operation ??= operation;
  }

  markFailed(): void {
    this.#failed = true;
  }

  /** Milliseconds spent in one named leg; repeated spans accumulate. */
  record(leg: string, ms: number): void {
    this.#legs.set(leg, (this.#legs.get(leg) ?? 0) + ms);
  }

  /** An occurrence that is not a duration, like a waived settle. */
  count(name: string, by = 1): void {
    this.#counts.set(name, (this.#counts.get(name) ?? 0) + by);
  }

  /** Runs `effect`, recording its duration under `leg` whether it succeeds or not. */
  span<A, E, R>(leg: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return Effect.flatMap(Clock.currentTimeMillis, (started) =>
      effect.pipe(
        Effect.ensuring(
          Effect.map(Clock.currentTimeMillis, (ended) => this.record(leg, ended - started)),
        ),
      ),
    );
  }

  /** Logs the call's line. Only the first finish logs; later ones are no-ops. */
  finish(): Effect.Effect<void> {
    return Effect.suspend(() => {
      if (this.#finished) return Effect.void;
      this.#finished = true;
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const parts = [`op=${this.#operation ?? "computer_call"}`];
        for (const [leg, ms] of [...this.#legs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
          parts.push(`${leg}_ms=${ms.toFixed(1)}`);
        }
        for (const [name, count] of [...this.#counts.entries()].sort(([a], [b]) =>
          a.localeCompare(b),
        )) {
          parts.push(`${name}=${count}`);
        }
        parts.push(`total_ms=${(now - this.#startedAt).toFixed(1)}`);
        if (this.#failed) parts.push("failed=1");
        return Effect.logInfo(`[computer-timing] ${parts.join(" ")}`);
      });
    });
  }
}

/** A timing record whose wall time starts now. */
export const makeComputerCallTiming: Effect.Effect<ComputerCallTiming> = Effect.map(
  Clock.currentTimeMillis,
  (startedAt) => new ComputerCallTiming(startedAt),
);

export class ComputerCallContext {
  readonly timing: ComputerCallTiming | undefined;
  #proof: ComputerActionProof | undefined;

  constructor(options: { readonly timing?: ComputerCallTiming }) {
    this.timing = options.timing;
  }

  /** The latest action's delivery verdict replaces the previous one's. */
  recordActionProof(result: ComputerBackendActionResult | undefined): void {
    this.#proof = { effect: result?.effect, verified: result?.verified };
  }

  /** Read once by the post-action observer, then cleared. */
  takeActionProof(): ComputerActionProof | undefined {
    const proof = this.#proof;
    this.#proof = undefined;
    return proof;
  }
}

interface ComputerCallScope {
  readonly context: ComputerCallContext;
  active: boolean;
}

class CurrentComputerCall extends Context.Reference<ComputerCallScope | undefined>(
  "@spiritdevs/pathway/computer/CurrentComputerCall",
  { defaultValue: () => undefined },
) {}

/** The context of the computer call this fiber is running inside, if any. */
export const currentComputerCall: Effect.Effect<ComputerCallContext | undefined> = Effect.map(
  Effect.service(CurrentComputerCall),
  (scope) => (scope?.active ? scope.context : undefined),
);

/** Runs `effect` as one computer call carrying `context`. */
export const withComputerCallContext = <A, E, R>(
  context: ComputerCallContext,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.suspend(() => {
    const scope: ComputerCallScope = { context, active: true };
    return effect.pipe(
      Effect.provideService(CurrentComputerCall, scope),
      Effect.ensuring(
        Effect.sync(() => {
          scope.active = false;
        }),
      ),
    );
  });

/**
 * The context for one computer call, or nothing when both consumers are off
 * — timing has always been opt-in, and conditional settle is off only where
 * it was explicitly disabled.
 */
export const createComputerCallContext: Effect.Effect<ComputerCallContext | undefined> =
  Effect.suspend(() => {
    const timed = cuaTimingLogEnabled();
    if (!timed && !cuaConditionalSettleEnabled()) return Effect.succeed(undefined);
    if (!timed) return Effect.succeed(new ComputerCallContext({}));
    return Effect.map(makeComputerCallTiming, (timing) => new ComputerCallContext({ timing }));
  });

/** Records `leg`'s duration on the active call's timing record, when one exists. */
export const timedComputerLeg = <A, E, R>(
  leg: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.flatMap(currentComputerCall, (call) =>
    call?.timing === undefined ? effect : call.timing.span(leg, effect),
  );

/** Names the active call after the tool-level operation running it. */
export const markComputerCall = (operation: string): Effect.Effect<void> =>
  Effect.map(currentComputerCall, (call) => call?.timing?.setOperation(operation));
