// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { SpawnExecutableResolution } from "@spiritdevs/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/**
 * Windows launcher-script extensions that Node cannot spawn without a shell
 * (`spawn EINVAL` since Node 20.12) and that the Claude Agent SDK therefore
 * cannot use as `pathToClaudeCodeExecutable`.
 */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

/**
 * Entry points of the npm `@anthropic-ai/claude-code` package relative to the
 * global `node_modules` directory that sits next to the npm launcher shim.
 * Newer package versions ship a native `bin/claude.exe`; older versions only
 * ship `cli.js`, which the SDK runs with a JavaScript runtime.
 */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Injectable file-existence check so tests can run against a fake filesystem. */
export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/**
 * Resolves the configured Claude binary path into a value the Claude Agent
 * SDK can spawn directly via `pathToClaudeCodeExecutable`.
 *
 * Resolve command names ourselves so SDK versions with path-existence checks
 * and instances with a custom PATH use the same executable as CLI probes.
 * Windows npm launcher scripts also need unwrapping because the SDK spawns
 * without a shell, producing `spawn EINVAL` for `claude.cmd`.
 *
 * Resolve against the provider instance's PATH on every platform. On Windows,
 * follow npm launcher shims to the real package entry (`bin/claude.exe`, or
 * `cli.js` for older package versions).
 */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcessPlatform;
    const resolveExecutable = yield* SpawnExecutableResolution;
    const resolved = resolveExecutable(binaryPath, platform, environment) ?? binaryPath;
    if (platform !== "win32") {
      return resolved;
    }

    const isFile = yield* ClaudeExecutableFileCheck;
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return binaryPath;
  },
);
