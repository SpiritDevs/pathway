import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";

import { type CuaComputerTask, cuaComputerTaskKey } from "@spiritdevs/shared/cuaDriverProtocol";

import {
  type HelperProcess,
  type HelperSpawnError,
  type HelperStopError,
  spawnHelper,
  stopHelper,
} from "./HelperProcess.ts";
import { decodeHelperJsonLine, PathwayHelperMode } from "./PathwayHelperProtocol.ts";

/** An engage that never hears back is a wedged helper, not a slow one. */
const SHIELD_ENGAGE_TIMEOUT_MS = 5_000;
/** How long `stop` lets a `quit` land before the signal ladder. */
const SHIELD_QUIT_GRACE_MS = 150;
const MAX_ENDED_TASKS = 256;
const MAX_LINE_LENGTH = 4_096;

export class ComputerShieldError extends Schema.TaggedErrorClass<ComputerShieldError>()(
  "ComputerShieldError",
  {
    reason: Schema.Literals([
      "closed",
      "not-listening",
      "timeout",
      "refused",
      "failed",
      "helper-exited",
      "stopped",
    ]),
    message: Schema.String,
  },
) {}

export interface ComputerShieldEngagement {
  /** Caller-minted id; survives a lost engage reply as the cleanup handle. */
  readonly shieldId: string;
  /** Screen rect to cover, top-left-origin points (CGWindowList space). */
  readonly frame: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly windowId: number;
  readonly pid: number;
  /** Painted on the shield; already sanitized by the protocol parser. */
  readonly label?: string;
}

export interface ComputerShield {
  /**
   * Presents the shield and succeeds once the helper confirms it is on
   * screen. Fails when the helper cannot engage; the caller treats that as
   * `mask_unavailable` and refuses the activation rather than degrading to an
   * unmasked excursion.
   */
  readonly engage: (
    request: ComputerShieldEngagement,
    task?: CuaComputerTask,
  ) => Effect.Effect<void, ComputerShieldError | HelperSpawnError>;
  /** Idempotent; returns once the command is queued. */
  readonly release: (shieldId: string) => Effect.Effect<void>;
  /** The forced-release path; returns how many live shields it dropped. */
  readonly releaseAll: Effect.Effect<number>;
  /** Releases every shield attributed to `task` (thread, or thread and turn). */
  readonly endTask: (task: CuaComputerTask) => Effect.Effect<void>;
  /** Drops every shield and stops the helper; the next engage respawns it. */
  readonly stop: Effect.Effect<void, HelperStopError>;
  readonly dispose: Effect.Effect<void, HelperStopError>;
}

interface LiveShield {
  readonly taskKey: string | undefined;
  readonly threadId: string | undefined;
}

interface ActiveHelper {
  readonly process: HelperProcess;
  exited: boolean;
}

/**
 * The masked activation shield host. Owns the `--shield` helper: spawned on
 * the first engage, stopped by `stop`, and tracks every live shield so a task
 * end or host teardown can drop it. The helper keeps the deeper guarantees
 * (parent pid, stdin EOF, per-shield TTL, Space and display changes), and
 * WindowServer removes its windows if the process dies. Closing the caller's
 * scope disposes the host.
 */
export const make = Effect.fn("desktop.computer.ComputerShield.make")(function* (options: {
  readonly helperPath: string;
  readonly onError?: (error: unknown) => Effect.Effect<void>;
}) {
  const scope = yield* Effect.scope;
  // Helpers live in a child scope that closes after `dispose` has asked the
  // helper to quit gracefully.
  const workScope = yield* Scope.fork(scope);
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();

  let helper: ActiveHelper | undefined;
  let spawning: Deferred.Deferred<ActiveHelper, ComputerShieldError | HelperSpawnError> | undefined;
  let closed = false;
  /** Bumped by every stop; a spawn that started before one is obsolete. */
  let stops = 0;
  const live = new Map<string, LiveShield>();
  const pending = new Map<string, Deferred.Deferred<void, ComputerShieldError>>();
  const endedTasks = new Set<string>();

  const shieldError = (reason: ComputerShieldError["reason"], message: string) =>
    new ComputerShieldError({ reason, message });

  const failPending = (error: ComputerShieldError) => {
    for (const deferred of pending.values()) Deferred.doneUnsafe(deferred, Exit.fail(error));
    pending.clear();
  };

  const settle = (id: string, exit: Exit.Exit<void, ComputerShieldError>) => {
    const deferred = pending.get(id);
    if (!deferred) return;
    pending.delete(id);
    Deferred.doneUnsafe(deferred, exit);
  };

  const write = (active: ActiveHelper, line: string) =>
    Effect.suspend(() => (active.exited ? Effect.succeed(false) : active.process.writeLine(line)));

  const helperDied = (active: ActiveHelper) =>
    Effect.sync(() => {
      // Helper exit is terminal for every shield it owned: WindowServer has
      // already torn the windows down, so only bookkeeping remains.
      active.exited = true;
      if (helper === active) helper = undefined;
      live.clear();
      failPending(shieldError("helper-exited", "The activation shield helper exited."));
    });

  const helperLine = (line: string) =>
    Effect.suspend(() => {
      if (line.length > MAX_LINE_LENGTH) return Effect.void;
      const decoded = decodeHelperJsonLine(line);
      if (Option.isNone(decoded)) return Effect.void;
      const message = decoded.value;
      if (message.type === "shield" && Predicate.isString(message.id)) {
        if (message.state === "engaged") settle(message.id, Exit.void);
        else {
          const code = Predicate.isString(message.code) ? `: ${message.code}` : "";
          const state = Predicate.isString(message.state) ? message.state : "unknown";
          settle(
            message.id,
            Exit.fail(
              shieldError("refused", `The activation shield was refused (${state}${code}).`),
            ),
          );
        }
        return Effect.void;
      }
      if (message.type === "error") {
        const text = Predicate.isString(message.message) ? message.message : "unknown";
        if (Predicate.isString(message.id) && pending.has(message.id)) {
          settle(
            message.id,
            Exit.fail(shieldError("failed", `The activation shield failed: ${text}`)),
          );
          return Effect.void;
        }
        return Effect.logWarning(`activation shield helper error: ${text}`);
      }
      return Effect.void;
    });

  const start = Effect.gen(function* () {
    const startedAfter = stops;
    const active: { current?: ActiveHelper } = {};
    const process = yield* spawnHelper(workScope, {
      command: options.helperPath,
      args: [PathwayHelperMode.shield],
      stdin: true,
      onStdoutLine: helperLine,
      onExit: () => (active.current ? helperDied(active.current) : Effect.void),
    }).pipe(Effect.provideContext(context));
    const exited = yield* process.hasExited;
    // A stop that ran during the spawn waits for it; the late helper must
    // not engage anything. No yield separates this check from adoption.
    if (startedAfter !== stops) {
      yield* Effect.ignore(stopHelper(process));
      return yield* shieldError("stopped", "The activation shield host stopped.");
    }
    const state: ActiveHelper = { process, exited };
    active.current = state;
    if (!state.exited) helper = state;
    return state;
  });

  const ensureStarted = Effect.suspend(
    (): Effect.Effect<ActiveHelper, ComputerShieldError | HelperSpawnError> => {
      if (helper && !helper.exited) return Effect.succeed(helper);
      if (spawning) return Deferred.await(spawning);
      const deferred = Deferred.makeUnsafe<ActiveHelper, ComputerShieldError | HelperSpawnError>();
      spawning = deferred;
      return start.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (spawning === deferred) spawning = undefined;
            Deferred.doneUnsafe(deferred, exit);
          }),
        ),
      );
    },
  );

  const release = (shieldId: string) =>
    Effect.suspend(() => {
      live.delete(shieldId);
      const active = helper;
      if (!active || active.exited) return Effect.void;
      return write(active, `release ${shieldId}`).pipe(Effect.asVoid);
    });

  const engage = (request: ComputerShieldEngagement, task?: CuaComputerTask) =>
    Effect.gen(function* () {
      if (closed) return yield* shieldError("closed", "The activation shield host is closed.");
      const taskKey = task ? cuaComputerTaskKey(task) : undefined;
      const active = yield* ensureStarted;
      const label = request.label !== undefined ? ` ${request.label}` : "";
      const { x, y, width, height } = request.frame;
      const line = `engage ${request.shieldId} ${x} ${y} ${width} ${height}${label}`;
      // The pending entry exists before the write so a helper that answers
      // at once still finds it.
      const confirmation = Deferred.makeUnsafe<void, ComputerShieldError>();
      pending.set(request.shieldId, confirmation);
      const forget = Effect.sync(() => {
        if (pending.get(request.shieldId) === confirmation) pending.delete(request.shieldId);
      });
      if (!(yield* write(active, line))) {
        yield* forget;
        return yield* shieldError(
          "not-listening",
          "The activation shield helper is not listening.",
        );
      }
      const confirmed = yield* Deferred.await(confirmation).pipe(
        Effect.timeoutOption(SHIELD_ENGAGE_TIMEOUT_MS),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.void
            : Effect.fail(shieldError("timeout", "The activation shield did not confirm in time.")),
        ),
        Effect.ensuring(forget),
        Effect.exit,
      );
      const ended = () => taskKey !== undefined && endedTasks.has(taskKey);
      if (Exit.isFailure(confirmed)) {
        // A confirmed shield would already be live; an unconfirmed one of an
        // ended task is released in case the reply was only late.
        if (ended()) yield* release(request.shieldId);
        return yield* Effect.failCause(confirmed.cause);
      }
      live.set(request.shieldId, { taskKey, threadId: task?.threadId });
      // A shield confirmed after its task ended must not linger until the TTL.
      if (ended()) yield* release(request.shieldId);
    });

  const releaseAll = Effect.suspend(() => {
    const released = live.size;
    live.clear();
    const active = helper;
    if (!active || active.exited) return Effect.succeed(released);
    return write(active, "release-all").pipe(Effect.as(released));
  });

  const endTask = (task: CuaComputerTask) =>
    Effect.suspend(() => {
      const key = cuaComputerTaskKey(task);
      endedTasks.add(key);
      while (endedTasks.size > MAX_ENDED_TASKS)
        endedTasks.delete(endedTasks.values().next().value!);
      const matching: Array<string> = [];
      for (const [shieldId, shield] of live) {
        if (shield.threadId !== task.threadId) continue;
        if (task.turnId !== undefined && shield.taskKey !== key) continue;
        matching.push(shieldId);
      }
      // A shield still mid-engage is released on confirmation by `engage`.
      return Effect.forEach(matching, release, { discard: true });
    });

  const stop = Effect.gen(function* () {
    stops += 1;
    const active = helper;
    const starting = spawning;
    helper = undefined;
    spawning = undefined;
    const released = live.size;
    live.clear();
    failPending(shieldError("stopped", "The activation shield host stopped."));
    // A spawn in flight stops its own helper when it lands.
    if (starting) yield* Effect.exit(Deferred.await(starting));
    if (!active) return;
    // Graceful first: `quit` lets the helper drop every shield itself before
    // the signal ladder.
    if (!active.exited && (yield* write(active, "quit")))
      yield* Effect.timeoutOption(active.process.exited, SHIELD_QUIT_GRACE_MS);
    yield* stopHelper(active.process);
    if (released > 0)
      yield* Effect.logInfo(`activation shield stop released ${released} live shield(s)`);
  });

  const dispose = Effect.suspend(() => {
    closed = true;
    return stop;
  });

  yield* Scope.addFinalizer(
    scope,
    dispose.pipe(
      Effect.catch((error) => options.onError?.(error) ?? Effect.void),
      Effect.annotateLogs({ component: "desktop-cua" }),
    ),
  );

  const shield: ComputerShield = {
    engage: (request, task) =>
      engage(request, task).pipe(Effect.annotateLogs({ component: "desktop-cua" })),
    release,
    releaseAll,
    endTask,
    stop: stop.pipe(Effect.annotateLogs({ component: "desktop-cua" })),
    dispose: dispose.pipe(Effect.annotateLogs({ component: "desktop-cua" })),
  };
  return shield;
});
