/**
 * The lock that serializes computer-use installers across processes.
 *
 * Two servers, or a server and a desktop app, setting the plugin up at once
 * would write the same plugin directory. The lock is `flock(1)` holding a
 * kernel lock on behalf of a tiny child: the kernel releases it however that
 * child ends, and the child ends when this process lets go of it or dies
 * (its stdin reaches EOF), so no crash can leave the lock held.
 *
 * @module computer/provisioning/fileLock
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** How long a waiter queues behind another installer before giving up, in seconds. */
const LOCK_WAIT_SECONDS = 900;

const HOLDER_SCRIPT =
  "process.stdout.write('locked\\n');process.stdin.resume();process.stdin.on('end',()=>process.exit(0));";

export class ProvisioningLockError extends Schema.TaggedErrorClass<ProvisioningLockError>()(
  "ProvisioningLockError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/** Test seam: fires once the lock-holding child exists, before it has the lock. */
export interface ProvisioningFileLockHooks {
  readonly onLockRequested?: Effect.Effect<void>;
}

/**
 * Runs `action` while holding the kernel lock at `path`.
 *
 * Interrupting a waiter kills its flock child and installs nothing. The
 * action is interrupted, and the effect fails, if the holder dies under it:
 * without the lock the action is no longer serialized with anyone.
 */
export const withProvisioningFileLock = <A, E, R>(
  path: string,
  action: Effect.Effect<A, E, R>,
  hooks: ProvisioningFileLockHooks = {},
): Effect.Effect<
  A,
  E | ProvisioningLockError,
  R | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const paths = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      yield* fs.makeDirectory(paths.dirname(path), { recursive: true }).pipe(
        Effect.mapError(
          (cause) =>
            new ProvisioningLockError({
              message: `The provisioning lock directory could not be created: ${cause.message}`,
              cause,
            }),
        ),
      );
      // The holder's scope is this one: closing it kills the holder, which is
      // what releases the lock, whether the action finished, failed, or was
      // interrupted.
      const holder = yield* spawner
        .spawn(
          ChildProcess.make(
            "flock",
            [
              "--no-fork",
              "--exclusive",
              "--timeout",
              String(LOCK_WAIT_SECONDS),
              path,
              process.execPath,
              "-e",
              HOLDER_SCRIPT,
            ],
            { stderr: "ignore" },
          ),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new ProvisioningLockError({
                message: "The provisioning lock could not be requested.",
                cause,
              }),
          ),
        );
      if (hooks.onLockRequested) yield* hooks.onLockRequested;
      const holderGone = holder.exitCode.pipe(
        Effect.map((code): number | null => code),
        Effect.orElseSucceed(() => null),
      );
      const locked = yield* Stream.runHead(holder.stdout).pipe(
        Effect.map((chunk) => chunk._tag === "Some"),
        Effect.orElseSucceed(() => false),
      );
      if (!locked) {
        const code = yield* holderGone;
        return yield* new ProvisioningLockError({
          message: `Provisioning lock was not acquired (exit ${code}).`,
        });
      }
      return yield* Effect.raceFirst(
        action,
        Effect.flatMap(holderGone, () =>
          Effect.fail(new ProvisioningLockError({ message: "Provisioning lock holder exited." })),
        ),
      );
    }),
  );
