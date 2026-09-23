/**
 * The Computer calls each run has in flight, so Stop can end them with the
 * run, as Synara's in-flight request registry and `cancelTurn` do. Stop fences
 * the run first: a call that arrives after it is refused before it starts.
 * Then it aborts the run's live calls, which interrupts them wherever they
 * wait, and returns once they have unwound, bounded. A backend call already on
 * its way finishes; nothing after it is sent.
 *
 * @module computer/ComputerRunCalls
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { RunStopFence } from "../orchestration-v2/RunStopFence.ts";
import {
  type DesktopAbort,
  desktopSignal,
  makeDesktopAbort,
  withDesktopOperationSignal,
} from "./DesktopOperationQueue.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";

/** How long Stop waits for a stopped run's calls to unwind; Synara's bound. */
export const COMPUTER_RUN_STOP_DRAIN = Duration.seconds(2);

/** Stopped runs remembered, so a call racing Stop is refused on arrival. */
const STOPPED_MEMORY = 512;

interface LiveCall {
  readonly abort: DesktopAbort;
  readonly done: Deferred.Deferred<void>;
}

export interface ComputerRunCallsShape {
  /** Runs `effect` as one of the run's calls; a stopped run's call fails before it starts. */
  readonly run: <A, E, R>(
    threadId: string,
    runId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | ComputerOperationError, R>;
  /** Whether Stop has fenced the run. */
  readonly stopped: (threadId: string, runId: string) => boolean;
  /** Fences the run, aborts its calls and waits, bounded, for them to unwind. */
  readonly stop: (threadId: string, runId: string) => Effect.Effect<void>;
}

export class ComputerRunCalls extends Context.Service<ComputerRunCalls, ComputerRunCallsShape>()(
  "@spiritdevs/pathway/computer/ComputerRunCalls",
) {}

const stoppedError = () =>
  new ComputerBackendError({ message: "This turn was stopped, so Computer sent nothing more." });

const runKey = (threadId: string, runId: string) => `${threadId}\u0000${runId}`;

export const make = Effect.sync(() => {
  const live = new Map<string, Set<LiveCall>>();
  const stoppedRuns = new Set<string>();

  const run: ComputerRunCallsShape["run"] = (threadId, runId, effect) =>
    Effect.suspend(() => {
      const key = runKey(threadId, runId);
      if (stoppedRuns.has(key)) return Effect.fail(stoppedError());
      const call: LiveCall = { abort: makeDesktopAbort(), done: Deferred.makeUnsafe<void>() };
      let calls = live.get(key);
      if (calls === undefined) {
        calls = new Set();
        live.set(key, calls);
      }
      const running = calls;
      running.add(call);
      return withDesktopOperationSignal(desktopSignal(call.abort), effect).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            running.delete(call);
            if (running.size === 0 && live.get(key) === running) live.delete(key);
            Deferred.doneUnsafe(call.done, Effect.void);
          }),
        ),
      );
    });

  const stop: ComputerRunCallsShape["stop"] = (threadId, runId) =>
    Effect.suspend(() => {
      const key = runKey(threadId, runId);
      stoppedRuns.add(key);
      if (stoppedRuns.size > STOPPED_MEMORY) stoppedRuns.delete(stoppedRuns.values().next().value!);
      const calls = [...(live.get(key) ?? [])];
      if (calls.length === 0) return Effect.void;
      const reason = stoppedError();
      for (const call of calls) Deferred.doneUnsafe(call.abort, Effect.fail(reason));
      return Effect.forEach(calls, (call) => Deferred.await(call.done), { discard: true }).pipe(
        Effect.timeoutOption(COMPUTER_RUN_STOP_DRAIN),
        Effect.asVoid,
      );
    });

  return ComputerRunCalls.of({
    run,
    stopped: (threadId, runId) => stoppedRuns.has(runKey(threadId, runId)),
    stop,
  });
});

export const layer = Layer.effect(ComputerRunCalls, make);

/** Stop, and the end of any run, reach the run's Computer calls through this port. */
export const computerRunStopFenceLayer = Layer.effect(
  RunStopFence,
  Effect.gen(function* () {
    const calls = yield* ComputerRunCalls;
    return { stopRun: ({ threadId, runId }) => calls.stop(threadId, runId) };
  }),
);
