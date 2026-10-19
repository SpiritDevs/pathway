import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { withProvisioningFileLock } from "./fileLock.ts";

/** `flock(1)` is util-linux; the lock only exists where the plugin is installed. */
const linux = process.platform === "linux";

const lockPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-lock-test-" });
  return path.join(directory, "install.lock");
});

describe("withProvisioningFileLock", () => {
  it.live.skipIf(!linux)(
    "serializes installers and reaps an interrupted waiter without entering its action",
    () =>
      Effect.gen(function* () {
        const path = yield* lockPath;
        const entered = yield* Deferred.make<void>();
        const held = yield* Deferred.make<void>();
        const first = yield* Effect.forkChild(
          withProvisioningFileLock(
            path,
            Effect.andThen(Deferred.succeed(entered, undefined), Deferred.await(held)),
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(entered);

        let ran = false;
        const requested = yield* Deferred.make<void>();
        const cancelled = yield* Effect.forkChild(
          withProvisioningFileLock(
            path,
            Effect.sync(() => {
              ran = true;
            }),
            { onLockRequested: Deferred.succeed(requested, undefined) },
          ),
          { startImmediately: true },
        );
        // The waiter exists and is blocked on the lock the first holder owns.
        yield* Deferred.await(requested);
        yield* Fiber.interrupt(cancelled);
        expect(Exit.hasInterrupts(yield* Fiber.await(cancelled))).toBe(true);
        expect(ran).toBe(false);

        let nextRan = false;
        const nextRequested = yield* Deferred.make<void>();
        const next = yield* Effect.forkChild(
          withProvisioningFileLock(
            path,
            Effect.sync(() => {
              nextRan = true;
            }),
            { onLockRequested: Deferred.succeed(nextRequested, undefined) },
          ),
          { startImmediately: true },
        );
        yield* Deferred.await(nextRequested);
        // Deterministic: the kernel lock is still owned by the first holder,
        // whose action has not been released, so the second cannot have run.
        expect(nextRan).toBe(false);
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(next);
        expect(nextRan).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live.skipIf(!linux)("releases the lock when the action itself is interrupted", () =>
    Effect.gen(function* () {
      const path = yield* lockPath;
      const started = yield* Deferred.make<void>();
      const running = yield* Effect.forkChild(
        withProvisioningFileLock(
          path,
          Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
        ),
        { startImmediately: true },
      );
      yield* Deferred.await(started);
      yield* Fiber.interrupt(running);
      expect(Exit.hasInterrupts(yield* Fiber.await(running))).toBe(true);
      // The next installer gets the lock at once: the interrupted holder is gone.
      expect(yield* withProvisioningFileLock(path, Effect.succeed("next"))).toBe("next");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
