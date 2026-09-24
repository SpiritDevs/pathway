/**
 * A sealed environment for running the plugins' installer scripts in tests.
 *
 * The scripts talk to a live compositor, a session bus and a compiler, and on
 * a developer's machine all three are real: an installer test that reached
 * the real `busctl`, `hyprctl` or `kwin_wayland` would act on the desktop the
 * developer is sitting at. So the PATH here holds nothing but an allowlist of
 * plain tools (linked from the system) and the stubs a test writes, HOME and
 * the XDG roots are fresh temp directories, and no bus or display variable is
 * passed through. A command the test did not stub and the allowlist does not
 * name is simply not there.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** Plain tools the installers use; nothing that talks to a desktop or a compiler. */
const ALLOWED_TOOLS = [
  "awk",
  "basename",
  "bash",
  "cat",
  "chmod",
  "cp",
  "date",
  "dirname",
  "env",
  "find",
  "flock",
  "grep",
  "head",
  "id",
  "install",
  "ln",
  "ls",
  "mkdir",
  "mktemp",
  "mv",
  "readlink",
  "rm",
  "sed",
  "sh",
  "sleep",
  "sort",
  "sha256sum",
  "stat",
  "tail",
  "touch",
  "tr",
] as const;

const SYSTEM_BIN_DIRECTORIES = ["/usr/bin", "/bin"] as const;

export interface ScriptRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface InstallScriptSandbox {
  readonly root: string;
  readonly home: string;
  /** Where stubs append one line per invocation (`<name> <args>`). */
  readonly callLog: string;
  /** Scratch directory stubs may keep state in (`$STUB_STATE`). */
  readonly stubState: string;
  /** Writes a stub command; `body` runs under bash with `$STUB_STATE` and `$STUB_LOG` set. */
  readonly stub: (name: string, body: string) => Effect.Effect<void>;
  /** Every stub invocation so far, oldest first. */
  readonly calls: Effect.Effect<readonly string[]>;
  /** Runs `script` under bash with core dumps off and only the sandbox environment. */
  readonly run: (
    script: string,
    args: readonly string[],
    env?: Record<string, string>,
  ) => Effect.Effect<ScriptRun>;
}

/**
 * A sandbox in a fresh temp directory, removed when the scope closes. Setup
 * failures are defects: a host missing an allowlisted tool cannot run these
 * tests at all.
 */
export const makeInstallScriptSandbox: Effect.Effect<
  InstallScriptSandbox,
  never,
  Scope.Scope | FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const systemTool = Effect.fn(function* (name: string) {
    for (const directory of SYSTEM_BIN_DIRECTORIES) {
      const candidate = path.join(directory, name);
      if (yield* fs.exists(candidate)) return candidate;
    }
    return yield* Effect.die(`installScriptSandbox: ${name} is not installed on this host`);
  });

  const root = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-install-script-" });
  const home = path.join(root, "home");
  const tools = path.join(root, "tools");
  const stubs = path.join(root, "stubs");
  const stubState = path.join(root, "stub-state");
  const callLog = path.join(root, "calls.log");
  yield* Effect.forEach(
    [home, tools, stubs, stubState],
    (directory) => fs.makeDirectory(directory, { recursive: true }),
    { discard: true },
  );
  yield* fs.writeFileString(callLog, "");
  yield* Effect.forEach(
    ALLOWED_TOOLS,
    (name) => Effect.flatMap(systemTool(name), (tool) => fs.symlink(tool, path.join(tools, name))),
    { discard: true },
  );
  const bash = yield* systemTool("bash");

  const baseEnv: Record<string, string> = {
    PATH: `${stubs}:${tools}`,
    HOME: home,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LANG: "C",
    STUB_STATE: stubState,
    STUB_LOG: callLog,
  };

  const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
    stream.pipe(
      Stream.decodeText,
      Stream.mkString,
      Effect.orElseSucceed(() => ""),
    );

  return {
    root,
    home,
    callLog,
    stubState,
    stub: (name, body) => {
      const file = path.join(stubs, name);
      return fs
        .writeFileString(
          file,
          `#!${bash}\nset -euo pipefail\nprintf '%s\\n' "${name} $*" >>"$STUB_LOG"\n${body}\n`,
        )
        .pipe(Effect.andThen(fs.chmod(file, 0o755)), Effect.orDie);
    },
    calls: fs.readFileString(callLog).pipe(
      Effect.map((text) => text.split("\n").filter(Boolean)),
      Effect.orDie,
    ),
    run: (script, args, env = {}) =>
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make(bash, ["-c", 'ulimit -c 0; exec bash "$0" "$@"', script, ...args], {
              env: { ...baseEnv, ...env },
              stdin: "ignore",
            }),
          );
          const [stdout, stderr] = yield* Effect.all(
            [collect(child.stdout), collect(child.stderr)],
            { concurrency: "unbounded" },
          );
          const status = yield* child.exitCode.pipe(
            Effect.map((code): number | null => code),
            Effect.orElseSucceed(() => null),
          );
          return { status, stdout, stderr };
        }),
      ).pipe(Effect.timeout("60 seconds"), Effect.orDie),
  } satisfies InstallScriptSandbox;
}).pipe(Effect.orDie);
