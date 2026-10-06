import { DesktopShellEnvironmentPatch } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { readBootstrapEnvelope } from "./bootstrap.ts";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@spiritdevs/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

function hydratePosixPath(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): void {
  let shellPath: string | undefined;
  for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
    try {
      shellPath = readPathFromLoginShell(shell);
    } catch (error) {
      logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
    }

    if (shellPath) break;
  }

  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export function hydratePosixHome(
  env: NodeJS.ProcessEnv,
  resolveHomeDir = () => NodeOS.userInfo().homedir,
): void {
  if ((env.HOME?.trim() ?? "").length > 0) return;

  const homeDir = resolveHomeDir();
  if (homeDir.length > 0) {
    env.HOME = homeDir;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (options?: {
  readonly shellEnvironmentHydrated?: boolean | undefined;
  readonly shellEnvironmentFd?: number | undefined;
}): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (options?.shellEnvironmentFd !== undefined) {
    const receive = receiveDesktopShellEnvironment(options.shellEnvironmentFd).pipe(
      Effect.provideService(HostProcessEnvironment, env),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to receive desktop shell environment", { cause }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (options.shellEnvironmentHydrated) {
      yield* Effect.forkScoped(receive);
    } else if (yield* receive) {
      if (platform !== "win32") yield* Effect.sync(() => hydratePosixHome(env));
      return;
    }
  }
  if (platform === "win32") {
    if (options?.shellEnvironmentHydrated) return;
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  yield* Effect.sync(() => hydratePosixHome(env)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate HOME from the user account.", defect);
      }),
    ),
  );
  // The native desktop supplied a validated cached environment or a fresh handoff.
  // Preserve HOME repair above; WSL and standalone servers still need their own PATH.
  if (options?.shellEnvironmentHydrated) return;
  yield* Effect.sync(() => hydratePosixPath(env, platform)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".pathway");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});

export const receiveDesktopShellEnvironment = Effect.fn("receiveDesktopShellEnvironment")(
  function* (fd: number) {
    const env = yield* HostProcessEnvironment;
    const patch = yield* readBootstrapEnvelope(DesktopShellEnvironmentPatch, fd, {
      timeoutMs: 30_000,
    });
    if (Option.isNone(patch) || !patch.value.PATH) return false;
    for (const name of Object.keys(DesktopShellEnvironmentPatch.fields) as Array<
      keyof DesktopShellEnvironmentPatch
    >) {
      if (patch.value[name] !== undefined) env[name] = patch.value[name];
      else delete env[name];
    }
    return true;
  },
);
