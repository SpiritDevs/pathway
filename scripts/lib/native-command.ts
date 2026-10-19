import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

// Native builds (Cua driver, pathway-helper) shell out to git, cargo, swiftc,
// lipo and codesign. These helpers keep that to two shapes: stream to the
// terminal, or capture trimmed stdout.

export class NativeCommandError extends Schema.TaggedErrorClass<NativeCommandError>()(
  "NativeCommandError",
  {
    command: Schema.String,
    exitCode: Schema.optional(Schema.Number),
    stderrTail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status =
      this.exitCode === undefined ? "could not run" : `exited with code ${this.exitCode}`;
    return `${this.command} ${status}${this.stderrTail ? `: ${this.stderrTail}` : ""}`;
  }
}

export interface NativeCommandOptions {
  readonly cwd?: string | undefined;
  readonly env?: Record<string, string | undefined> | undefined;
}

const label = (executable: string, args: ReadonlyArray<string>) =>
  [executable, ...args.slice(0, 2)].join(" ");

const tail = (text: string) => text.trim().split("\n").slice(-20).join("\n");

/** Runs a command with inherited stdio and fails on a non-zero exit. */
export const runInherited = Effect.fn("runInherited")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options: NativeCommandOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner
    .exitCode(
      ChildProcess.make(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: options.env === undefined,
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new NativeCommandError({ command: label(executable, args), cause }),
      ),
    );
  if (exitCode !== 0) {
    return yield* new NativeCommandError({ command: label(executable, args), exitCode });
  }
});

/** Runs a command and returns its trimmed stdout, failing on a non-zero exit. */
export const commandOutput = Effect.fn("commandOutput")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  options: NativeCommandOptions = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = label(executable, args);
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const child = yield* spawner.spawn(
        ChildProcess.make(executable, [...args], {
          cwd: options.cwd,
          env: options.env,
          extendEnv: options.env === undefined,
          stdin: "ignore",
        }),
      );
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
          child.exitCode,
        ],
        { concurrency: "unbounded" },
      );
      if (exitCode !== 0) {
        return yield* new NativeCommandError({ command, exitCode, stderrTail: tail(stderr) });
      }
      return stdout.trim();
    }),
  ).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new NativeCommandError({ command, cause })),
    ),
  );
});

export const sha256Hex = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
