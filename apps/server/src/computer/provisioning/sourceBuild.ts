/**
 * Building the KWin plugin from source, through the installer script.
 *
 * The build lives in `scripts/install-and-load.sh` so there is exactly one of
 * it; `--build-only` is that script with its install, load, and stamp steps
 * removed, and it prints the built `.so` path as its last stdout line. This
 * module owns the process side: a cancellable run whose whole tree - bash,
 * cmake, ninja, the compilers - is gone before the effect settles.
 *
 * @module computer/provisioning/sourceBuild
 */
import * as Effect from "effect/Effect";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { ComputerBackendError } from "../computerErrors.ts";
import { runCancellable } from "./runCancellable.ts";

/** A cold cmake configure plus a full compile on a slow laptop, with margin. */
export const PLUGIN_BUILD_TIMEOUT_MS = 10 * 60 * 1_000;

export interface BuildPluginFromSourceOptions {
  readonly scriptPath: string;
  readonly timeoutMs?: number | undefined;
}

/**
 * Succeeds with the path of the built plugin. Fails with a
 * `ComputerBackendError` whose message carries what the toolchain said, which
 * is the only actionable part of a failed build. Interrupting it stops the
 * build and everything the build started.
 */
export const buildPluginFromSource = (
  options: BuildPluginFromSourceOptions,
): Effect.Effect<string, ComputerBackendError, ChildProcessSpawner.ChildProcessSpawner> =>
  runCancellable("bash", [options.scriptPath, "--build-only"], {
    timeoutMs: options.timeoutMs ?? PLUGIN_BUILD_TIMEOUT_MS,
  }).pipe(
    Effect.catchTags({
      CommandFailedError: (error) =>
        Effect.fail(
          new ComputerBackendError({
            message: `Building the computer-use plugin failed${error.stderrTail ? `: ${error.stderrTail}` : "."}`,
            cause: error,
          }),
        ),
      CommandTimeoutError: (error) =>
        Effect.fail(
          new ComputerBackendError({
            message: `Building the computer-use plugin took longer than ${Math.round(error.timeoutMs / 60_000)} minutes and was stopped.`,
            retryable: true,
            cause: error,
          }),
        ),
      CommandSpawnError: (error) =>
        Effect.fail(
          new ComputerBackendError({
            message: "Building the computer-use plugin needs bash, which could not be started.",
            cause: error,
          }),
        ),
    }),
    Effect.flatMap(({ stdout }) => {
      const path = stdout.trimEnd().split("\n").at(-1)?.trim();
      return path
        ? Effect.succeed(path)
        : Effect.fail(
            new ComputerBackendError({
              message: `${options.scriptPath} --build-only printed no path.`,
            }),
          );
    }),
  );
