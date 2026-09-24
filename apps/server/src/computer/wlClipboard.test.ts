import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";

import type { ComputerBackendError } from "./computerErrors.ts";
import { makeProcessWitness } from "./provisioning/processWitness.testkit.ts";
import {
  wlClipboardToolsPresent,
  spawnClipboardCommand,
  writeWlClipboardForPaste,
  type ClipboardCommandResult,
  type ClipboardCommandSpec,
} from "./wlClipboard.ts";

/**
 * The process primitive is exercised against real children, because everything
 * it has to get right — a forking child that keeps stderr open, a kill on the
 * output cap, a kill on the deadline — only happens with real pipes. Node runs
 * the children so the suite depends on nothing but the runtime it already has.
 */
function node(source: string, options: Partial<ClipboardCommandSpec> = {}) {
  return spawnClipboardCommand({
    command: process.execPath,
    args: ["-e", source],
    ...options,
  });
}

/** A witness in a scratch directory, both gone after the test. */
const scratchWitness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-wl-clipboard-" });
  return yield* makeProcessWitness(directory);
}).pipe(Effect.provide(NodeServices.layer));

/**
 * Source for a command that leaves a grandchild holding its stderr, as
 * wl-copy's background child does, and exits. The grandchild reports to the
 * witness and runs until it is killed.
 */
function forkingSource(reportScript: string): string {
  // @effect-diagnostics-next-line preferSchemaOverJson:off - quotes source into generated source.
  const quoted = JSON.stringify(reportScript);
  return [
    "require('node:child_process').spawn(process.execPath,",
    `  ['-e', ${quoted}], { stdio: ['ignore', 'ignore', 2] }).unref();`,
    "process.exit(0);",
  ].join(" ");
}

describe("spawnClipboardCommand", () => {
  it.live("hands wl-clipboard the desktop's environment and none of the server's secrets", () =>
    Effect.gen(function* () {
      const saved = process.env.PATHWAY_AUTH_TOKEN;
      process.env.PATHWAY_AUTH_TOKEN = "server-secret";
      const result = yield* spawnClipboardCommand(
        {
          command: process.execPath,
          args: [
            "-e",
            "process.stdout.write([process.env.PATHWAY_AUTH_TOKEN ?? '-', process.env.WAYLAND_DISPLAY ?? '-'].join(' '))",
          ],
        },
        { WAYLAND_DISPLAY: "nested-0" },
      ).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (saved === undefined) delete process.env.PATHWAY_AUTH_TOKEN;
            else process.env.PATHWAY_AUTH_TOKEN = saved;
          }),
        ),
      );
      expect(result.stdout).toBe("- nested-0");
    }),
  );

  it.live("settles with bounded diagnostics when stderr exceeds its limit", () =>
    Effect.gen(function* () {
      const result = yield* node("process.stderr.write('x'.repeat(20000)); process.exitCode=1");
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("diagnostic truncated");
      expect(result.stderr.length).toBeLessThan(8300);
    }),
  );

  it.live("collects output and the exit status of a command that does not fork", () =>
    Effect.gen(function* () {
      const result = yield* node(
        "process.stdout.write('paste me'); process.stderr.write('noise'); process.exit(3)",
      );
      expect(result).toEqual({ outcome: "exited", code: 3, stdout: "paste me", stderr: "noise" });
    }),
  );

  it.live("feeds the payload through stdin", () =>
    Effect.gen(function* () {
      const input = "line one\nline two";
      const result = yield* node("process.stdin.pipe(process.stdout)", { input });
      expect(result).toMatchObject({ outcome: "exited", code: 0, stdout: input });
    }),
  );

  /**
   * wl-copy forks a child that serves the selection and inherits stderr, so the
   * pipes stay open long after the parent is gone. Waiting for them would pin
   * the turn until the next clipboard change.
   */
  it.live("settles on parent exit when the command leaves a child holding stderr", () =>
    Effect.gen(function* () {
      const witness = yield* scratchWitness;
      // The grandchild runs until it is killed, so the pipe never closes on
      // its own: the only way the run settles is by the parent's exit.
      const result = yield* node(forkingSource(witness.reportScript), { forks: true });
      expect(result).toMatchObject({ outcome: "exited", code: 0 });
      const [grandchild] = yield* witness.reported(1);
      // Settled while the grandchild, and so the stderr pipe, were still alive.
      expect(() => process.kill(grandchild!, 0)).not.toThrow();
      process.kill(grandchild!, "SIGKILL");
      yield* witness.allGone;
    }).pipe(Effect.scoped),
  );

  it.live("reports when a watched forked child has exited", () =>
    Effect.gen(function* () {
      const witness = yield* scratchWitness;
      const result = yield* node(forkingSource(witness.reportScript), {
        forks: true,
        observeFork: true,
      });
      expect(result).toMatchObject({ outcome: "exited", code: 0 });
      const [grandchild] = yield* witness.reported(1);
      expect(Deferred.isDoneUnsafe(result.forkExited!)).toBe(false);
      // As wl-copy's paste-once child exits once the paste arrives.
      process.kill(grandchild!, "SIGKILL");
      yield* Deferred.await(result.forkExited!);
    }).pipe(Effect.scoped),
  );

  it.live("ends a watched forked child on request, whose pid nothing reports", () =>
    Effect.gen(function* () {
      const witness = yield* scratchWitness;
      const result = yield* node(forkingSource(witness.reportScript), {
        forks: true,
        observeFork: true,
      });
      yield* witness.reported(1);
      expect(result.endFork).toBeTypeOf("function");
      result.endFork?.();
      yield* Deferred.await(result.forkExited!);
      yield* witness.allGone;
      // Ending again, once it is gone, signals nothing.
      result.endFork?.();
    }).pipe(Effect.scoped),
  );

  it.live("watches nothing unless asked", () =>
    Effect.gen(function* () {
      const result = yield* node("process.exit(0)", { forks: true });
      expect(result.forkExited).toBeUndefined();
    }),
  );

  it.live("kills a command that passes the output cap", () =>
    Effect.gen(function* () {
      const result = yield* node(
        "process.stdout.write('a'.repeat(64)); setTimeout(() => {}, 4000);",
        { maxOutputBytes: 8 },
      );
      expect(result).toMatchObject({ outcome: "output-limit", stdout: "" });
    }),
  );

  it.live("kills a command that outlives the deadline", () =>
    Effect.gen(function* () {
      const result = yield* node("setTimeout(() => {}, 4000)", { timeoutMs: 50 });
      expect(result).toMatchObject({ outcome: "timed-out", code: null });
    }),
  );

  it.live("fails with the spawn error when the binary is missing", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        spawnClipboardCommand({ command: "pathway-absent-clipboard-binary", args: [] }),
      );
      expect(error.code).toBe("ENOENT");
    }),
  );
});

describe("writeWlClipboardForPaste", () => {
  it.effect("offers the text for one paste and hands back the offer's end", () =>
    Effect.gen(function* () {
      const specs: ClipboardCommandSpec[] = [];
      const ended = Deferred.makeUnsafe<void, ComputerBackendError>();
      const offer = yield* writeWlClipboardForPaste(
        (spec) =>
          Effect.sync((): ClipboardCommandResult => {
            specs.push(spec);
            return { outcome: "exited", code: 0, stdout: "", stderr: "", forkExited: ended };
          }),
        "agent text",
      );
      expect(specs).toEqual([
        {
          command: "wl-copy",
          args: ["--paste-once", "--type", "text/plain"],
          input: "agent text",
          forks: true,
          observeFork: true,
        },
      ]);
      expect(Deferred.isDoneUnsafe(offer.consumed)).toBe(false);
      Deferred.doneUnsafe(ended, Exit.void);
      yield* Deferred.await(offer.consumed);
    }),
  );

  it.effect("can withdraw the offer, ending wl-copy's background child", () =>
    Effect.gen(function* () {
      let ended = 0;
      const offer = yield* writeWlClipboardForPaste(
        () =>
          Effect.succeed({
            outcome: "exited",
            code: 0,
            stdout: "",
            stderr: "",
            forkExited: Deferred.makeUnsafe<void, ComputerBackendError>(),
            endFork: () => {
              ended += 1;
            },
          }),
        "agent text",
      );
      offer.withdraw();
      expect(ended).toBe(1);
    }),
  );

  it.effect("fails like an ordinary write when wl-copy fails", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        writeWlClipboardForPaste(
          () => Effect.succeed({ outcome: "exited", code: 1, stdout: "", stderr: "no seat\n" }),
          "x",
        ),
      );
      expect(error.message).toBe("wl-copy failed to write the desktop clipboard: no seat");
    }),
  );
});

describe("wlClipboardToolsPresent", () => {
  it.each<{ commands: string[] }>([
    { commands: [] },
    { commands: ["wl-copy"] },
    { commands: ["wl-paste"] },
  ])("requires both utilities: $commands", ({ commands }) => {
    expect(wlClipboardToolsPresent((command) => commands.includes(command))).toBe(false);
  });

  it("recognizes both directions", () => {
    expect(wlClipboardToolsPresent((command) => ["wl-copy", "wl-paste"].includes(command))).toBe(
      true,
    );
  });
});
