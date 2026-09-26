/**
 * One desktop operation includes targeting, input, and its returned observation.
 *
 * Synara threads an `AbortSignal` through `AsyncLocalStorage`. Here the
 * operation scope is a `Context.Reference` every forked fiber inherits, and a
 * signal is a set of `Deferred`s: failing any of them with a reason aborts the
 * operations that inherited it. An aborted operation is interrupted and fails
 * with the reason, rather than waiting for its next cooperative check.
 *
 * @module computer/DesktopOperationQueue
 */
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";

/** One cancellation source. Failing it with a reason aborts every operation that inherited it. */
export type DesktopAbort = Deferred.Deferred<never, ComputerOperationError>;

/** A composable cancellation signal: aborted once any of its sources is. */
export interface DesktopSignal {
  readonly sources: ReadonlyArray<DesktopAbort>;
}

export const makeDesktopAbort = (): DesktopAbort =>
  Deferred.makeUnsafe<never, ComputerOperationError>();

export const desktopSignal = (...sources: ReadonlyArray<DesktopAbort>): DesktopSignal => ({
  sources,
});

/** `AbortSignal.any` for desktop signals. */
export function composeDesktopSignals(
  ...signals: ReadonlyArray<DesktopSignal | undefined>
): DesktopSignal | undefined {
  const present = signals.filter((signal) => signal !== undefined);
  if (present.length <= 1) return present[0];
  return { sources: present.flatMap((signal) => signal.sources) };
}

/** Abort with a reason. Later aborts of the same source keep the first reason. */
export const abortDesktop = (abort: DesktopAbort, reason: ComputerOperationError) =>
  Deferred.fail(abort, reason);

export function isDesktopSignalAborted(signal: DesktopSignal | undefined): boolean {
  return signal?.sources.some(Deferred.isDoneUnsafe) ?? false;
}

/** `signal.throwIfAborted()`: fails with the first abort reason. */
export function checkDesktopSignal(
  signal: DesktopSignal | undefined,
): Effect.Effect<void, ComputerOperationError> {
  const aborted = signal?.sources.find(Deferred.isDoneUnsafe);
  return aborted ? Deferred.await(aborted) : Effect.void;
}

/** Suspends until the signal aborts, then fails with its reason. */
export function awaitDesktopSignal(
  signal: DesktopSignal | undefined,
): Effect.Effect<never, ComputerOperationError> {
  if (!signal || signal.sources.length === 0) return Effect.never;
  return Effect.raceAllFirst(signal.sources.map((source) => Deferred.await(source)));
}

/** Runs `effect` until it finishes or `signal` aborts, whichever is first. */
export function raceDesktopSignal<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  signal: DesktopSignal | undefined,
): Effect.Effect<A, E | ComputerOperationError, R> {
  if (!signal || signal.sources.length === 0) return effect;
  return Effect.raceFirst(effect, awaitDesktopSignal(signal));
}

export interface DesktopOperationScope {
  /** False once the operation that opened this scope ends; detached work sees no signal. */
  active: boolean;
  readonly signal: DesktopSignal | undefined;
}

export class DesktopOperationContext extends Context.Reference<DesktopOperationScope | undefined>(
  "@spiritdevs/pathway/computer/DesktopOperationContext",
  { defaultValue: () => undefined },
) {}

/** The raw operation scope; the `active` half is what admission checks need. */
export const desktopOperationContext = Effect.service(DesktopOperationContext);

export const desktopOperationSignal: Effect.Effect<DesktopSignal | undefined> = Effect.map(
  desktopOperationContext,
  (operation) => (operation?.active ? operation.signal : undefined),
);

function runInOperationScope<A, E, R>(
  scope: DesktopOperationScope,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ComputerOperationError, R> {
  return raceDesktopSignal(effect, scope.signal).pipe(
    Effect.provideService(DesktopOperationContext, scope),
    Effect.ensuring(
      Effect.sync(() => {
        scope.active = false;
      }),
    ),
  );
}

/** Runs `effect` under `signal` composed with the inherited operation signal. */
export const withDesktopOperationSignal = <A, E, R>(
  signal: DesktopSignal,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ComputerOperationError, R> =>
  Effect.flatMap(desktopOperationSignal, (parent) =>
    runInOperationScope({ active: true, signal: composeDesktopSignals(parent, signal) }, effect),
  );

/**
 * The caller's standing to drive the desktop, checked with the signal at every
 * dispatch point, so a check that passed before targeting is asked again after
 * it. The Computer tools bind it to the call's run and policy; pane input and
 * cleanup carry none.
 */
export class DesktopDispatchAuthority extends Context.Reference<
  Effect.Effect<void, ComputerOperationError>
>("@spiritdevs/pathway/computer/DesktopDispatchAuthority", {
  defaultValue: () => Effect.void,
}) {}

const assertDispatchAuthority: Effect.Effect<void, ComputerOperationError> = Effect.flatten(
  Effect.service(DesktopDispatchAuthority),
);

export const assertDesktopOperationActive: Effect.Effect<void, ComputerOperationError> =
  Effect.flatMap(desktopOperationSignal, checkDesktopSignal).pipe(
    Effect.andThen(assertDispatchAuthority),
  );

/** A detached continuation cannot turn a completed call into fresh input authority. */
export const assertDesktopOperationAdmission: Effect.Effect<void, ComputerOperationError> =
  Effect.flatMap(desktopOperationContext, (operation) => {
    if (operation && !operation.active) {
      return Effect.fail(
        new ComputerBackendError({
          message: "The computer operation has ended; no new input may be dispatched.",
        }),
      );
    }
    return Effect.andThen(checkDesktopSignal(operation?.signal), assertDispatchAuthority);
  });

/** Cleanup that must finish even when the operation around it is cancelled. */
export const withoutDesktopCancellation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.uninterruptible(
    effect.pipe(
      Effect.provideService(DesktopOperationContext, { active: true, signal: undefined }),
      Effect.provideService(DesktopDispatchAuthority, Effect.void),
    ),
  );

export type DesktopDeliveryModeValue = "background" | "foreground";

export class DesktopDeliveryMode extends Context.Reference<DesktopDeliveryModeValue>(
  "@spiritdevs/pathway/computer/DesktopDeliveryMode",
  { defaultValue: () => "background" },
) {}

export const desktopDeliveryMode = Effect.service(DesktopDeliveryMode);

export const withDesktopDeliveryMode = <A, E, R>(
  mode: DesktopDeliveryModeValue,
  effect: Effect.Effect<A, E, R>,
) => Effect.provideService(effect, DesktopDeliveryMode, mode);

export const DESKTOP_OPERATION_QUEUE_LIMIT = 64;

interface QueueFrame {
  readonly queue: DesktopOperationQueue;
  /** `undefined` for exclusive work, the target key for scoped work. */
  readonly key: string | undefined;
  active: boolean;
}

class DesktopQueueFrames extends Context.Reference<ReadonlyArray<QueueFrame>>(
  "@spiritdevs/pathway/computer/DesktopQueueFrames",
  { defaultValue: () => [] },
) {}

interface QueueEntry {
  readonly key: string | undefined;
  readonly ready: Deferred.Deferred<void>;
  readonly done: Deferred.Deferred<void>;
  started: boolean;
  abort: DesktopAbort | undefined;
}

/** Exclusive work conflicts with everything; scoped work only with its own key. */
const conflicts = (earlier: QueueEntry, later: QueueEntry) =>
  earlier.key === undefined || later.key === undefined || earlier.key === later.key;

const closedError = () => new ComputerBackendError({ message: "Computer manager is closed." });

/**
 * The desktop's admission queue: a writer barrier with per-key readers.
 *
 * `run` is exclusive and waits for everything admitted before it. `runScoped`
 * runs exact-target work concurrently with other keys, stays ordered behind
 * earlier work on its own key, and waits behind exclusive work queued first.
 * Calls made inside a running operation run inline, so a tool call's targeting,
 * input and observation stay one transaction.
 */
export class DesktopOperationQueue {
  private readonly entries: QueueEntry[] = [];
  private closed = false;

  run<A, E, R>(
    action: Effect.Effect<A, E, R>,
    signal?: DesktopSignal,
  ): Effect.Effect<A, E | ComputerOperationError, R> {
    return Effect.flatMap(Effect.service(DesktopQueueFrames), (frames) => {
      if (this.closed) return Effect.fail(closedError());
      // Tool calls wrap manager actions in the same transaction. Detached work
      // must enqueue again once that transaction finishes.
      if (this.activeFrame(frames)) return reentrant(action, signal);
      return this.admit(undefined, frames, action, signal);
    });
  }

  runScoped<A, E, R>(
    key: string,
    action: Effect.Effect<A, E, R>,
    signal?: DesktopSignal,
  ): Effect.Effect<A, E | ComputerOperationError, R> {
    return Effect.flatMap(Effect.service(DesktopQueueFrames), (frames) => {
      if (this.closed) return Effect.fail(closedError());
      const frame = this.activeFrame(frames);
      if (frame?.key !== undefined && frame.key !== key) {
        return Effect.fail(
          new ComputerBackendError({
            message: "A scoped computer operation cannot switch targets before it finishes.",
          }),
        );
      }
      if (frame) return reentrant(action, signal);
      return this.admit(key, frames, action, signal);
    });
  }

  /** Abort active work and reject queued work; native cleanup is backend-owned. */
  readonly close: Effect.Effect<void> = Effect.suspend(() => {
    this.closed = true;
    const pending = [...this.entries];
    for (const entry of pending) {
      if (entry.abort) Deferred.doneUnsafe(entry.abort, Effect.fail(closedError()));
      // Waiting work wakes, sees the queue closed, and fails without running.
      Deferred.doneUnsafe(entry.ready, Effect.void);
    }
    return Effect.forEach(pending, (entry) => Deferred.await(entry.done), { discard: true });
  });

  private activeFrame(frames: ReadonlyArray<QueueFrame>): QueueFrame | undefined {
    return frames.findLast((frame) => frame.queue === this && frame.active);
  }

  private admit<A, E, R>(
    key: string | undefined,
    frames: ReadonlyArray<QueueFrame>,
    action: Effect.Effect<A, E, R>,
    signal: DesktopSignal | undefined,
  ): Effect.Effect<A, E | ComputerOperationError, R> {
    if (this.entries.length >= DESKTOP_OPERATION_QUEUE_LIMIT) {
      return Effect.fail(
        new ComputerBackendError({
          message: "Too many computer operations are queued; try again later.",
          retryable: true,
        }),
      );
    }
    return Effect.flatMap(desktopOperationSignal, (inherited) =>
      Effect.uninterruptibleMask((restore) => {
        // Capture the caller's live scope before waiting: the queue owns its own
        // transaction, but RPC interruption and caller revocation still cancel it.
        const callerSignal = composeDesktopSignals(signal, inherited);
        const entry: QueueEntry = {
          key,
          ready: Deferred.makeUnsafe<void>(),
          done: Deferred.makeUnsafe<void>(),
          started: false,
          abort: undefined,
        };
        this.entries.push(entry);
        this.pump();
        const operation = raceDesktopSignal(Deferred.await(entry.ready), callerSignal).pipe(
          Effect.andThen(() =>
            this.closed ? Effect.fail(closedError()) : checkDesktopSignal(callerSignal),
          ),
          Effect.andThen(() => {
            const abort = makeDesktopAbort();
            entry.abort = abort;
            const frame: QueueFrame = { queue: this, key, active: true };
            return runInOperationScope(
              { active: true, signal: composeDesktopSignals(callerSignal, desktopSignal(abort)) },
              Effect.provideService(action, DesktopQueueFrames, [...frames, frame]),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  frame.active = false;
                }),
              ),
            );
          }),
        );
        return restore(operation).pipe(Effect.ensuring(Effect.sync(() => this.finish(entry))));
      }),
    );
  }

  private finish(entry: QueueEntry): void {
    const index = this.entries.indexOf(entry);
    if (index !== -1) this.entries.splice(index, 1);
    Deferred.doneUnsafe(entry.done, Effect.void);
    this.pump();
  }

  /** Starts every waiting entry that no earlier unfinished entry conflicts with. */
  private pump(): void {
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (entry.started) continue;
      let blocked = false;
      for (let earlier = 0; earlier < index; earlier += 1) {
        if (conflicts(this.entries[earlier]!, entry)) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      entry.started = true;
      Deferred.doneUnsafe(entry.ready, Effect.void);
    }
  }
}

function reentrant<A, E, R>(
  action: Effect.Effect<A, E, R>,
  signal: DesktopSignal | undefined,
): Effect.Effect<A, E | ComputerOperationError, R> {
  const run = signal
    ? withDesktopOperationSignal(signal, Effect.andThen(assertDesktopOperationActive, action))
    : action;
  return Effect.andThen(assertDesktopOperationActive, run);
}
