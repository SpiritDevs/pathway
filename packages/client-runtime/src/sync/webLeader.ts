/**
 * Web Locks leader election: one sync-engine writer per (user/environment) scope across tabs.
 *
 * Each {@link SyncStore} commit is transactional on its own, but an engine cycle is a read →
 * decide → write sequence, and two tabs interleaving cycles over one IndexedDB database would
 * resend acknowledged operations and burn local sequences. So exactly one context runs the engine:
 * whoever holds the scope's exclusive Web Lock. The browser releases a held lock when its tab
 * dies, which is what makes this a leader election rather than a lease — no timers, no heartbeat
 * rows, no clock comparisons.
 *
 * The intended wiring is `election.withLeadership(...)` around engine construction *and* run —
 * construction already writes (the quarantine sweep), so it must not happen in a follower tab:
 *
 * ```ts
 * election.withLeadership(
 *   Effect.flatMap(makeSyncEngine(engineOptions), (engine) => engine.run),
 * )
 * ```
 *
 * `withLeadership` waits for the lock, runs the effect, and fails it with a
 * {@link WebLeaderError} (`reason: "lost"`) if leadership goes away first — a steal by another
 * context, or an explicit {@link WebLeaderElection.release}. A follower tab simply stays parked
 * inside `withLeadership` until the leader tab closes, then takes over: that is the handoff.
 *
 * The lock excludes other contexts, not other callers in this one, so leadership is tracked as a
 * set of claims over one lock: `acquire` and every in-flight `withLeadership` each hold a claim,
 * and the lock only goes back when the last claim does — one caller finishing can never pull the
 * lock out from under another. `withLeadership` bodies additionally run one at a time here, so a
 * restart (a StrictMode double-mount, a company switch, a retry after "lost") queues behind the
 * winding-down run instead of racing it over the same replica.
 *
 * Graceful degradation: when `navigator.locks` is unavailable (older WebViews, some test
 * runtimes), elections fall back to an in-process lock manager with the same queueing semantics.
 * Exclusion then only covers this JavaScript context — the documented single-tab assumption —
 * and {@link WebLeaderElection.crossContext} is `false` so callers can surface it.
 *
 * @module sync/webLeader
 */
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { SYNC_INDEXED_DB_PREFIX } from "./webNamespace.ts";

export class WebLeaderError extends Schema.TaggedErrorClass<WebLeaderError>()("WebLeaderError", {
  reason: Schema.Literals(["request-failed", "lost"]),
  lockName: Schema.String,
  message: Schema.String,
}) {}

/** The slice of a granted `Lock` this module reads. */
export interface WebLockLike {
  readonly name: string;
  readonly mode: "exclusive" | "shared";
}

/**
 * The slice of `navigator.locks` this module calls, structural so tests (and the in-process
 * fallback) can stand in for it without DOM globals.
 */
export interface WebLockManagerLike {
  readonly request: (
    name: string,
    options: { readonly mode: "exclusive"; readonly signal?: AbortSignal },
    callback: (lock: WebLockLike | null) => Promise<unknown>,
  ) => Promise<unknown>;
}

/** Lock name for one scope; the scope is the same string the IndexedDB store is keyed by. */
export function webLeaderLockName(scope: string): string {
  return `${SYNC_INDEXED_DB_PREFIX}/leader/${scope}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

/**
 * In-process stand-in for `navigator.locks`: same exclusive-mode queueing, no cross-context
 * reach. The degradation fallback uses one module-wide instance; tests build their own to
 * simulate two "tabs" sharing a lock manager.
 */
export function makeInProcessWebLockManager(): WebLockManagerLike {
  interface LockState {
    held: boolean;
    readonly queue: Array<() => void>;
  }
  const states = new Map<string, LockState>();
  const stateFor = (name: string): LockState => {
    const existing = states.get(name);
    if (existing !== undefined) return existing;
    const created: LockState = { held: false, queue: [] };
    states.set(name, created);
    return created;
  };
  const grantNext = (name: string) => {
    const state = states.get(name);
    if (state === undefined) return;
    const next = state.queue.shift();
    if (next === undefined) state.held = false;
    else next();
  };

  return {
    request: (name, options, callback) =>
      new Promise((resolve, reject) => {
        const state = stateFor(name);
        const start = () => {
          Promise.resolve()
            .then(() => callback({ name, mode: "exclusive" }))
            .then(resolve, reject)
            .finally(() => grantNext(name));
        };
        if (options.signal?.aborted === true) {
          reject(abortError(`The "${name}" lock request was aborted.`));
          return;
        }
        if (!state.held) {
          state.held = true;
          start();
          return;
        }
        const waiter = () => start();
        state.queue.push(waiter);
        // As with real Web Locks, the signal only cancels a *waiting* request; once granted, the
        // lock is held until the callback settles.
        options.signal?.addEventListener(
          "abort",
          () => {
            const index = state.queue.indexOf(waiter);
            if (index >= 0) {
              state.queue.splice(index, 1);
              reject(abortError(`The "${name}" lock request was aborted.`));
            }
          },
          { once: true },
        );
      }),
  };
}

let fallbackLockManager: WebLockManagerLike | null = null;

function ambientLockManager(): WebLockManagerLike | null {
  const navigatorLike = (globalThis as { navigator?: { locks?: WebLockManagerLike } }).navigator;
  return navigatorLike?.locks ?? null;
}

interface LeaderHold {
  /** Resolves the held callback, letting the lock go. */
  readonly releaseLock: () => void;
  /** Settles when this hold's lock is gone, whether released here or taken elsewhere. */
  readonly lost: Deferred.Deferred<void>;
}

/**
 * This context's current hold and the number of live claims sharing it — the explicit
 * {@link WebLeaderElection.acquire} and every in-flight {@link WebLeaderElection.withLeadership}.
 */
interface LeaderClaims {
  readonly hold: LeaderHold;
  readonly count: number;
}

/**
 * One `locks.request` whose callback holds the lock until `release` is called. Resolves when the
 * lock is granted; `onSettled` fires when a once-granted lock is over (released or stolen).
 */
function requestLeadership(input: {
  readonly locks: WebLockManagerLike;
  readonly lockName: string;
  readonly signal: AbortSignal;
  /**
   * Handed the release closure synchronously at the moment of the grant — before the promise
   * resolves, so a requester that has already gone away can still let the lock go. Aborting does
   * nothing once a lock is granted, so without this the closure would be unreachable and the lock
   * would stay held until the context dies.
   */
  readonly onGranted: (release: () => void) => void;
  readonly onSettled: () => void;
}): Promise<{ readonly release: () => void }> {
  return new Promise((resolveGranted, rejectGranted) => {
    let granted = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = () => {
      if (granted) input.onSettled();
    };
    input.locks
      .request(input.lockName, { mode: "exclusive", signal: input.signal }, async (lock) => {
        if (lock === null) {
          rejectGranted(new Error(`The "${input.lockName}" lock was not granted.`));
          return;
        }
        granted = true;
        input.onGranted(release);
        resolveGranted({ release });
        await held;
      })
      .then(settled, (error: unknown) => {
        // A rejection after the grant is a steal (or the manager failing); before it, the
        // request itself failed and `acquire` surfaces that.
        if (granted) input.onSettled();
        else rejectGranted(error);
      });
  });
}

export interface WebLeaderElectionOptions {
  /** Same string the IndexedDB store is scoped by: the user (and environment) this tab syncs. */
  readonly scope: string;
  /**
   * Injectable for tests; defaults to `navigator.locks`, then to the in-process fallback.
   * `null` skips the ambient manager and forces the fallback — for platforms that know Web Locks
   * is absent, and for tests exercising the degradation path deterministically.
   */
  readonly locks?: WebLockManagerLike | null;
}

export interface WebLeaderElection {
  readonly lockName: string;
  /** False when the in-process fallback arbitrates: exclusion covers this context only. */
  readonly crossContext: boolean;
  readonly isLeader: Effect.Effect<boolean>;
  /** Emits the current leadership flag and every change to it. */
  readonly changes: Stream.Stream<boolean>;
  /** Waits — indefinitely, by design — until this context holds the scope's lock. */
  readonly acquire: Effect.Effect<void, WebLeaderError>;
  /** Lets the lock go; the longest-waiting context is granted next. Idempotent. */
  readonly release: Effect.Effect<void>;
  /**
   * Acquires, runs the effect, and releases when it settles. The effect is interrupted and the
   * whole thing fails with `reason: "lost"` if leadership goes away while it runs. A second call
   * on the same election queues behind the first instead of running beside it, and the lock is
   * only let go once no other claim — another `withLeadership`, or an explicit `acquire` — is
   * still on it.
   */
  readonly withLeadership: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | WebLeaderError, R>;
}

export const makeWebLeaderElection = Effect.fn("makeWebLeaderElection")(function* (
  options: WebLeaderElectionOptions,
) {
  const ambient = options.locks === undefined ? ambientLockManager() : null;
  const explicit = options.locks ?? null;
  const chosen = explicit ?? ambient;
  const locks = chosen ?? (fallbackLockManager ??= makeInProcessWebLockManager());
  const crossContext = chosen !== null;
  const lockName = webLeaderLockName(options.scope);

  const leader = yield* SubscriptionRef.make(false);
  const claimsRef = yield* Ref.make<LeaderClaims | null>(null);
  // Serializes claim/release so two callers cannot double-request the same context's lock.
  const gate = yield* Semaphore.make(1);
  // One leadership body at a time in this context. The lock excludes other contexts; nothing but
  // this keeps two local callers from running engine cycles over one replica side by side.
  const bodyGate = yield* Semaphore.make(1);

  const dropHold = (hold: LeaderHold) =>
    Effect.gen(function* () {
      const claims = yield* Ref.get(claimsRef);
      if (claims === null || claims.hold !== hold) return;
      yield* Ref.set(claimsRef, null);
      yield* SubscriptionRef.set(leader, false);
    });

  /** Takes one claim on this context's leadership, waiting for the lock when there is no hold. */
  const claimLeadership: Effect.Effect<LeaderHold, WebLeaderError> = gate.withPermits(1)(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(claimsRef);
        if (current !== null && !Deferred.isDoneUnsafe(current.hold.lost)) {
          yield* Ref.set(claimsRef, { hold: current.hold, count: current.count + 1 });
          return current.hold;
        }
        const lost = yield* Deferred.make<void>();
        // The grant can land after this fiber is interrupted, and by then the release closure is
        // reachable from nowhere else: hand it straight back so the lock is not held forever by a
        // request nobody is waiting on any more.
        const abandoned: { gone: boolean; release: (() => void) | null } = {
          gone: false,
          release: null,
        };
        const granted = yield* restore(
          Effect.tryPromise({
            try: (signal) =>
              requestLeadership({
                locks,
                lockName,
                signal,
                onGranted: (release) => {
                  abandoned.release = release;
                  if (abandoned.gone) release();
                },
                onSettled: () => {
                  Deferred.doneUnsafe(lost, Effect.void);
                },
              }),
            catch: (error: unknown) =>
              new WebLeaderError({
                reason: "request-failed",
                lockName,
                message: describeError(error),
              }),
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                abandoned.gone = true;
                abandoned.release?.();
              }),
            ),
          ),
        );
        // Registration runs uninterruptibly: a grant this fiber consumed is always reachable
        // through `release`, even when an interrupt is already pending.
        const hold: LeaderHold = { releaseLock: granted.release, lost };
        yield* Ref.set(claimsRef, { hold, count: 1 });
        yield* SubscriptionRef.set(leader, true);
        // Keeps the flag honest when the lock is taken without a local release (a steal, or the
        // lock manager going away): subscribers see `false` even with no `withLeadership` racing.
        yield* Effect.forkDetach(Deferred.await(lost).pipe(Effect.flatMap(() => dropHold(hold))));
        return hold;
      }),
    ),
  );

  /** Gives one claim back; the lock only goes when the last claim on it does. */
  const releaseClaim = (hold: LeaderHold) =>
    gate.withPermits(1)(
      Effect.gen(function* () {
        const claims = yield* Ref.get(claimsRef);
        // Already released outright, or stolen and replaced: this claim owns nothing.
        if (claims === null || claims.hold !== hold) return;
        if (claims.count > 1) {
          yield* Ref.set(claimsRef, { hold, count: claims.count - 1 });
          return;
        }
        hold.releaseLock();
        yield* Deferred.await(hold.lost);
        yield* dropHold(hold);
      }),
    );

  const acquire = Effect.asVoid(claimLeadership);

  // Explicit release ends leadership outright, whatever else is claiming it: every racing
  // `withLeadership` then fails with `reason: "lost"`, which is the documented handoff.
  const release = gate.withPermits(1)(
    Effect.gen(function* () {
      const claims = yield* Ref.get(claimsRef);
      if (claims === null) return;
      claims.hold.releaseLock();
      yield* Deferred.await(claims.hold.lost);
      yield* dropHold(claims.hold);
    }),
  );

  const leadershipLost = (hold: LeaderHold): Effect.Effect<never, WebLeaderError> =>
    Deferred.await(hold.lost).pipe(
      Effect.flatMap(() =>
        Effect.fail(
          new WebLeaderError({
            reason: "lost",
            lockName,
            message: `Leadership of "${lockName}" was released or taken by another context.`,
          }),
        ),
      ),
    );

  const withLeadership = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | WebLeaderError, R> =>
    bodyGate.withPermits(1)(
      Effect.uninterruptibleMask((restore) =>
        // Waiting for the lock stays interruptible; the window between the grant and the
        // finalizer that gives the claim back does not.
        Effect.flatMap(restore(claimLeadership), (hold) =>
          restore(Effect.raceFirst(effect, leadershipLost(hold))).pipe(
            Effect.ensuring(releaseClaim(hold)),
          ),
        ),
      ),
    );

  return {
    lockName,
    crossContext,
    isLeader: SubscriptionRef.get(leader),
    changes: SubscriptionRef.changes(leader),
    acquire,
    release,
    withLeadership,
  } satisfies WebLeaderElection;
});

/**
 * The "engine as leader only" seam: `whileLeader(election, engineProgram)` where the program
 * builds the engine and runs it, so no store write ever happens in a follower context.
 */
export const whileLeader = <A, E, R>(
  election: WebLeaderElection,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | WebLeaderError, R> => election.withLeadership(effect);
