import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { makeProcessWitness } from "./processWitness.testkit.ts";
import { type CommandFailedError, runCancellable, stderrTail } from "./runCancellable.ts";

const node = process.execPath;

/** A scratch directory and a witness listening in it, both gone after the test. */
const scratch = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-run-cancellable-" });
  return { directory, witness: yield* makeProcessWitness(directory) };
});

describe("runCancellable", () => {
  it.live("succeeds with the streams and exit code of a successful command", () =>
    Effect.gen(function* () {
      const result = yield* runCancellable(node, [
        "-e",
        "console.log('one'); console.log('two'); process.stderr.write('note')",
      ]);
      expect(result).toEqual({ stdout: "one\ntwo\n", stderr: "note", code: 0 });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails a non-zero exit with an error that carries the stderr tail", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        runCancellable(node, [
          "-e",
          "console.error('first'); console.error('the actual reason'); process.exit(3)",
        ]),
      );
      if (error._tag !== "CommandFailedError") return expect.unreachable(error._tag);
      const failed: CommandFailedError = error;
      expect(failed.code).toBe(3);
      expect(failed.command).toBe(node);
      expect(failed.stderrTail).toContain("the actual reason");
      expect(failed.message).toContain(node);
      expect(failed.message).toContain("the actual reason");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it("keeps only the last lines of a long stderr in the tail", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`);
    const tail = stderrTail(`${lines.join("\n")}\n`);
    expect(tail.split("\n")).toHaveLength(12);
    expect(tail.endsWith("line 39")).toBe(true);
  });

  it.live("fails when the command does not exist", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { directory } = yield* scratch;
      const error = yield* Effect.flip(runCancellable(path.join(directory, "no-such-binary"), []));
      expect(error._tag).toBe("CommandSpawnError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("bounds captured output and keeps the tail, which is where the answer is", () =>
    Effect.gen(function* () {
      const result = yield* runCancellable(
        node,
        [
          "-e",
          "for (let i = 0; i < 20000; i++) console.log('filler line ' + i); console.log('last')",
        ],
        { maxOutputBytes: 2048 },
      );
      expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2048);
      expect(result.stdout.trimEnd().split("\n").at(-1)).toBe("last");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("takes the whole process tree down when interrupted", () =>
    Effect.gen(function* () {
      const { witness } = yield* scratch;
      // A child that spawns a grandchild and then lives on until told
      // otherwise - the shape of `bash -> cmake -> ninja -> cc`.
      // @effect-diagnostics-next-line preferSchemaOverJson:off - quotes source into generated source.
      const grandchild = JSON.stringify(witness.reportScript);
      const script = `
        require('node:child_process').spawn(process.execPath, ['-e', ${grandchild}], { stdio: 'ignore' });
        ${witness.reportScript}
      `;
      const run = yield* Effect.forkChild(runCancellable(node, ["-e", script]), {
        startImmediately: true,
      });
      yield* witness.reported(2);

      yield* Fiber.interrupt(run);
      const exit = yield* Fiber.await(run);
      expect(Exit.hasInterrupts(exit)).toBe(true);
      // Both connections close only when their processes die; nothing here
      // sleeps or polls.
      yield* witness.allGone;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a command that outlives its timeout and names it in the error", () =>
    Effect.gen(function* () {
      const { witness } = yield* scratch;
      const run = yield* Effect.forkChild(
        Effect.flip(runCancellable(node, ["-e", witness.reportScript], { timeoutMs: 2_000 })),
        { startImmediately: true },
      );
      yield* witness.reported(1);
      const error = yield* Fiber.join(run);
      if (error._tag !== "CommandTimeoutError") return expect.unreachable(error._tag);
      expect(error.command).toBe(node);
      expect(error.message).toContain(node);
      yield* witness.allGone;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "escalates to SIGKILL for a child that ignores SIGTERM",
    () =>
      Effect.gen(function* () {
        const { witness } = yield* scratch;
        const script = `process.on('SIGTERM', () => {}); ${witness.reportScript}`;
        const run = yield* Effect.forkChild(runCancellable(node, ["-e", script]), {
          startImmediately: true,
        });
        yield* witness.reported(1);
        yield* Fiber.interrupt(run);
        expect(Exit.hasInterrupts(yield* Fiber.await(run))).toBe(true);
        yield* witness.allGone;
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    15_000,
  );
});
