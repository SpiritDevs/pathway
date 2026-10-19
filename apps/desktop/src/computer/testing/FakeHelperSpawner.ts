import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Cause from "effect/Cause";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/unstable/process";
import type { ChildProcess } from "effect/unstable/process";

/** One process spawned through the fake. Tests drive its output and exit. */
export interface FakeHelper {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly pid: number;
  /** Complete stdin lines received so far. */
  readonly stdinLines: Array<string>;
  readonly signals: Array<NodeJS.Signals>;
  readonly stdinEnded: () => boolean;
  readonly exitedFlag: () => boolean;
  /** Writes one stdout line. */
  readonly emit: (line: string | object) => Effect.Effect<void>;
  readonly emitStderr: (text: string) => Effect.Effect<void>;
  /** Ends stdout and stderr and reports the exit, once. */
  readonly exit: (code: number | null) => Effect.Effect<void>;
  /** Resolves when stdin receives a line equal to `line`, or immediately if it already has. */
  readonly awaitStdin: (line: string) => Effect.Effect<void>;
  /** Whether a signal ends the process. Defaults to true. */
  exitOnSignal: boolean;
}

export interface FakeHelperSpawner {
  readonly layer: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly spawned: Array<FakeHelper>;
  /** Waits for the next process spawned after the previous `next` call. */
  readonly next: Effect.Effect<FakeHelper>;
  /** Makes the next spawn fail like a missing executable. */
  readonly failNextSpawn: () => void;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const makeFakeHelperSpawner = Effect.gen(function* () {
  const spawned: Array<FakeHelper> = [];
  const spawnQueue = yield* Queue.unbounded<FakeHelper>();
  let failNext = false;
  let nextPid = 1_000;

  const spawn = (command: ChildProcess.Command) =>
    Effect.gen(function* () {
      const standard = command._tag === "StandardCommand" ? command : undefined;
      const name = standard?.command ?? "piped";
      if (failNext) {
        failNext = false;
        return yield* PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: `spawn ${name} ENOENT`,
        });
      }
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exitDeferred = yield* Deferred.make<number | null>();
      const stdinWaiters = new Map<string, Array<Deferred.Deferred<void>>>();
      let stdinBuffer = "";
      let ended = false;
      let exited = false;

      const exit = (code: number | null) =>
        Effect.suspend(() => {
          if (exited) return Effect.void;
          exited = true;
          return Effect.all([Queue.end(stdout), Queue.end(stderr)]).pipe(
            Effect.andThen(Deferred.succeed(exitDeferred, code)),
            Effect.asVoid,
          );
        });

      const fake: FakeHelper = {
        command: name,
        args: standard?.args ?? [],
        pid: nextPid++,
        stdinLines: [],
        signals: [],
        stdinEnded: () => ended,
        exitedFlag: () => exited,
        emit: (line) =>
          Queue.offer(
            stdout,
            encoder.encode(`${typeof line === "string" ? line : JSON.stringify(line)}\n`),
          ).pipe(Effect.asVoid),
        emitStderr: (text) => Queue.offer(stderr, encoder.encode(text)).pipe(Effect.asVoid),
        exit,
        awaitStdin: (line) =>
          Effect.suspend(() => {
            if (fake.stdinLines.includes(line)) return Effect.void;
            const deferred = Deferred.makeUnsafe<void>();
            stdinWaiters.set(line, [...(stdinWaiters.get(line) ?? []), deferred]);
            return Deferred.await(deferred);
          }),
        exitOnSignal: true,
      };

      const receive = (chunk: Uint8Array) =>
        Effect.sync(() => {
          stdinBuffer += decoder.decode(chunk);
          const lines = stdinBuffer.split("\n");
          stdinBuffer = lines.pop() ?? "";
          for (const line of lines) {
            fake.stdinLines.push(line);
            for (const waiter of stdinWaiters.get(line) ?? [])
              Deferred.doneUnsafe(waiter, Effect.void);
            stdinWaiters.delete(line);
          }
        });

      const handle = ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(fake.pid),
        exitCode: Deferred.await(exitDeferred).pipe(
          Effect.flatMap((code) =>
            code === null
              ? Effect.fail(
                  PlatformError.systemError({
                    _tag: "Unknown",
                    module: "ChildProcess",
                    method: "exitCode",
                    description: "signalled",
                  }),
                )
              : Effect.succeed(ChildProcessSpawner.ExitCode(code)),
          ),
        ),
        isRunning: Effect.sync(() => !exited),
        kill: (options) =>
          Effect.suspend(() => {
            fake.signals.push((options?.killSignal as NodeJS.Signals | undefined) ?? "SIGTERM");
            return fake.exitOnSignal ? exit(null) : Effect.void;
          }).pipe(Effect.andThen(Deferred.await(exitDeferred)), Effect.asVoid),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach(receive).pipe(
          Sink.onExit(() =>
            Effect.sync(() => {
              ended = true;
            }),
          ),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.fromQueue(stderr),
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });

      // Closing the owning scope of a still-running process kills it, like the Node spawner.
      yield* Effect.addFinalizer(() =>
        exited
          ? Effect.void
          : Effect.sync(() => fake.signals.push("SIGTERM")).pipe(Effect.andThen(exit(null))),
      );
      spawned.push(fake);
      yield* Queue.offer(spawnQueue, fake);
      return handle;
    });

  const fakeSpawner: FakeHelperSpawner = {
    layer: ChildProcessSpawner.make(spawn),
    spawned,
    next: Queue.take(spawnQueue),
    failNextSpawn: () => {
      failNext = true;
    },
  };
  return fakeSpawner;
});
