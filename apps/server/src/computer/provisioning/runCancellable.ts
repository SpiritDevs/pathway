/**
 * A child process that a caller can actually stop.
 *
 * `execFile` with a `timeout` signals only the direct child: a `bash` script
 * that has spawned `cmake`, which spawned `ninja`, which spawned a dozen
 * compilers, leaves all of them running when bash dies, and nothing ever
 * reaps them. This runs the child in its own process group through the
 * Effect process spawner, whose scope already knows how to TERM the group,
 * escalate to KILL after a grace, and wait for the root to exit. What is left
 * of the group after that is swept with KILL before the run settles.
 *
 * Cancelling is interrupting: an interrupted run, like a timed-out one, does
 * not finish interrupting until the tree has been taken down, so a caller that
 * retries after a cancel is never racing the build it just cancelled.
 *
 * @module computer/provisioning/runCancellable
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const STDERR_TAIL_LINES = 12;
/** How long the group gets to act on TERM before it is killed outright. */
const TERM_GRACE = Duration.millis(1_500);

export interface RunCancellableOptions {
  readonly timeoutMs?: number | undefined;
  readonly cwd?: string | undefined;
  /** The child's whole environment; the server's own when absent. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Per stream. Output beyond this keeps its tail, because the tail is what
   * every consumer wants: the built path is the last stdout line and the
   * compiler's reason is the last stderr lines.
   */
  readonly maxOutputBytes?: number | undefined;
}

export interface RunCancellableResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

/** Non-zero exit. `stderrTail` is the part of stderr worth showing a person. */
export class CommandFailedError extends Schema.TaggedErrorClass<CommandFailedError>()(
  "CommandFailedError",
  {
    command: Schema.String,
    /** `null` when a signal ended the process rather than an exit. */
    code: Schema.NullOr(Schema.Number),
    stderrTail: Schema.String,
  },
) {
  override get message(): string {
    const outcome = this.code !== null ? `exited with code ${this.code}` : "was killed by a signal";
    return `${this.command} ${outcome}${this.stderrTail ? `: ${this.stderrTail}` : ""}`;
  }
}

export class CommandTimeoutError extends Schema.TaggedErrorClass<CommandTimeoutError>()(
  "CommandTimeoutError",
  { command: Schema.String, timeoutMs: Schema.Number },
) {
  override get message(): string {
    return `${this.command} did not finish within ${Math.round(this.timeoutMs / 1000)}s and was stopped.`;
  }
}

/** The command could not be started at all: missing, not executable, bad cwd. */
export class CommandSpawnError extends Schema.TaggedErrorClass<CommandSpawnError>()(
  "CommandSpawnError",
  { command: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `${this.command} could not be started.`;
  }
}

export type RunCancellableError = CommandFailedError | CommandTimeoutError | CommandSpawnError;

export function stderrTail(stderr: string): string {
  return stderr.trimEnd().split("\n").slice(-STDERR_TAIL_LINES).join("\n").trim();
}

/** Bounded accumulator that keeps the most recent bytes. */
function tailBuffer(limit: number) {
  let chunks: Uint8Array[] = [];
  let size = 0;
  return {
    push: (chunk: Uint8Array) => {
      chunks.push(chunk);
      size += chunk.byteLength;
      while (size > limit && chunks.length > 1) {
        size -= chunks.shift()!.byteLength;
      }
      if (size > limit) {
        const only = chunks[0]!;
        chunks = [only.subarray(only.byteLength - limit)];
        size = limit;
      }
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

/**
 * Runs `command` to completion, or stops it and everything it spawned.
 *
 * Succeeds on exit 0. Fails with `CommandTimeoutError` when `timeoutMs`
 * elapses and with `CommandFailedError` on any other non-zero exit. Neither
 * that failure nor an interruption lands until the process group is gone.
 */
export const runCancellable = (
  command: string,
  args: readonly string[],
  options: RunCancellableOptions = {},
): Effect.Effect<
  RunCancellableResult,
  RunCancellableError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.suspend(() => {
    const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let groupId: number | undefined;
    const scoped = Effect.scoped(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command, [...args], {
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env }),
              detached: true,
              stdin: "ignore",
              forceKillAfter: TERM_GRACE,
            }),
          )
          .pipe(Effect.mapError((cause) => new CommandSpawnError({ command, cause })));
        groupId = child.pid;
        const stdout = tailBuffer(limit);
        const stderr = tailBuffer(limit);
        const collect = (
          stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
          into: typeof stdout,
        ) =>
          Stream.runForEach(stream, (chunk) => Effect.sync(() => into.push(chunk))).pipe(
            Effect.ignore,
          );
        yield* Effect.all([collect(child.stdout, stdout), collect(child.stderr, stderr)], {
          concurrency: "unbounded",
          discard: true,
        });
        const code = yield* child.exitCode.pipe(
          Effect.map((exitCode): number | null => exitCode),
          Effect.orElseSucceed(() => null),
        );
        if (code !== 0) {
          return yield* new CommandFailedError({
            command,
            code,
            stderrTail: stderrTail(stderr.text()),
          });
        }
        return { stdout: stdout.text(), stderr: stderr.text(), code };
      }),
    );
    // The spawner's scope ends only once the root has exited. Whatever of the
    // group outlived its TERM is killed here, before an interrupted or timed-out
    // run lets its caller go on.
    const run = Effect.onExit(scoped, (exit) =>
      Exit.hasInterrupts(exit) ? Effect.sync(() => killGroup(groupId)) : Effect.void,
    );
    return options.timeoutMs === undefined || !Number.isFinite(options.timeoutMs)
      ? run
      : Effect.timeoutOrElse(run, {
          duration: Duration.millis(options.timeoutMs),
          orElse: () =>
            Effect.fail(new CommandTimeoutError({ command, timeoutMs: options.timeoutMs! })),
        });
  });

function killGroup(groupId: number | undefined): void {
  if (groupId === undefined) return;
  try {
    process.kill(-groupId, "SIGKILL");
  } catch {
    // ESRCH: the whole group is already gone, which is the point.
  }
}
