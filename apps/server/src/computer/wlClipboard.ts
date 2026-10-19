// @effect-diagnostics nodeBuiltinImport:off - wl-copy forks a child that must outlive the command, so it is spawned directly.
/**
 * Clipboard access through the wl-clipboard binaries.
 *
 * The clipboard reached here is seat0's, the human's, and that is deliberate.
 * A Wayland client binds its data device to one seat — seat0 for every Qt and
 * GTK toolkit build we drive — no matter which seat delivered its input, so the
 * dedicated pathway-agent seat cannot hold a private working clipboard: a
 * synthesized Ctrl+C on it either fails the compositor's serial validation
 * silently or writes the human's clipboard anyway. These helpers therefore
 * address the selection directly and never synthesize copy/paste keystrokes.
 *
 * No `--seat` flag is passed, which leaves wl-clipboard on the first seat the
 * compositor advertises. That is seat0: it exists from compositor startup,
 * while the agent seat only appears once the KWin plugin creates it.
 */
import { spawn, type ChildProcess } from "node:child_process";

import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { computerClipboardWriteError, MAX_COMPUTER_CLIPBOARD_BYTES } from "./ComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import { desktopApplicationEnvironment } from "./desktopAppEnvironment.ts";
import { commandOnPath } from "./provisioning/systemPackages.ts";

/** Enough stderr to quote a wl-clipboard diagnostic, never enough to hold a payload. */
const MAX_CLIPBOARD_STDERR_BYTES = 8 * 1024;
/**
 * A selection is served by the application that owns it, so a wedged app can
 * hold the pipe open indefinitely. The deadline bounds what that costs a turn.
 */
const CLIPBOARD_TIMEOUT_MS = 5_000;
/**
 * How long a paste-once offer is watched before its pipe is let go. An offer
 * ends when it is pasted or replaced, and paste always replaces it with the
 * human's clipboard within seconds; this only bounds a restore that failed.
 */
const PASTE_OFFER_WATCH_MS = 30_000;

const WL_COPY = "wl-copy";
const WL_PASTE = "wl-paste";
const WL_CLIPBOARD_PACKAGE = "wl-clipboard";
export const CLIPBOARD_SETUP_INCOMPLETE_MESSAGE =
  "Clipboard setup is incomplete. Install wl-clipboard and make sure wl-copy and wl-paste are on Pathway's PATH, then click Set up again.";

/** Both directions must be installed before advertising clipboard support. */
export function wlClipboardToolsPresent(
  hasCommand: (command: string) => boolean = (command) => commandOnPath(command),
): boolean {
  return hasCommand(WL_COPY) && hasCommand(WL_PASTE);
}

/**
 * Generic type name: wl-paste picks any offered `text/*` representation, and
 * refuses a selection that has none. Without it wl-paste falls back to the
 * first offered type and would stream an image's raw bytes as "text".
 */
const CLIPBOARD_READ_TYPE = "text";
/**
 * Explicit on the write side because wl-copy otherwise infers the type from the
 * content, and infers zero bytes as `application/x-zerosize`, which reads back
 * as a non-text selection. wl-copy offers the same text aliases either way.
 */
const CLIPBOARD_WRITE_TYPE = "text/plain";

/** wl-clipboard is not localized, so its diagnostics are stable to match on. */
const EMPTY_CLIPBOARD_PATTERN = /nothing is copied/i;
const NON_TEXT_CLIPBOARD_PATTERN = /not available as requested type|no suitable type of content/i;

export interface ClipboardCommandSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Written to stdin, never to argv, so clipboard text stays out of /proc cmdline. */
  readonly input?: string;
  /**
   * wl-copy forks a background child that keeps serving the selection and
   * inherits the parent's stderr, so waiting for the pipes to close would wait
   * for the next clipboard change. Only the parent's exit is awaited.
   */
  readonly forks?: boolean;
  /**
   * For a forking command: keep the stderr pipe the background child inherits
   * and report, as `forkExited`, when it closes — that is, when the child has
   * exited. wl-copy's child points stdin and stdout at /dev/null but keeps
   * stderr, so this is the only handle on it.
   *
   * The command is also started as the leader of its own process group, which
   * its fork inherits (wl-copy forks without `setsid`), so `endFork` can end a
   * child whose pid nothing reports.
   */
  readonly observeFork?: boolean;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export interface ClipboardCommandResult {
  /** `exited` carries a real status; the other outcomes mean the child was killed. */
  readonly outcome: "exited" | "timed-out" | "output-limit";
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * Completes when a forked child has exited, and fails when it outlived the
   * watch; see `ClipboardCommandSpec.observeFork`.
   */
  readonly forkExited?: Deferred.Deferred<void, ComputerBackendError>;
  /** Ends that forked child now, if it is still running. */
  readonly endFork?: () => void;
}

/** The command could not be started; `code` is the spawn errno, `ENOENT` for a missing binary. */
export class ClipboardSpawnError extends Schema.TaggedErrorClass<ClipboardSpawnError>()(
  "ClipboardSpawnError",
  {
    command: Schema.String,
    code: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `${this.command} could not be started${this.code ? ` (${this.code})` : ""}.`;
  }
}

/** Runs one clipboard command. Only a spawn failure fails; every exit is a result. */
export type ClipboardCommandRunner = (
  spec: ClipboardCommandSpec,
) => Effect.Effect<ClipboardCommandResult, ClipboardSpawnError>;

/** Reads the seat0 clipboard as text; an empty clipboard reads as `""`. */
export const readWlClipboard = (
  run: ClipboardCommandRunner,
): Effect.Effect<string, ComputerBackendError> =>
  runClipboardCommand(run, {
    command: WL_PASTE,
    args: ["--no-newline", "--type", CLIPBOARD_READ_TYPE],
    maxOutputBytes: MAX_COMPUTER_CLIPBOARD_BYTES,
  }).pipe(
    Effect.flatMap((result) => {
      if (result.outcome === "output-limit") {
        return Effect.fail(
          new ComputerBackendError({
            message: `The desktop clipboard holds more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes of text, which is past the limit this tool reads.`,
          }),
        );
      }
      if (result.outcome === "timed-out") {
        return Effect.fail(
          new ComputerBackendError({
            message: `${WL_PASTE} did not return within ${CLIPBOARD_TIMEOUT_MS}ms; the application owning the clipboard is not serving it.`,
            retryable: true,
          }),
        );
      }
      if (result.code === 0) return Effect.succeed(result.stdout);
      // An empty clipboard is a non-zero exit rather than empty output, and is a
      // normal state the agent should read as "nothing copied", not as a failure.
      if (EMPTY_CLIPBOARD_PATTERN.test(result.stderr)) return Effect.succeed("");
      if (NON_TEXT_CLIPBOARD_PATTERN.test(result.stderr)) {
        return Effect.fail(
          new ComputerBackendError({
            message:
              "The desktop clipboard holds non-text content, such as an image or a file, which cannot be read as text.",
          }),
        );
      }
      return Effect.fail(
        new ComputerBackendError({
          message: `${WL_PASTE} failed to read the desktop clipboard: ${describeFailure(result)}`,
        }),
      );
    }),
  );

/** Replaces the seat0 clipboard, which discards whatever the human last copied. */
export const writeWlClipboard = (
  run: ClipboardCommandRunner,
  text: string,
): Effect.Effect<void, ComputerBackendError> =>
  Effect.suspend(() => {
    const tooLarge = computerClipboardWriteError(text);
    if (tooLarge) return Effect.fail(tooLarge);
    return runClipboardCommand(run, {
      command: WL_COPY,
      args: ["--type", CLIPBOARD_WRITE_TYPE],
      input: text,
      forks: true,
    }).pipe(
      Effect.flatMap((result) =>
        result.outcome === "exited" && result.code === 0
          ? Effect.void
          : Effect.fail(writeFailure(result)),
      ),
    );
  });

export interface WlClipboardPasteOffer {
  /** Completes once the offer ended: pasted, or replaced by another selection. */
  readonly consumed: Deferred.Deferred<void, ComputerBackendError>;
  /**
   * Ends an offer nobody pasted. The compositor drops a selection whose source
   * is gone, so this clears the clipboard rather than leaving the payload for
   * the human's next paste.
   */
  readonly withdraw: () => void;
}

/**
 * Offers `text` on the seat0 clipboard for exactly one paste, and says when
 * that paste has read it.
 *
 * `wl-copy --paste-once` serves a single request and exits, and it also exits
 * when anything else takes the clipboard — so `consumed` completes when the
 * target has read the payload or the offer was replaced, and the caller puts
 * the human's clipboard back then rather than after a guessed delay. Succeeds,
 * like `writeWlClipboard`, once the payload is on the clipboard.
 */
export const writeWlClipboardForPaste = (
  run: ClipboardCommandRunner,
  text: string,
): Effect.Effect<WlClipboardPasteOffer, ComputerBackendError> =>
  Effect.suspend(() => {
    const tooLarge = computerClipboardWriteError(text);
    if (tooLarge) return Effect.fail(tooLarge);
    return runClipboardCommand(run, {
      command: WL_COPY,
      args: ["--paste-once", "--type", CLIPBOARD_WRITE_TYPE],
      input: text,
      forks: true,
      observeFork: true,
    }).pipe(
      Effect.flatMap((result) => {
        if (result.outcome !== "exited" || result.code !== 0) {
          return Effect.fail(writeFailure(result));
        }
        const consumed = result.forkExited ?? Deferred.makeUnsafe<void, ComputerBackendError>();
        if (!result.forkExited) {
          Deferred.doneUnsafe(
            consumed,
            Exit.fail(
              new ComputerBackendError({
                message: `${WL_COPY} gave no handle on its paste-once offer.`,
              }),
            ),
          );
        }
        return Effect.succeed({ consumed, withdraw: () => result.endFork?.() });
      }),
    );
  });

function writeFailure(result: ClipboardCommandResult): ComputerBackendError {
  return new ComputerBackendError({
    message: `${WL_COPY} failed to write the desktop clipboard: ${describeFailure(result)}`,
    retryable: result.outcome === "timed-out",
  });
}

const runClipboardCommand = (
  run: ClipboardCommandRunner,
  spec: ClipboardCommandSpec,
): Effect.Effect<ClipboardCommandResult, ComputerBackendError> =>
  run(spec).pipe(
    Effect.mapError((error) =>
      error.code === "ENOENT"
        ? new ComputerBackendError({
            message: `${spec.command} is not installed, so the desktop clipboard cannot be used. Install the ${WL_CLIPBOARD_PACKAGE} package.`,
            cause: error,
          })
        : new ComputerBackendError({
            message: `Failed to run ${spec.command}: ${causeMessage(error.cause)}`,
            cause: error,
          }),
    ),
  );

function describeFailure(result: ClipboardCommandResult): string {
  if (result.outcome === "timed-out") return `timed out after ${CLIPBOARD_TIMEOUT_MS}ms`;
  if (result.outcome === "output-limit")
    return `produced more than ${MAX_COMPUTER_CLIPBOARD_BYTES} bytes`;
  const detail = result.stderr.trim().split("\n")[0];
  return detail && detail.length > 0 ? detail : `exit status ${result.code ?? "unknown"}`;
}

/**
 * Spawns one wl-clipboard process. Only a spawn failure fails — an ENOENT for
 * a missing binary — so every exit status is mapped in one place above.
 *
 * `env` overrides the inherited environment and is how a nested compositor's
 * clipboard is reached: wl-clipboard talks to whichever `WAYLAND_DISPLAY` it is
 * handed, so the same code addresses the ambient session and a Tier 3 one.
 *
 * The process gets the desktop session's variables and nothing of the
 * server's (see `desktopApplicationEnvironment`): `wl-copy` forks and stays
 * alive holding the selection, and it has no use for the server's auth token
 * or provider keys.
 *
 * Node's spawner is used directly rather than the Effect process spawner,
 * whose scope takes down the command's whole process group on the way out:
 * that group is where wl-copy's fork lives, and the fork *is* the clipboard.
 * An interrupted run kills the command itself and leaves the fork alone.
 */
export const spawnClipboardCommand = (
  spec: ClipboardCommandSpec,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<ClipboardCommandResult, ClipboardSpawnError> =>
  Effect.suspend(() => {
    const maxOutputBytes = spec.maxOutputBytes ?? MAX_COMPUTER_CLIPBOARD_BYTES;
    const timeoutMs = spec.timeoutMs ?? CLIPBOARD_TIMEOUT_MS;
    const observeFork = spec.forks === true && spec.observeFork === true;
    let child: ChildProcess;
    try {
      child = spawn(spec.command, [...spec.args], {
        stdio: ["pipe", "pipe", "pipe"],
        env: desktopApplicationEnvironment(process.env, env),
        // Its own process group, so the fork it leaves behind can be signalled.
        ...(observeFork ? { detached: true } : {}),
      });
    } catch (cause) {
      return Effect.fail(new ClipboardSpawnError({ command: spec.command, cause }));
    }
    const stdout = chunkBuffer(maxOutputBytes);
    const stderr = chunkBuffer(MAX_CLIPBOARD_STDERR_BYTES);
    const settled = Deferred.makeUnsafe<ClipboardCommandResult, ClipboardSpawnError>();
    let outcome: ClipboardCommandResult["outcome"] = "exited";
    let fork: ForkWatch | undefined;

    const settle = (code: number | null) => {
      if (Deferred.isDoneUnsafe(settled)) return;
      // A forking wl-copy leaves its background child holding these pipes, so
      // they are released here rather than waited on — except stderr when the
      // caller watches the child through it.
      child.stdout?.destroy();
      fork = observeFork && outcome === "exited" && code === 0 ? watchFork(child) : undefined;
      if (!fork) child.stderr?.destroy();
      Deferred.doneUnsafe(
        settled,
        Exit.succeed({
          outcome,
          code,
          // An output-limit run has no usable stdout — its truncated prefix
          // must never pass for the real thing.
          stdout: stdout.text() ?? "",
          stderr: stderr.diagnostic(),
          ...(fork ? { forkExited: fork.exited, endFork: fork.end } : {}),
        }),
      );
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      Deferred.doneUnsafe(
        settled,
        Exit.fail(
          new ClipboardSpawnError({
            command: spec.command,
            ...(error.code === undefined ? {} : { code: error.code }),
            cause: error,
          }),
        ),
      );
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.push(chunk)) return;
      outcome = "output-limit";
      child.kill("SIGKILL");
    });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("exit", (code) => {
      if (spec.forks === true || outcome !== "exited") settle(code);
    });
    child.on("close", (code) => settle(code));

    // The child may exit before it consumes the payload, which surfaces as an
    // exit status rather than as an unhandled stdin error.
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(spec.input ?? "");

    const kill = Effect.sync(() => {
      child.kill("SIGKILL");
    });
    return Deferred.await(settled).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMs),
        orElse: () =>
          Effect.suspend(() => {
            outcome = "timed-out";
            return kill.pipe(Effect.andThen(Deferred.await(settled)));
          }),
      }),
      Effect.onInterrupt(() => kill),
      // The offer's watch outlives this run on purpose, bounded by its own deadline.
      Effect.tap(() => (fork ? Effect.forkDetach(fork.bound) : Effect.void)),
    );
  });

interface ForkWatch {
  readonly exited: Deferred.Deferred<void, ComputerBackendError>;
  readonly end: () => void;
  /** Ends an offer still open after `PASTE_OFFER_WATCH_MS`. */
  readonly bound: Effect.Effect<void>;
}

/**
 * Watches the forked child holding `child`'s stderr pipe: `exited` completes
 * when the pipe's last writer is gone, and `end` signals the child's process
 * group (the command's own, see `observeFork`) while it is still there.
 * Bounded: an offer still open after the watch is stale, and is ended rather
 * than left on the clipboard for the life of the server.
 */
function watchFork(child: ChildProcess): ForkWatch | undefined {
  const stream = child.stderr;
  if (!stream || stream.destroyed || stream.readableEnded) return undefined;
  const exited = Deferred.makeUnsafe<void, ComputerBackendError>();
  let open = true;
  const end = () => {
    // Only while the pipe is open: a live member keeps the group, so its id
    // cannot have been reused by anything else.
    if (!open || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  };
  const done = () => {
    open = false;
    Deferred.doneUnsafe(exited, Exit.void);
  };
  stream.once("close", done);
  stream.once("end", done);
  // Drained so the child can never block on a full pipe; the text is not read.
  stream.resume();
  // The watch must not keep the server alive on its own.
  (stream as { unref?: () => void }).unref?.();
  const bound = Deferred.await(exited).pipe(
    Effect.timeoutOrElse({
      duration: Duration.millis(PASTE_OFFER_WATCH_MS),
      orElse: () =>
        Effect.sync(() => {
          end();
          open = false;
          stream.destroy();
          Deferred.doneUnsafe(
            exited,
            Exit.fail(
              new ComputerBackendError({
                message: `${WL_COPY}'s paste-once offer was still open after ${PASTE_OFFER_WATCH_MS}ms.`,
              }),
            ),
          );
        }),
    }),
    Effect.ignore,
  );
  return { exited, end, bound };
}

/** Bounded capture that refuses, rather than truncates, once its limit is passed. */
function chunkBuffer(limit: number) {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let overflowed = false;
  return {
    /** `false` once the limit is passed, and the chunk is dropped. */
    push: (chunk: Buffer): boolean => {
      if (overflowed || bytes + chunk.byteLength > limit) {
        overflowed = true;
        return false;
      }
      bytes += chunk.byteLength;
      chunks.push(chunk);
      return true;
    },
    /**
     * `undefined` after an overflow rather than the arbitrary prefix that
     * survived: a truncated read must be recognizable as one, never mistaken
     * for the clipboard's actual contents.
     */
    text: (): string | undefined =>
      overflowed ? undefined : Buffer.concat(chunks).toString("utf8"),
    diagnostic: (): string =>
      Buffer.concat(chunks).toString("utf8") + (overflowed ? " [diagnostic truncated]" : ""),
  };
}

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
