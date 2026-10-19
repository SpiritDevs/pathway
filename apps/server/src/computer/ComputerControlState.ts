/**
 * Durable per-thread Computer consent: whether control is disabled, the
 * revocation generation, and the explicit chat opt-in.
 *
 * @module computer/ComputerControlState
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** The consent file's name inside the environment's state directory. */
export const COMPUTER_CONTROL_STATE_FILE = "computer-control.json";

export interface ThreadControlState {
  readonly disabled: boolean;
  readonly generation: number;
  readonly chatGeneration?: number;
}

export class ComputerControlStateError extends Schema.TaggedErrorClass<ComputerControlStateError>()(
  "ComputerControlStateError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const Generation = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

const ControlStateFile = Schema.fromJsonString(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      disabled: Schema.Boolean,
      generation: Generation,
      chatGeneration: Schema.optionalKey(Generation),
    }),
  ),
);

const decodeControlStateFile = Schema.decodeUnknownEffect(ControlStateFile);

/** Frozen request generations prevent old queued consent from surviving a disable. */
export interface ComputerControlState {
  /** The thread's current state; every thread reads as disabled when the file failed to load. */
  readonly get: (threadId: string) => ThreadControlState;
  /** Whether a request frozen at `generation` may still act for the thread. */
  readonly allows: (threadId: string, generation: number) => boolean;
  /**
   * Disables (bumping the generation, which also clears chat intent) or
   * re-enables the thread, then persists. Enabling an enabled thread is free.
   */
  readonly set: (
    threadId: string,
    disabled: boolean,
  ) => Effect.Effect<void, ComputerControlStateError>;
  /**
   * Records whether the thread's chat opted in to Computer at `generation`.
   * Intent only sticks when it matches the current, enabled generation. A
   * write that fails, dies or is interrupted rolls the intent back so it
   * cannot authorize a later turn.
   */
  readonly recordChatIntent: (
    threadId: string,
    enabled: boolean,
    generation: number,
  ) => Effect.Effect<void, ComputerControlStateError>;
}

/**
 * Loads the consent file from `stateDir`, or keeps state in memory when
 * `stateDir` is `undefined`. A missing file is an empty state; a broken one
 * disables Computer for every thread — not ordinary coding or server boot.
 */
export const makeComputerControlState = Effect.fn("makeComputerControlState")(function* (
  stateDir: string | undefined,
): Effect.fn.Return<ComputerControlState, never, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath =
    stateDir === undefined ? undefined : path.join(stateDir, COMPUTER_CONTROL_STATE_FILE);
  const threads = new Map<string, ThreadControlState>();
  /**
   * Queued-dispatch and edit-resend admissions race through consent updates
   * concurrently; without serialization their read-modify-write sequences
   * interleave and the last writer silently wins. One permit orders every
   * mutation and its write while reads stay synchronous.
   */
  const lock = yield* Semaphore.make(1);
  let loadError: ComputerControlStateError | undefined;

  if (filePath !== undefined) {
    const loaded = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeControlStateFile),
      Effect.map((data) => ({ data }) as const),
      Effect.catch((error) =>
        Effect.succeed(
          error._tag === "PlatformError" && error.reason._tag === "NotFound"
            ? ({ data: {} } as const)
            : ({ error } as const),
        ),
      ),
    );
    if ("error" in loaded) {
      loadError = new ComputerControlStateError({
        message: "Computer authorization state could not be loaded; control remains disabled.",
        cause: loaded.error,
      });
    } else {
      for (const [threadId, state] of Object.entries(loaded.data)) threads.set(threadId, state);
    }
  }

  const get = (threadId: string): ThreadControlState => {
    if (loadError) return { disabled: true, generation: 0 };
    return threads.get(threadId) ?? { disabled: false, generation: 0 };
  };

  const allows = (threadId: string, generation: number): boolean => {
    const state = get(threadId);
    return !state.disabled && generation === state.generation;
  };

  const encode = Schema.encodeEffect(ControlStateFile);
  const persist: Effect.Effect<void, ComputerControlStateError> = Effect.suspend(() => {
    if (filePath === undefined) return Effect.void;
    const temporaryPath = `${filePath}.tmp`;
    return encode(Object.fromEntries(threads)).pipe(
      Effect.tap(() => fs.makeDirectory(path.dirname(filePath), { recursive: true, mode: 0o700 })),
      Effect.flatMap((content) => fs.writeFileString(temporaryPath, content, { mode: 0o600 })),
      Effect.andThen(fs.rename(temporaryPath, filePath)),
      Effect.mapError(
        (cause) =>
          new ComputerControlStateError({
            message: "Computer authorization state could not be saved.",
            cause,
          }),
      ),
    );
  });

  const set = (threadId: string, disabled: boolean) =>
    Effect.suspend(() => {
      if (loadError) return Effect.fail(loadError);
      if (!disabled && !get(threadId).disabled) return Effect.void;
      // Uninterruptible once admitted: an interrupted write would leave memory
      // at the new generation and disk at the old one, so a request frozen
      // before a disable would regain authority after a restart.
      return lock.withPermit(
        Effect.suspend(() => {
          const current = get(threadId);
          if (!disabled && !current.disabled) return Effect.void;
          threads.set(threadId, {
            disabled,
            generation: current.generation + (disabled ? 1 : 0),
          });
          return persist;
        }).pipe(Effect.uninterruptible),
      );
    });

  const recordChatIntent = (threadId: string, enabled: boolean, generation: number) =>
    Effect.suspend(() => {
      if (loadError) return enabled ? Effect.fail(loadError) : Effect.void;
      return lock.withPermit(
        Effect.suspend(() => {
          const previous = get(threadId);
          const chatGeneration = enabled && allows(threadId, generation) ? generation : undefined;
          if (previous.chatGeneration === chatGeneration) return Effect.void;
          const next: ThreadControlState = {
            disabled: previous.disabled,
            generation: previous.generation,
            ...(chatGeneration !== undefined ? { chatGeneration } : {}),
          };
          threads.set(threadId, next);
          return persist.pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                if (threads.get(threadId) === next) {
                  threads.set(threadId, { disabled: next.disabled, generation: next.generation });
                }
              }),
            ),
          );
        }),
      );
    });

  return { get, allows, set, recordChatIntent } satisfies ComputerControlState;
});
