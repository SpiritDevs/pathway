import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class HelperSpawnError extends Schema.TaggedErrorClass<HelperSpawnError>()(
  "HelperSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not start ${this.command}.`;
  }
}

export class HelperStopError extends Schema.TaggedErrorClass<HelperStopError>()(
  "HelperStopError",
  {},
) {
  override get message() {
    return "Native capture helper has not stopped; another capture is blocked until it exits.";
  }
}

/** How a helper ended. `code` is null when a signal ended it. */
export interface HelperExit {
  readonly code: number | null;
}

/** One running native helper. Its stdout and stderr are read line by line
 * on a supervisor fiber; `exited` resolves after both drain and `onExit` ran. */
export interface HelperProcess {
  readonly pid: number;
  /** Queues one stdin line. False once input ended or the helper exited. */
  readonly writeLine: (line: string) => Effect.Effect<boolean>;
  /** Closes stdin, which helpers read as EOF. */
  readonly endInput: Effect.Effect<void>;
  /** Sends a signal without waiting for the exit. */
  readonly signal: (signal: NodeJS.Signals) => Effect.Effect<void>;
  readonly exited: Effect.Effect<HelperExit>;
  readonly hasExited: Effect.Effect<boolean>;
  /** The bounded head of stderr seen so far. */
  readonly stderr: Effect.Effect<string>;
}

export interface SpawnHelperOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Pipe stdin for `writeLine`; otherwise stdin is ignored. */
  readonly stdin?: boolean;
  readonly env?: Record<string, string>;
  readonly stderrLimit?: number;
  readonly onStdoutLine?: (line: string) => Effect.Effect<void>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void>;
  readonly onExit?: (exit: HelperExit) => Effect.Effect<void>;
}

const DEFAULT_STDERR_LIMIT = 4_000;

/**
 * Spawns an attached helper whose lifetime is a child of `parent`. An attached
 * child keeps macOS TCC responsibility with Pathway. The helper's own scope
 * closes after it exits, and closing `parent` kills a helper still running.
 */
export const spawnHelper = Effect.fn("desktop.computer.spawnHelper")(function* (
  parent: Scope.Scope,
  options: SpawnHelperOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.fork(parent);
  const command = ChildProcess.make(options.command, [...options.args], {
    detached: false,
    ...(options.env ? { env: options.env, extendEnv: true } : {}),
    stdin: options.stdin ? { stream: "pipe", endOnDone: true } : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    killSignal: "SIGTERM",
    forceKillAfter: 1_000,
  });
  const handle = yield* spawner.spawn(command).pipe(
    Scope.provide(scope),
    Effect.mapError((cause) => new HelperSpawnError({ command: options.command, cause })),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );

  const limit = options.stderrLimit ?? DEFAULT_STDERR_LIMIT;
  let stderr = "";
  let exited = false;
  const exitDeferred = yield* Deferred.make<HelperExit>();
  const input = yield* Queue.unbounded<string, Cause.Done>();
  // The supervisor can be interrupted before it starts, so the helper's own
  // scope settles `exited` for a helper killed by its owner closing.
  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => {
      exited = true;
      return Deferred.succeed(exitDeferred, { code: null });
    }),
  );

  if (options.stdin)
    yield* Stream.fromQueue(input).pipe(
      Stream.map((line) => `${line}\n`),
      Stream.encodeText,
      Stream.run(handle.stdin),
      Effect.ignore,
      Effect.forkIn(scope),
    );

  const readStdout = handle.stdout.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) => options.onStdoutLine?.(line) ?? Effect.void),
    Effect.ignore,
  );
  const readStderr = handle.stderr.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.suspend(() => {
        if (stderr.length < limit) stderr = `${stderr}${line}\n`.slice(0, limit);
        return options.onStderrLine?.(line) ?? Effect.void;
      }),
    ),
    Effect.ignore,
  );

  yield* Effect.all([readStdout, readStderr], { concurrency: "unbounded", discard: true }).pipe(
    Effect.andThen(handle.exitCode),
    Effect.map((code): HelperExit => ({ code })),
    Effect.orElseSucceed((): HelperExit => ({ code: null })),
    Effect.tap(() =>
      Effect.sync(() => {
        exited = true;
      }),
    ),
    Effect.tap(() => Queue.end(input)),
    Effect.tap((exit) => options.onExit?.(exit) ?? Effect.void),
    Effect.tap((exit) => Deferred.succeed(exitDeferred, exit)),
    Effect.ensuring(Scope.close(scope, Exit.void)),
    Effect.forkIn(parent),
  );

  const helper: HelperProcess = {
    pid: handle.pid,
    writeLine: (line) =>
      Effect.suspend(() => (exited ? Effect.succeed(false) : Queue.offer(input, line))),
    endInput: Queue.end(input).pipe(Effect.asVoid),
    signal: (signal) =>
      Effect.suspend(() =>
        exited
          ? Effect.void
          : handle
              .kill({ killSignal: signal })
              .pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid),
      ),
    exited: Deferred.await(exitDeferred),
    hasExited: Effect.sync(() => exited),
    stderr: Effect.sync(() => stderr),
  };
  return helper;
});

/** Waits for an owned helper to stop: SIGTERM, then SIGKILL after 1s, then
 * fails after one more second so the caller never reuses a stuck helper. */
export const stopHelper = Effect.fn("desktop.computer.stopHelper")(function* (
  helper: HelperProcess,
) {
  if (yield* helper.hasExited) return;
  yield* helper.signal("SIGTERM");
  if (Option.isSome(yield* Effect.timeoutOption(helper.exited, 1_000))) return;
  yield* helper.signal("SIGKILL");
  if (Option.isSome(yield* Effect.timeoutOption(helper.exited, 1_000))) return;
  return yield* new HelperStopError();
});
