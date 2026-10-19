/**
 * Opt-in per-turn timing for computer calls: how long the model took to make
 * its first observation and first write, and the gap between observing and
 * writing. Local log lines only (`PATHWAY_CUA_TIMING_LOG=1`): no screenshots,
 * payloads, or model context.
 *
 * @module computer/computerTurnTiming
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { cuaTimingLogEnabled } from "./computerCallContext.ts";

type TurnTimingOrigin = "provider-turn-start" | "first-computer-call";

type TurnTiming = {
  started: number;
  origin: TurnTimingOrigin;
  firstObservation?: number;
  lastObservation?: number;
  firstWrite?: number;
};

export type ComputerTurnTimingRow = Record<string, number | string>;

/** Settles one call begun with `begin`; `completed=false` records nothing. */
export type ComputerTurnCallCompletion = (completed: boolean) => Effect.Effect<void>;

const MAX_TRACKED_TURNS = 256;

/** Opt-in local timing only: no screenshots, payloads, or model context. Time comes from `Clock`. */
export class ComputerTurnTimings {
  readonly #turns = new Map<string, TurnTiming>();
  readonly #emit: (row: ComputerTurnTimingRow) => Effect.Effect<void>;

  constructor(
    emit: (row: ComputerTurnTimingRow) => Effect.Effect<void> = (row) =>
      Effect.logInfo(`[computer-turn-timing] ${JSON.stringify(row)}`),
  ) {
    this.#emit = emit;
  }

  start(
    threadId: string,
    turnId: string,
    origin: TurnTimingOrigin = "provider-turn-start",
  ): Effect.Effect<void> {
    return Effect.map(Clock.currentTimeMillis, (now) =>
      this.#startAt(threadId, turnId, origin, now),
    );
  }

  end(threadId: string, turnId?: string): void {
    for (const key of this.#turns.keys()) {
      const [thread, turn] = JSON.parse(key) as [string, string];
      if (thread === threadId && (turnId === undefined || turn === turnId)) this.#turns.delete(key);
    }
  }

  begin(
    threadId: string,
    turnId: string,
    kind: "observation" | "write",
  ): Effect.Effect<ComputerTurnCallCompletion> {
    return Effect.map(Clock.currentTimeMillis, (started) => {
      this.#startAt(threadId, turnId, "first-computer-call", started);
      const key = JSON.stringify([threadId, turnId]);
      const state = this.#turns.get(key)!;
      // Capture the preceding observation at dispatch, not completion: a
      // concurrent read must not produce a negative observe-to-write interval.
      const observation = state.lastObservation;
      return (completed: boolean) =>
        Effect.suspend(() => {
          if (!completed || this.#turns.get(key) !== state) return Effect.void;
          return Effect.flatMap(Clock.currentTimeMillis, (ended) => {
            if (kind === "observation") {
              state.firstObservation ??= ended;
              state.lastObservation = ended;
            } else {
              state.firstWrite ??= started;
            }
            return this.#emit({
              threadId,
              turnId,
              origin: state.origin,
              kind,
              call_start_ms: Math.max(0, started - state.started),
              call_end_ms: Math.max(0, ended - state.started),
              ...(state.firstObservation === undefined
                ? {}
                : {
                    time_to_first_observation_ms: Math.max(
                      0,
                      state.firstObservation - state.started,
                    ),
                  }),
              ...(state.firstWrite === undefined
                ? {}
                : { time_to_first_write_ms: Math.max(0, state.firstWrite - state.started) }),
              ...(kind !== "write" || observation === undefined
                ? {}
                : {
                    observe_to_write_start_ms: Math.max(0, started - observation),
                    observe_to_write_end_ms: Math.max(0, ended - observation),
                  }),
            });
          });
        });
    });
  }

  #startAt(threadId: string, turnId: string, origin: TurnTimingOrigin, now: number): void {
    const key = JSON.stringify([threadId, turnId]);
    if (this.#turns.has(key)) return;
    while (this.#turns.size >= MAX_TRACKED_TURNS) {
      this.#turns.delete(this.#turns.keys().next().value!);
    }
    this.#turns.set(key, { started: now, origin });
  }
}

const timings = new ComputerTurnTimings();

/** Marks a provider turn's start, so the first computer call is timed from it. */
export const startComputerTurnTiming = (threadId: string, turnId: string): Effect.Effect<void> =>
  Effect.suspend(() => (cuaTimingLogEnabled() ? timings.start(threadId, turnId) : Effect.void));

export function endComputerTurnTiming(threadId: string, turnId?: string): void {
  timings.end(threadId, turnId);
}

/**
 * Begins timing one computer call in a turn. Resolves to the completion to run
 * when the call settles, or undefined when timing is off or the call has no turn.
 */
export const beginComputerTurnCall = (
  threadId: string,
  turnId: string | undefined,
  kind: "observation" | "write",
): Effect.Effect<ComputerTurnCallCompletion | undefined> =>
  Effect.suspend(() =>
    cuaTimingLogEnabled() && turnId ? timings.begin(threadId, turnId, kind) : Effect.undefined,
  );
