// @effect-diagnostics preferSchemaOverJson:off - fixtures assert on the raw JSONL records the log writes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  COMPUTER_AUDIT_LOG_FILE,
  COMPUTER_AUDIT_MAX_BYTES,
  COMPUTER_AUDIT_MAX_ENTRIES,
  makeComputerAuditLog,
  summarizeComputerAuditArgs,
} from "./computerAuditLog.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  return { fs, path, dir, file: path.join(dir, "computer-audit.jsonl") };
});

const readLines = (fs: FileSystem.FileSystem, file: string) =>
  fs.readFileString(file).pipe(Effect.map((text) => text.trim().split("\n")));

/**
 * Wraps the file system to record every positional read, so a test can prove
 * retention never reads a legacy log's prefix or the whole file.
 */
function instrumented(fs: FileSystem.FileSystem) {
  const reads: Array<{ readonly position: number; readonly length: number }> = [];
  let wholeFileReads = 0;
  const wrapped: FileSystem.FileSystem = {
    ...fs,
    readFile: (path) => {
      wholeFileReads += 1;
      return fs.readFile(path);
    },
    readFileString: (path, encoding) => {
      wholeFileReads += 1;
      return fs.readFileString(path, encoding);
    },
    stream: (path, options) => {
      wholeFileReads += 1;
      return fs.stream(path, options);
    },
    open: (path, options) =>
      Effect.map(fs.open(path, options), (file) => {
        let position = 0;
        return new Proxy(file, {
          get(target, key, receiver) {
            if (key === "seek") {
              return (offset: FileSystem.SizeInput, from: FileSystem.SeekMode) => {
                position = from === "start" ? Number(offset) : position + Number(offset);
                return target.seek(offset, from);
              };
            }
            if (key === "read") {
              return (buffer: Uint8Array) =>
                Effect.map(target.read(buffer), (size) => {
                  reads.push({ position, length: buffer.length });
                  position += Number(size);
                  return size;
                });
            }
            return Reflect.get(target, key, receiver);
          },
        });
      }),
  };
  return { wrapped, reads, wholeFileReads: () => wholeFileReads };
}

describe("summarizeComputerAuditArgs", () => {
  it("records typed text as a character count, never the payload", () => {
    const summary = summarizeComputerAuditArgs({ text: "hunter2 -- a typed secret", x: 10, y: 20 });
    expect(summary).toEqual({ text: { chars: 25 }, x: 10, y: 20 });
    expect(JSON.stringify(summary)).not.toContain("hunter2");
  });

  it("records clipboard and file payloads as counts only", () => {
    const summary = summarizeComputerAuditArgs({
      contents: "clipboard payload with a token",
      value: "set_value payload",
      arguments: ["--password=s3cret"],
      files: ["/tmp/a", "/tmp/b"],
      label: "OK",
    });
    expect(JSON.stringify(summary)).not.toContain("s3cret");
    expect(JSON.stringify(summary)).not.toContain("token");
    expect(JSON.stringify(summary)).not.toContain("/tmp/a");
    expect(summary.contents).toEqual({ chars: 30 });
    expect(summary.value).toEqual({ chars: 17 });
    expect(summary.arguments).toEqual({ items: 1 });
    expect(summary.files).toEqual({ items: 2 });
    expect(summary.label).toBe("OK");
  });

  it("keeps a computer_run's step shape without the step payloads", () => {
    const summary = summarizeComputerAuditArgs({
      steps: [
        { type: "click", x: 1, y: 2 },
        { type: "type", text: "password" },
      ],
    });
    expect(summary.steps).toEqual({ count: 2, types: ["click", "type"] });
    expect(JSON.stringify(summary)).not.toContain("password");
  });

  it("sanitizes sensitive keys nested inside a target object", () => {
    const summary = summarizeComputerAuditArgs({
      target: { windowId: "w1", value: "field payload", x: 5 },
    });
    const target = summary.target as Record<string, unknown>;
    expect(target.value).toEqual({ chars: 13 });
    expect(target.windowId).toBe("w1");
    expect(JSON.stringify(summary)).not.toContain("field payload");
  });
});

it.layer(NodeServices.layer)("ComputerAuditLog", (it) => {
  it.effect("persists reviewed native diagnostics but strips arbitrary native payloads", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      const log = yield* makeComputerAuditLog(file);
      const diagnostics = {
        delivery_path: "ax" as const,
        actuator: "ax_press" as const,
        ax_error: -25202,
        window_title: "private window title",
        message: "private field value",
        text: "private typed content",
      };
      yield* log.record({
        tool: "computer_click",
        effect: "dispatched-unknown",
        code: "cua_action_failed",
        diagnostics,
      });
      yield* log.flush;
      const saved = yield* fs.readFileString(file);
      expect(JSON.parse(saved).diagnostics).toEqual({
        delivery_path: "ax",
        actuator: "ax_press",
        ax_error: -25202,
      });
      expect(saved).not.toContain("private");
    }),
  );

  it.effect("appends one JSON object per line with timestamp, target, and effect", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      const log = yield* makeComputerAuditLog(file);
      yield* log.record({
        tool: "computer_click",
        threadId: "thread-1",
        turnId: "turn-1",
        target: { windowId: "w1", pid: 42, app: "Finder" },
        args: { x: 10, y: 20 },
        effect: "verified",
      });
      yield* log.record({
        tool: "computer_type_text",
        threadId: "thread-1",
        target: { windowId: "w1" },
        args: { text: { chars: 12 } },
        effect: "refused",
        code: "computer_denylist_refused",
      });
      yield* log.flush;
      const lines = yield* readLines(fs, file);
      expect(lines).toHaveLength(2);
      const first = JSON.parse(lines[0]!);
      expect(first.tool).toBe("computer_click");
      expect(first.threadId).toBe("thread-1");
      expect(first.turnId).toBe("turn-1");
      expect(first.target).toEqual({ windowId: "w1", pid: 42, app: "Finder" });
      expect(first.effect).toBe("verified");
      expect(first.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      const second = JSON.parse(lines[1]!);
      expect(second.effect).toBe("refused");
      expect(second.code).toBe("computer_denylist_refused");
      expect(((yield* fs.stat(file)).mode & 0o777).toString(8)).toBe("600");
    }),
  );

  it.effect("serializes concurrent appends into intact ordered lines", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      const log = yield* makeComputerAuditLog(file);
      for (let index = 0; index < 100; index += 1) {
        yield* log.record({
          tool: "computer_click",
          threadId: "thread",
          args: { index },
          effect: "dispatched-unknown",
        });
      }
      yield* log.flush;
      const lines = yield* readLines(fs, file);
      expect(lines).toHaveLength(100);
      for (const [index, line] of lines.entries()) {
        expect(JSON.parse(line).args).toEqual({ index });
      }
    }),
  );

  it.effect("counts a pre-existing log toward the entry cap and compacts to a bounded tail", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      const seeded = Array.from(
        { length: COMPUTER_AUDIT_MAX_ENTRIES },
        (_, index) => `${JSON.stringify({ ts: "old", tool: "computer_click", args: { index } })}\n`,
      ).join("");
      yield* fs.writeFileString(file, seeded, { mode: 0o600 });
      const log = yield* makeComputerAuditLog(file);
      yield* log.record({ tool: "computer_click", args: { index: -1 }, effect: "verified" });
      yield* log.flush;
      const lines = yield* readLines(fs, file);
      // Compaction keeps a bounded newest tail ending in the record just written.
      expect(lines.length).toBeLessThan(COMPUTER_AUDIT_MAX_ENTRIES);
      expect(lines.length).toBeGreaterThan(0);
      expect(JSON.parse(lines.at(-1)!).args).toEqual({ index: -1 });
    }),
  );

  it.effect("swallows write failures instead of failing the recorded action", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* fixture;
      // A path whose parent is a file can never be opened.
      const blocker = path.join(dir, "blocker");
      yield* fs.writeFileString(blocker, "x");
      const log = yield* makeComputerAuditLog(path.join(blocker, "computer-audit.jsonl"));
      yield* log.record({ tool: "computer_click", effect: "verified" });
      yield* log.flush;
    }),
  );

  it.effect("retains a bounded UTF-8 tail of a huge legacy file without reading its prefix", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      // Sparse history makes a full-file read materially larger than the allowed
      // evidence tail without allocating that prefix in the fixture itself.
      const prefixBytes = 16 * COMPUTER_AUDIT_MAX_BYTES;
      const tail =
        Array.from({ length: 2_000 }, (_, index) =>
          JSON.stringify({
            ts: "old",
            tool: "computer_click",
            args: { index, label: "界🙂".repeat(100) },
          }),
        ).join("\n") + "\n";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const legacy = yield* fs.open(file, { flag: "w", mode: 0o600 });
          yield* legacy.truncate(prefixBytes);
          yield* legacy.seek(prefixBytes, "start");
          yield* legacy.writeAll(new TextEncoder().encode(tail));
        }),
      );

      const probe = instrumented(fs);
      const log = yield* makeComputerAuditLog(file).pipe(
        Effect.provideService(FileSystem.FileSystem, probe.wrapped),
      );
      yield* log.record({ tool: "computer_click", args: { index: -1 }, effect: "verified" });
      yield* log.record({ tool: "computer_click", args: { index: -2 }, effect: "verified" });
      yield* log.flush;
      expect(probe.wholeFileReads()).toBe(0);
      expect(probe.reads.length).toBeGreaterThan(0);
      expect(
        probe.reads.every(
          ({ position, length }) =>
            length <= COMPUTER_AUDIT_MAX_BYTES &&
            position >= prefixBytes - COMPUTER_AUDIT_MAX_BYTES,
        ),
      ).toBe(true);
      expect(probe.reads.reduce((bytes, { length }) => bytes + length, 0)).toBeLessThanOrEqual(
        2 * COMPUTER_AUDIT_MAX_BYTES,
      );

      const retained = yield* fs.readFileString(file);
      const entries = retained
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(Buffer.byteLength(retained, "utf8")).toBeLessThanOrEqual(COMPUTER_AUDIT_MAX_BYTES);
      expect(entries.length).toBeLessThanOrEqual(COMPUTER_AUDIT_MAX_ENTRIES);
      expect(entries.slice(-2).map((entry) => entry.args.index)).toEqual([-1, -2]);
      const historical = entries.slice(0, -2);
      expect(historical.length).toBeGreaterThan(0);
      expect(historical.at(-1).args.index).toBe(1_999);
      expect(historical.every((entry) => entry.args.label === "界🙂".repeat(100))).toBe(true);
      expect(
        historical.every(
          (entry, index) =>
            index === 0 || entry.args.index === historical[index - 1].args.index + 1,
        ),
      ).toBe(true);
    }),
  );

  it.effect("omits oversized or unserializable evidence without poisoning subsequent appends", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      const log = yield* makeComputerAuditLog(file);
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      yield* log.record({ tool: "computer_click", args: circular, effect: "verified" });
      yield* log.record({
        tool: "computer_click",
        args: { label: "界".repeat(COMPUTER_AUDIT_MAX_BYTES) },
        effect: "verified",
      });
      yield* log.record({ tool: "computer_click", mcpRequestId: "next", effect: "verified" });
      yield* log.flush;
      const lines = yield* readLines(fs, file);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).mcpRequestId).toBe("next");
    }),
  );

  it.effect("separates an interrupted legacy tail from the next complete action", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(file, '{"tool":"computer_click"');
      const log = yield* makeComputerAuditLog(file);
      yield* log.record({ tool: "computer_click", mcpRequestId: "next", effect: "verified" });
      expect(yield* log.readHistory({})).toMatchObject({
        entries: [{ mcpRequestId: "next" }],
        truncated: true,
      });
    }),
  );

  it.effect("closing the log's scope writes queued evidence", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* Effect.scoped(
        Effect.flatMap(makeComputerAuditLog(file), (log) =>
          log.record({ tool: "computer_click", mcpRequestId: "last", effect: "verified" }),
        ),
      );
      const lines = yield* readLines(fs, file);
      expect(JSON.parse(lines[0]!).mcpRequestId).toBe("last");
    }),
  );
});

it.layer(NodeServices.layer)("ComputerManager audit seam", (it) => {
  it.effect(
    "a thread whose control is off records nothing, even for the refusal that stopped it",
    () =>
      Effect.gen(function* () {
        const { fs, path, dir } = yield* fixture;
        const threadId = "disabled-thread";
        // Closing the inner scope disposes the manager, draining queued audit writes.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const manager = yield* ComputerManager.make({
              backend: new FakeComputerBackend(),
              stateDir: dir,
              actionSettleMs: 0,
            });
            yield* manager.setControlEnabled(threadId, false);
            yield* manager.recordComputerAudit({
              tool: "computer_click",
              threadId,
              args: { x: 1, y: 1 },
              effect: "refused",
              code: "computer_control_revoked",
            });
          }),
        );
        expect(yield* fs.exists(path.join(dir, COMPUTER_AUDIT_LOG_FILE))).toBe(false);
      }),
  );

  it.effect("a disabled thread records nothing at all — no lifecycle row survives the drop", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* fixture;
      const threadId = "disabled-thread";
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
            actionSettleMs: 0,
          });
          yield* manager.setControlEnabled(threadId, false);
          // A refused input attempt on a disabled thread still drops.
          yield* manager.recordComputerAudit({
            tool: "computer_click",
            threadId,
            args: { x: 1, y: 1 },
            effect: "refused",
            code: "computer_control_revoked",
          });
        }),
      );
      expect(yield* fs.exists(path.join(dir, COMPUTER_AUDIT_LOG_FILE))).toBe(false);
    }),
  );

  it.effect("records through the manager once control is enabled", () =>
    Effect.gen(function* () {
      const { fs, path, dir } = yield* fixture;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            stateDir: dir,
            actionSettleMs: 0,
          });
          yield* manager.recordComputerAudit({
            tool: "computer_click",
            threadId: "enabled-thread",
            effect: "verified",
          });
        }),
      );
      const lines = yield* readLines(fs, path.join(dir, COMPUTER_AUDIT_LOG_FILE));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!).effect).toBe("verified");
    }),
  );
});
