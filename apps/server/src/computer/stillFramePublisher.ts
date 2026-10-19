// @effect-diagnostics nodeBuiltinImport:off
/**
 * The still-frame stream every Tier-1 desktop backend publishes.
 *
 * A Tier-1 backend has no video encoder: it pulls one still on a timer and
 * pushes it at whoever is watching the pane. The still is always scoped to the
 * thing the agent is using — one exact window, or one browser tab — and never
 * the whole desktop: a capture with no such target returns `undefined` and
 * nothing is published. The loop around that is identical on every display
 * server — one interval, one capture in flight at a time, a byte-identity
 * dedupe (`StillFrameDedupe`), and the `force` bookkeeping that guarantees a
 * receiver with nothing to draw gets a picture even when the target has not
 * changed.
 *
 * The part worth stating is the failure bound. An earlier version re-armed the
 * deferred force whenever a forced capture failed, and then immediately
 * republished because a force was pending — so a target whose captures kept
 * failing (a revoked Screen Recording grant, a window that moved off the
 * current Space) spun in a tight retry loop for as long as anyone watched the
 * pane, with no delay between attempts. Here a failed force buys exactly one
 * immediate retry; after that the request is dropped and the ordinary timer
 * cadence takes over, so a persistent failure costs two captures per interval
 * instead of an unbounded recursion.
 *
 * A backend builds one publisher in its layer scope and maps its stream calls
 * onto it:
 *
 * ```ts
 * const stills = yield* makeStillFramePublisher({
 *   capture: (force) => captureTargetPng(force),
 *   isCaptureAvailable: () => grants.screenRecording,
 *   emit: (frame) => PubSub.publish(events, { type: "frame", frame }),
 *   intervalMs: resolveStillIntervalMs(config.intervalMs),
 * });
 * // attachStream: () => stills.attach, detachStream: () => stills.detach,
 * // requestKeyframe: () => stills.requestKeyframe
 * ```
 *
 * @module computer/stillFramePublisher
 */
import * as NodeCrypto from "node:crypto";
import type { ComputerFrameMimeType } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import type { ComputerStreamFrame } from "./ComputerBackend.ts";
import type { ComputerOperationError } from "./computerErrors.ts";

/**
 * Immediate retries a failed forced publish may buy before the request is
 * dropped. One, because the point of a retry here is to ride out a single
 * transient capture failure; anything past that is a broken capture path, and
 * the timer will ask again in a moment anyway.
 */
const MAX_FORCE_RETRIES = 1;

/**
 * How often a Tier-1 backend pulls a still when nobody asked for a faster one.
 * Twice a second: fast enough that the pane reads as live, slow enough that a
 * window PNG encode is not the machine's busiest job.
 */
export const DEFAULT_STILL_INTERVAL_MS = 500;

/**
 * The floor a caller-supplied interval is clamped to. Below this the capture
 * for one tick has not finished before the next is due, so the loop only ever
 * queues work it cannot do.
 */
export const MIN_STILL_INTERVAL_MS = 100;

/**
 * How often a paused publisher looks again. Only a flag is read per look; the
 * point is that the still after a desktop operation lands right after it, not
 * a whole interval later.
 */
const PAUSE_POLL_MS = 50;

/** The one clamp both Tier-1 backends apply to their configured interval. */
export function resolveStillIntervalMs(intervalMs: number | undefined): number {
  return Math.max(MIN_STILL_INTERVAL_MS, intervalMs ?? DEFAULT_STILL_INTERVAL_MS);
}

/**
 * Byte-identity key for a captured still. Length first so two frames of
 * different sizes never even reach the hash, then a digest of the pixels —
 * cheap next to the PNG encode that produced them.
 */
export function frameDigest(bytes: Uint8Array): string {
  return `${bytes.byteLength}:${NodeCrypto.createHash("sha1").update(bytes).digest("hex")}`;
}

/**
 * Suppresses still frames that carry no new picture. Owned by the ticker in
 * this file: one interval, one capture in flight, one digest memory. A
 * receiver with nothing to draw still gets a picture via `force`, including
 * a force that arrives mid-capture.
 */
export class StillFrameDedupe {
  #publishedDigest: string | undefined;
  #pendingForce = false;

  /**
   * Records a keyframe request that could not be served now. The next publish
   * consumes it, so a request arriving mid-capture is not lost.
   */
  deferForce(): void {
    this.#pendingForce = true;
  }

  /**
   * Whether this publish must go out regardless of the digest, consuming any
   * deferred request. Call once per publish attempt, before capturing.
   */
  takeForce(explicit: boolean): boolean {
    const force = explicit || this.#pendingForce;
    this.#pendingForce = false;
    return force;
  }

  /** True when a deferred keyframe is still owed to the receiver. */
  get forcePending(): boolean {
    return this.#pendingForce;
  }

  /**
   * Whether `bytes` should go on the wire, recording it as published when so.
   * `force` comes from `takeForce`.
   */
  shouldPublish(bytes: Uint8Array, force: boolean): boolean {
    const digest = frameDigest(bytes);
    if (!force && digest === this.#publishedDigest) return false;
    this.#publishedDigest = digest;
    return true;
  }

  /**
   * Forgets what was published. Called whenever the receiver changes or goes
   * away: a re-attached pane has seen nothing, so the memory of what the last
   * one saw must not suppress its first frame.
   */
  reset(): void {
    this.#publishedDigest = undefined;
    this.#pendingForce = false;
  }
}

/**
 * One encoded still with its image type, for a backend whose preview stills
 * are not PNG (a JPEG preview encodes an order of magnitude faster). A bare
 * byte array is a PNG.
 */
export interface StillFrameCapture {
  readonly data: Uint8Array;
  readonly mimeType: ComputerFrameMimeType;
}

export interface StillFramePublisherOptions {
  /**
   * Captures one still of the current target — the exact window the task is
   * using, or one browser tab — as raw PNG bytes, or as a `StillFrameCapture`
   * naming another image type.
   *
   * `undefined` means "skip this frame without treating it as a failure": there
   * is no target to capture, or the backend noticed mid-capture that publishing
   * is no longer appropriate. A failure (or defect) is what the retry bound
   * applies to.
   */
  readonly capture: (
    force: boolean,
  ) => Effect.Effect<Uint8Array | StillFrameCapture | undefined, ComputerOperationError>;
  /**
   * Whether a capture could succeed at all right now. Checked before every
   * publish so a backend whose capture grant is missing never spends a round
   * trip discovering that twice a second.
   */
  readonly isCaptureAvailable: () => boolean;
  /** Brought up before the first frame: the helper spawn, the plugin connect. */
  readonly prepare?: Effect.Effect<void, ComputerOperationError>;
  /** Broadcasts one frame to the backend's event observers (its `events` stream). */
  readonly emit: (frame: ComputerStreamFrame) => Effect.Effect<void>;
  readonly intervalMs: number;
  /**
   * The slower cadence a still target that stopped changing drops to: after
   * `idleAfterUnchanged` consecutive captures identical to the one the pane
   * already has, ticks come every `idleIntervalMs` instead of every
   * `intervalMs`, until a capture differs or `wake` runs. Both unset keeps one
   * fixed cadence.
   */
  readonly idleIntervalMs?: number;
  readonly idleAfterUnchanged?: number;
  /**
   * Whether stills should wait right now, typically because a desktop
   * operation is running and a still would only queue in front of its own
   * capture. Checked on every tick; the first tick after it clears publishes
   * at once and returns to the fast cadence.
   */
  readonly paused?: () => boolean;
}

export interface StillFramePublisher {
  /**
   * Starts publishing: prepares, sends a forced first still, then pulls one per
   * interval. Supersedes any earlier or in-progress attach.
   */
  readonly attach: Effect.Effect<void, ComputerOperationError>;
  /** Stops the interval loop and any capture, and forgets what the last receiver saw. */
  readonly detach: Effect.Effect<void>;
  /** Publishes a still even when it is byte-identical to the last one. No-op when detached. */
  readonly requestKeyframe: Effect.Effect<void>;
  /**
   * Something on the desktop changed (an action ran, a window moved): back to
   * the fast cadence, with the next tick no further away than one interval.
   */
  readonly wake: Effect.Effect<void>;
  /** One publish attempt; what each interval tick runs. Never fails. */
  readonly publish: (options?: { readonly force?: boolean }) => Effect.Effect<void>;
}

/**
 * Builds a publisher whose interval loop lives in the current scope. Closing
 * the scope detaches it.
 */
export const makeStillFramePublisher = (
  options: StillFramePublisherOptions,
): Effect.Effect<StillFramePublisher, never, Scope.Scope> =>
  Effect.gen(function* () {
    const scope = yield* Effect.scope;
    /** Suppresses stills identical to the one the pane already has. */
    const dedupe = new StillFrameDedupe();
    /** The one capture in flight, wherever it runs: the loop, an attach or a keyframe. */
    interface InFlight {
      readonly cancel: Deferred.Deferred<void>;
      readonly done: Deferred.Deferred<void>;
    }
    const state = {
      attached: false,
      generation: 0,
      loop: undefined as Fiber.Fiber<never> | undefined,
      inFlight: undefined as InFlight | undefined,
      nextSequence: 1,
      forceRetries: 0,
      /** Consecutive captures identical to the published still; see `idleIntervalMs`. */
      unchangedCaptures: 0,
      /** Whether the last tick found the publisher paused; see `paused`. */
      wasPaused: false,
      /** When the loop's next tick is due, and the signal that pulls it forward. */
      dueAt: 0,
      wakeUp: undefined as Deferred.Deferred<void> | undefined,
    };

    const emitFrame = (captured: Uint8Array | StillFrameCapture) =>
      Effect.flatMap(Clock.currentTimeMillis, (timestampMs) => {
        state.forceRetries = 0;
        const data = captured instanceof Uint8Array ? captured : captured.data;
        const mimeType = captured instanceof Uint8Array ? undefined : captured.mimeType;
        return options.emit({
          sequence: state.nextSequence++,
          timestampMs,
          // Every frame is a complete still. There is no H.264 codec config or
          // delta frame in Tier 1, so the envelope stays keyframe-only.
          keyframe: true,
          codecConfig: false,
          data,
          ...(mimeType !== undefined && mimeType !== "image/png" ? { mimeType } : {}),
        });
      });

    const publish = (request: { readonly force?: boolean } = {}): Effect.Effect<void> =>
      Effect.suspend(() => {
        const generation = state.generation;
        if (!state.attached || !options.isCaptureAvailable()) return Effect.void;
        if (state.inFlight) {
          // A keyframe asked for while a still is already in flight used to be
          // dropped outright. The in-flight capture then deduped against the
          // digest it had just published and sent nothing, so the receiver that
          // asked precisely because it had no picture stayed blank until the
          // target happened to change. The request is remembered instead.
          if (request.force) {
            state.forceRetries = 0;
            dedupe.deferForce();
          }
          return Effect.void;
        }
        const inFlight: InFlight = { cancel: Deferred.makeUnsafe(), done: Deferred.makeUnsafe() };
        state.inFlight = inFlight;
        // A fresh explicit request gets its own retry budget: the previous
        // receiver's exhausted one says nothing about this one.
        if (request.force === true) state.forceRetries = 0;
        const force = dedupe.takeForce(request.force === true);
        return options.capture(force).pipe(
          // A detach cancels the capture and the tick publishes nothing.
          Effect.raceFirst(Effect.as(Deferred.await(inFlight.cancel), undefined)),
          Effect.flatMap((captured) => {
            if (captured === undefined || state.generation !== generation) return Effect.void;
            // An idle target encodes the same bytes every tick; republishing
            // them spends about a megabyte of socket to convey nothing.
            const bytes = captured instanceof Uint8Array ? captured : captured.data;
            if (!dedupe.shouldPublish(bytes, force)) {
              state.unchangedCaptures += 1;
              return Effect.void;
            }
            state.unchangedCaptures = 0;
            return emitFrame(captured);
          }),
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
            // A transient capture failure must not tear down a subscribed
            // stream, and a bounded number of retries must not become an
            // unbounded one: past the budget the force is dropped and the
            // timer cadence takes over.
            if (
              state.generation === generation &&
              force &&
              state.forceRetries < MAX_FORCE_RETRIES
            ) {
              state.forceRetries += 1;
              dedupe.deferForce();
            }
            return Effect.void;
          }),
          Effect.ensuring(
            Effect.sync(() => {
              state.inFlight = undefined;
              Deferred.doneUnsafe(inFlight.done, Effect.void);
            }),
          ),
          // A forced request that arrived mid-flight is served now rather than
          // waiting for the next tick. A replacement attachment can be waiting
          // on this capture slot too.
          Effect.andThen(
            Effect.suspend(() => (dedupe.forcePending && state.attached ? publish() : Effect.void)),
          ),
        );
      });

    /** Sleeps `delayMs` unless `wake` pulls the tick forward; true when it did. */
    const sleepUnlessWoken = (delayMs: number) =>
      Effect.gen(function* () {
        const wakeUp = yield* Deferred.make<void>();
        state.dueAt = (yield* Clock.currentTimeMillis) + delayMs;
        state.wakeUp = wakeUp;
        return yield* Effect.raceFirst(
          Effect.as(Effect.sleep(Duration.millis(delayMs)), false),
          Effect.as(Deferred.await(wakeUp), true),
        );
      });

    const idleIntervalMs = options.idleIntervalMs;
    const idleAfterUnchanged = options.idleAfterUnchanged;

    /**
     * One tick per interval, measured start to start. A paused publisher looks
     * again every `PAUSE_POLL_MS`; a run of unchanged stills moves the next
     * tick out to the idle interval, measured from the tick that noticed.
     */
    const loop: Effect.Effect<never> = Effect.gen(function* () {
      let delayMs = options.intervalMs;
      while (true) {
        if (yield* sleepUnlessWoken(delayMs)) {
          delayMs = options.intervalMs;
          continue;
        }
        if (options.paused?.() === true) {
          state.wasPaused = true;
          delayMs = PAUSE_POLL_MS;
          continue;
        }
        if (state.wasPaused) {
          // The still right after an operation is the one worth having.
          state.wasPaused = false;
          state.unchangedCaptures = 0;
        }
        const startedAt = yield* Clock.currentTimeMillis;
        yield* publish();
        const idle =
          idleIntervalMs !== undefined &&
          idleAfterUnchanged !== undefined &&
          state.unchangedCaptures >= idleAfterUnchanged;
        const cadenceMs = idle ? idleIntervalMs : options.intervalMs;
        delayMs = Math.max(0, startedAt + cadenceMs - (yield* Clock.currentTimeMillis));
      }
    });

    const stopLoop = (fiber: Fiber.Fiber<never> | undefined) =>
      fiber === undefined ? Effect.void : Fiber.interrupt(fiber);

    /**
     * Invalidates every earlier attach, stops its loop and cancels the capture
     * in flight, so a replacement never waits on it; returns the new generation.
     */
    const supersede = Effect.suspend(() => {
      const generation = ++state.generation;
      const previous = state.loop;
      const inFlight = state.inFlight;
      state.attached = false;
      state.loop = undefined;
      dedupe.reset();
      if (inFlight) Deferred.doneUnsafe(inFlight.cancel, Effect.void);
      return stopLoop(previous).pipe(
        Effect.andThen(inFlight ? Deferred.await(inFlight.done) : Effect.void),
        Effect.as(generation),
      );
    });

    // Interruptible only while preparing and during the first capture: an
    // attach interrupted there ends detached, never marked attached without
    // its loop or with a loop nobody owns.
    const attach = Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const generation = yield* supersede;
        if (options.prepare) yield* restore(options.prepare);
        // A detach or newer attach supersedes this preparation, even when
        // preparations finish out of order.
        if (state.generation !== generation) return;
        state.attached = true;
        state.unchangedCaptures = 0;
        state.wasPaused = false;
        yield* restore(publish({ force: true })).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              if (state.generation === generation) state.attached = false;
            }),
          ),
        );
        if (state.generation !== generation) return;
        const fiber = yield* Effect.forkIn(loop, scope);
        // Installing the loop and checking the generation happen in one step, so
        // an attach that lost a race never leaves an orphaned loop behind.
        const orphan = yield* Effect.sync(() => {
          if (state.generation !== generation) return fiber;
          const previous = state.loop;
          state.loop = fiber;
          return previous;
        });
        yield* stopLoop(orphan);
      }),
    );

    const detach = Effect.asVoid(supersede);

    yield* Effect.addFinalizer(() => detach);

    return {
      attach,
      detach,
      // A keyframe is asked for because the receiver has nothing to draw, so
      // it publishes even when the target is byte-identical to the last frame.
      requestKeyframe: Effect.suspend(() =>
        state.attached ? publish({ force: true }) : Effect.void,
      ),
      wake: Effect.flatMap(Clock.currentTimeMillis, (now) =>
        Effect.sync(() => {
          state.unchangedCaptures = 0;
          const wakeUp = state.wakeUp;
          if (state.loop === undefined || wakeUp === undefined) return;
          if (state.dueAt - now > options.intervalMs) Deferred.doneUnsafe(wakeUp, Effect.void);
        }),
      ),
      publish,
    } satisfies StillFramePublisher;
  });
