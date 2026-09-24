// @effect-diagnostics nodeBuiltinImport:off -- Frames arrive on a private Unix socket served with node:net, in a 0700 temp directory.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/unstable/process";

import {
  type CuaComputerTask,
  type CuaPreviewTarget,
  cuaComputerTaskKey,
} from "@spiritdevs/shared/cuaDriverProtocol";

import { COMPUTER_PREVIEW_FRAME_CHANNEL } from "../ipc/channels.ts";
import {
  type HelperProcess,
  type HelperSpawnError,
  type HelperStopError,
  spawnHelper,
  stopHelper,
} from "./HelperProcess.ts";
import { decodeHelperJsonLine, PathwayHelperMode } from "./PathwayHelperProtocol.ts";

const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const MAX_DEAD_TARGETS = 256;
const MAX_LINE_LENGTH = 4_096;

export interface ComputerPreviewFrame {
  readonly windowId: number;
  readonly seq: number;
  readonly jpeg: Uint8Array;
}

export class ComputerFrameTapError extends Schema.TaggedErrorClass<ComputerFrameTapError>()(
  "ComputerFrameTapError",
  {
    reason: Schema.Literals([
      "malformed-frame",
      "capture-failed",
      "helper-exited",
      "socket",
      "filesystem",
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export type ComputerFrameTapFailure = ComputerFrameTapError | HelperSpawnError | HelperStopError;

export interface ComputerFrameTap {
  /** Points the tap at `target`. Returns at once; a dead target is ignored until its task ends. */
  readonly update: (target: CuaPreviewTarget) => Effect.Effect<void>;
  /**
   * Whether a preview is on screen to receive frames. Unwatched, the helper
   * stops but the target is kept, so watching again resumes the same capture.
   * Starts unwatched; completes once the helper has stopped or started.
   */
  readonly setWatched: (watched: boolean) => Effect.Effect<void>;
  /** Stops a tap owned by `task` and forgets that task's dead targets. */
  readonly endTask: (task: CuaComputerTask) => Effect.Effect<void, ComputerFrameTapFailure>;
  readonly stop: Effect.Effect<void, ComputerFrameTapFailure>;
  /** Stops the tap and removes the socket directory. */
  readonly dispose: Effect.Effect<void, ComputerFrameTapFailure>;
}

export interface ComputerFrameTapOptions {
  readonly helperPath: string;
  readonly send: (channel: string, frame: ComputerPreviewFrame) => Effect.Effect<void>;
  readonly onError: (error: unknown) => Effect.Effect<void>;
}

interface ActiveTap {
  process: HelperProcess | undefined;
  readonly server: NodeNet.Server;
  readonly socketPath: string;
  connection: NodeNet.Socket | undefined;
  readonly task: CuaComputerTask;
  readonly key: string;
  readonly windowId: number;
  exited: boolean;
  retiring: boolean;
}

const tapTargetKey = (target: CuaPreviewTarget) =>
  `${cuaComputerTaskKey(target.task)}:${target.pid}:${target.windowId}`;

/** Every task key of `threadId` starts with this, whatever its turn. */
const threadKeyPrefix = (threadId: string) =>
  cuaComputerTaskKey({ threadId }).slice(0, -"null]".length);

const fsError = (message: string) => (cause: unknown) =>
  new ComputerFrameTapError({ reason: "filesystem", message, cause });

/**
 * One task, one target, one helper process. Frames travel helper to a private
 * Unix socket to the renderer; they never enter the driver request path. A
 * dead tap stays dead for its target: `update` for the same key never
 * respawns it until the task ends. Closing the caller's scope disposes it.
 */
export const make = Effect.fn("desktop.computer.ComputerFrameTap.make")(function* (
  options: ComputerFrameTapOptions,
) {
  const scope = yield* Effect.scope;
  // Helpers and socket work live in a child scope that closes after
  // `dispose` has retired the tap and removed its directory.
  const workScope = yield* Scope.fork(scope);
  const context = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const runFork = yield* FiberSet.makeRuntime<never>().pipe(Scope.provide(workScope));

  let desired: CuaPreviewTarget | undefined;
  let watched = false;
  let active: ActiveTap | undefined;
  let reconciling: Deferred.Deferred<void, ComputerFrameTapFailure> | undefined;
  let failure: ComputerFrameTapFailure | undefined;
  let revision = 0;
  let appliedRevision = -1;
  let sequence = 0;
  let directory: string | undefined;
  const deadTargets = new Set<string>();

  const reportError = (error: unknown) => Effect.exit(options.onError(error)).pipe(Effect.asVoid);

  const socketDirectory = Effect.gen(function* () {
    if (directory) return directory;
    const created = yield* Effect.tryPromise({
      try: async () => {
        const path = await NodeFS.promises.mkdtemp(
          NodePath.join(NodeOS.tmpdir(), "pathway-frames-"),
        );
        await NodeFS.promises.chmod(path, 0o700);
        return path;
      },
      catch: fsError("Could not create the computer frame socket directory."),
    });
    // Two starts never race: reconcile runs one at a time.
    directory = created;
    return created;
  });

  const closeServer = (server: NodeNet.Server) =>
    Effect.callback<void>((resume) => {
      if (!server.listening) return resume(Effect.void);
      server.close(() => resume(Effect.void));
    });

  const removeSocket = (socketPath: string) =>
    Effect.promise(() => NodeFS.promises.rm(socketPath, { force: true }).catch(() => undefined));

  const deliver = (tap: ActiveTap, frames: ReadonlyArray<Uint8Array>) => {
    if (active !== tap || tap.retiring || tap.exited || frames.length === 0) return;
    const numbered = frames.map((jpeg) => ({ windowId: tap.windowId, seq: ++sequence, jpeg }));
    runFork(
      Effect.forEach(
        numbered,
        (frame) =>
          options
            .send(COMPUTER_PREVIEW_FRAME_CHANNEL, frame)
            .pipe(Effect.catchCause((cause) => reportError(cause))),
        { discard: true },
      ),
    );
  };

  const attach = (tap: ActiveTap, socket: NodeNet.Socket) => {
    if (tap.connection || tap.retiring || active !== tap) {
      socket.destroy();
      return;
    }
    tap.connection = socket;
    socket.on("error", () => undefined);
    let pending: Buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      if (tap.exited) return;
      pending = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk;
      const frames: Array<Uint8Array> = [];
      for (;;) {
        if (pending.length < 4) break;
        const length = pending.readUInt32LE(0);
        if (length === 0 || length > MAX_FRAME_BYTES) {
          deliver(tap, frames);
          pending = Buffer.alloc(0);
          runFork(
            kill(
              tap,
              new ComputerFrameTapError({
                reason: "malformed-frame",
                message: "Computer frame tap sent a malformed frame.",
              }),
            ),
          );
          return;
        }
        if (pending.length < 4 + length) break;
        frames.push(pending.subarray(4, 4 + length));
        pending = pending.subarray(4 + length);
      }
      deliver(tap, frames);
    });
    socket.once("close", () => {
      if (tap.connection === socket) tap.connection = undefined;
    });
  };

  const helperLine = (tap: ActiveTap, line: string) =>
    Effect.suspend(() => {
      if (line.length > MAX_LINE_LENGTH || active !== tap) return Effect.void;
      const message = decodeHelperJsonLine(line);
      if (Option.isNone(message) || message.value.type !== "error") return Effect.void;
      const code = message.value.code;
      return kill(
        tap,
        new ComputerFrameTapError({
          reason: "capture-failed",
          message: `Computer frame tap: ${typeof code === "string" ? code : "capture failed"}`,
        }),
      );
    });

  /**
   * Marks `tap` dead at once and returns the follow-up (report, reconcile).
   * Unexpected helper death poisons only this target; retire kills are exempt.
   */
  const kill = (tap: ActiveTap, error: unknown): Effect.Effect<void> => {
    const wasExited = tap.exited;
    tap.exited = true;
    const report = error !== undefined ? reportError(error) : Effect.void;
    if (active !== tap || tap.retiring || wasExited) return report;
    deadTargets.add(tap.key);
    while (deadTargets.size > MAX_DEAD_TARGETS)
      deadTargets.delete(deadTargets.values().next().value!);
    if (desired && tapTargetKey(desired) === tap.key) {
      desired = undefined;
      revision += 1;
    }
    return report.pipe(Effect.andThen(reconcileInBackground));
  };

  const start = (target: CuaPreviewTarget) =>
    Effect.gen(function* () {
      const parent = yield* socketDirectory;
      const socketPath = NodePath.join(parent, `tap-${NodeCrypto.randomUUID().slice(0, 8)}.sock`);
      const server = NodeNet.createServer((socket) => attach(tap, socket));
      const tap: ActiveTap = {
        process: undefined,
        server,
        socketPath,
        connection: undefined,
        task: target.task,
        key: tapTargetKey(target),
        windowId: target.windowId,
        exited: false,
        retiring: false,
      };
      const release = closeServer(server).pipe(Effect.andThen(removeSocket(socketPath)));
      yield* Effect.callback<void, ComputerFrameTapError>((resume) => {
        const onListenError = (cause: Error) =>
          resume(
            Effect.fail(
              new ComputerFrameTapError({
                reason: "socket",
                message: "Could not listen on the computer frame socket.",
                cause,
              }),
            ),
          );
        server.once("error", onListenError);
        server.listen(socketPath, () => {
          server.off("error", onListenError);
          resume(Effect.void);
        });
      }).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => NodeFS.promises.chmod(socketPath, 0o600),
            catch: fsError("Could not restrict the computer frame socket."),
          }),
        ),
        Effect.onError(() => release),
      );
      server.on("error", (cause) => runFork(kill(tap, cause)));
      // Claim the slot before the helper can connect, or its connection would
      // be rejected as an unknown peer.
      active = tap;
      const spawned = yield* spawnHelper(workScope, {
        command: options.helperPath,
        args: [
          PathwayHelperMode.computerFrames,
          "--window-id",
          String(target.windowId),
          "--pid",
          String(target.pid),
          "--out",
          socketPath,
        ],
        onStdoutLine: (line) => helperLine(tap, line),
        // The protocol has no graceful-stop event, so every exit is terminal.
        // Only an exit the tap did not ask for is worth reporting.
        onExit: (exit) =>
          Effect.suspend(() =>
            kill(
              tap,
              active === tap && !tap.retiring && !tap.exited
                ? new ComputerFrameTapError({
                    reason: "helper-exited",
                    message: `Computer frame tap helper exited (${exit.code === null ? "signal" : `code ${exit.code}`}).`,
                  })
                : undefined,
            ),
          ),
      }).pipe(
        Effect.provideContext(context),
        Effect.onError(() =>
          Effect.suspend(() => {
            if (active === tap) active = undefined;
            return release;
          }),
        ),
      );
      tap.process = spawned;
    });

  const retire = (tap: ActiveTap) =>
    Effect.gen(function* () {
      tap.retiring = true;
      tap.connection?.destroy();
      tap.connection = undefined;
      if (tap.process) yield* stopHelper(tap.process);
    }).pipe(
      Effect.ensuring(closeServer(tap.server).pipe(Effect.andThen(removeSocket(tap.socketPath)))),
    );

  const recordFailure = <A, E extends ComputerFrameTapFailure>(effect: Effect.Effect<A, E>) =>
    effect.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          failure = error;
        }),
      ),
    );

  const run: Effect.Effect<void, ComputerFrameTapFailure> = Effect.gen(function* () {
    for (;;) {
      const current = active;
      const goal = desired;
      const goalWatched = watched;
      const target = goalWatched ? goal : undefined;
      if (current && (!target || current.exited || current.key !== tapTargetKey(target))) {
        yield* recordFailure(retire(current));
        if (active === current) active = undefined;
        failure = undefined;
        continue;
      }
      if (!target) {
        failure = undefined;
        appliedRevision = revision;
        return;
      }
      if (failure) return yield* failure;
      if (!current) yield* recordFailure(start(target));
      if (goal === desired && goalWatched === watched) {
        appliedRevision = revision;
        return;
      }
    }
  });

  /** Single-flight: callers share the running pass, which repeats while the goal moved. */
  const reconcile: Effect.Effect<void, ComputerFrameTapFailure> = Effect.suspend(() => {
    if (reconciling) return Deferred.await(reconciling);
    const deferred = Deferred.makeUnsafe<void, ComputerFrameTapFailure>();
    reconciling = deferred;
    const pass = run.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          if (reconciling === deferred) reconciling = undefined;
        }),
      ),
      Effect.andThen(
        Effect.suspend(() => (!failure && appliedRevision !== revision ? reconcile : Effect.void)),
      ),
      Effect.onExit((exit) => Deferred.done(deferred, exit)),
    );
    // The pass runs on the tap's own fiber so an interrupted caller never
    // strands a half-applied reconcile.
    runFork(pass);
    return Deferred.await(deferred);
  });

  const reconcileInBackground = Effect.sync(() => {
    runFork(reconcile.pipe(Effect.catch(reportError)));
  });

  const update = (target: CuaPreviewTarget) =>
    Effect.suspend(() => {
      if (deadTargets.has(tapTargetKey(target))) return Effect.void;
      desired = target;
      revision += 1;
      return reconcileInBackground;
    });

  const setWatched = (next: boolean) =>
    Effect.suspend(() => {
      if (watched === next) return Effect.void;
      watched = next;
      revision += 1;
      return reconcile.pipe(Effect.catch(reportError));
    });

  const stop = Effect.suspend(() => {
    desired = undefined;
    revision += 1;
    return reconcile;
  });

  const endTask = (task: CuaComputerTask) =>
    Effect.suspend(() => {
      const matches = (candidate: CuaComputerTask) =>
        candidate.threadId === task.threadId &&
        (task.turnId === undefined || candidate.turnId === task.turnId);
      if (desired && !matches(desired.task)) return Effect.void;
      if (!desired && active && !matches(active.task)) return Effect.void;
      // The task formally ended; its failure memory ends with it. Without a
      // turnId the end covers every turn of the thread.
      const prefix =
        task.turnId === undefined ? threadKeyPrefix(task.threadId) : `${cuaComputerTaskKey(task)}:`;
      for (const key of deadTargets) if (key.startsWith(prefix)) deadTargets.delete(key);
      return stop;
    });

  const dispose = stop.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        const path = directory;
        directory = undefined;
        if (!path) return Effect.void;
        return Effect.tryPromise({
          try: () => NodeFS.promises.rm(path, { recursive: true, force: true }),
          catch: fsError("Could not remove the computer frame socket directory."),
        });
      }),
    ),
  );

  yield* Scope.addFinalizer(scope, dispose.pipe(Effect.catch(reportError)));

  const tap: ComputerFrameTap = { update, setWatched, endTask, stop, dispose };
  return tap;
});
