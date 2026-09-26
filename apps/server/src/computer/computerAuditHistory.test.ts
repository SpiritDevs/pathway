// @effect-diagnostics preferSchemaOverJson:off - fixtures assert on the raw JSONL records the log writes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ComputerGetAuditHistoryResult } from "@spiritdevs/contracts";
import { isHostWindows } from "@spiritdevs/shared/hostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  COMPUTER_AUDIT_HISTORY_MAX_BYTES,
  COMPUTER_AUDIT_HISTORY_MAX_ROWS,
  readComputerAuditHistory,
} from "./computerAuditHistory.ts";
import { computerAuditMcpRequestId, makeComputerAuditLog } from "./computerAuditLog.ts";

const decodeHistoryResult = Schema.decodeUnknownEffect(ComputerGetAuditHistoryResult);

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped();
  return { fs, file: path.join(dir, "computer-audit.jsonl") };
});

function line(index: number, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: "2026-09-20T12:00:00.000Z",
    tool: "computer_click",
    effect: "dispatched-unknown",
    mcpRequestId: String(index),
    ...extra,
  })}\n`;
}

const ids = (result: {
  readonly entries: ReadonlyArray<{ readonly mcpRequestId?: string | undefined }>;
}) => result.entries.map((entry) => entry.mcpRequestId);

it.layer(NodeServices.layer)("Computer audit history", (it) => {
  it.effect("distinguishes absent logging, no history, and an empty retained log", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      expect(yield* readComputerAuditHistory(undefined, {})).toMatchObject({
        status: "disabled",
        entries: [],
      });
      expect(yield* readComputerAuditHistory(file, {})).toMatchObject({ status: "missing" });
      yield* fs.writeFileString(file, "");
      expect(yield* readComputerAuditHistory(file, {})).toEqual({
        status: "available",
        entries: [],
        nextCursor: null,
        truncated: false,
      });
    }),
  );

  it.effect("projects only bounded identifiers and typed outcomes, never payloads or paths", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(
        file,
        line(1, {
          threadId: "thread-1",
          turnId: "turn-1",
          effect: "refused",
          code: "computer_control_revoked",
          args: { text: "secret", url: "https://private.test/?token=secret" },
          target: { app: "secret", windowId: "secret", path: "/private/secret" },
          result: "secret",
          password: "secret",
        }) +
          line(2, {
            threadId: "/private/secret",
            code: "secret\ncredential",
            turnId: "x".repeat(129),
          }),
      );
      const result = yield* readComputerAuditHistory(file, {});
      expect(yield* decodeHistoryResult(result)).toEqual(result);
      expect(JSON.stringify(result)).not.toContain("secret");
      expect(result.entries[1]).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
        mcpRequestId: "1",
        code: "computer_control_revoked",
        effect: "refused",
      });
      expect(Object.keys(result.entries[0]!)).toEqual([
        "id",
        "ts",
        "tool",
        "effect",
        "mcpRequestId",
      ]);
    }),
  );

  it.effect("keeps append-order pagination stable when newer actions arrive", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(file, [1, 2, 3, 4].map((n) => line(n)).join(""));
      const first = yield* readComputerAuditHistory(file, { limit: 2 });
      expect(ids(first)).toEqual(["4", "3"]);
      yield* fs.writeFileString(file, line(5), { flag: "a" });
      const second = yield* readComputerAuditHistory(file, {
        limit: 2,
        before: first.nextCursor!,
      });
      expect(ids(second)).toEqual(["2", "1"]);
      expect(second.nextCursor).toBeNull();
      expect(second.truncated).toBe(false);
    }),
  );

  it.effect("reads known rotations and preserves distinct identical records", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(file, line(1) + line(1) + line(2));
      const first = yield* readComputerAuditHistory(file, { limit: 2 });
      yield* fs.rename(file, `${file}.1`);
      yield* fs.writeFileString(file, line(3));
      yield* fs.writeFileString(`${file}.2`, line(0));
      const second = yield* readComputerAuditHistory(file, { before: first.nextCursor! });
      expect(ids(second)).toEqual(["1", "0"]);
      expect(second.entries[0]!.id).not.toEqual(first.entries[1]!.id);
      expect(second.truncated).toBe(false);
    }),
  );

  it.effect("recovers a uniquely retained cursor after compaction and marks expired cursors", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(file, [1, 2, 3, 4].map((n) => line(n)).join(""));
      const first = yield* readComputerAuditHistory(file, { limit: 2 });
      yield* fs.writeFileString(`${file}.tmp`, [2, 3, 4, 5].map((n) => line(n)).join(""));
      yield* fs.rename(`${file}.tmp`, file);
      const retained = yield* readComputerAuditHistory(file, { before: first.nextCursor! });
      expect(ids(retained)).toEqual(["2"]);
      yield* fs.writeFileString(`${file}.tmp`, line(5));
      yield* fs.rename(`${file}.tmp`, file);
      expect(yield* readComputerAuditHistory(file, { before: first.nextCursor! })).toEqual({
        entries: [],
        nextCursor: null,
        truncated: true,
        status: "available",
      });
    }),
  );

  it.effect("does not guess an ambiguous duplicate cursor after compaction", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(file, line(1) + line(1));
      const first = yield* readComputerAuditHistory(file, { limit: 1 });
      yield* fs.writeFileString(`${file}.tmp`, line(1) + line(1) + line(2));
      yield* fs.rename(`${file}.tmp`, file);
      expect(yield* readComputerAuditHistory(file, { before: first.nextCursor! })).toMatchObject({
        entries: [],
        nextCursor: null,
        truncated: true,
      });
    }),
  );

  it.effect("bounds bytes and skips oversized, malformed and incomplete records", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(
        file,
        "x".repeat(COMPUTER_AUDIT_HISTORY_MAX_BYTES + 1) + "\n{invalid}\n" + line(1) + '{"secret":',
      );
      const result = yield* readComputerAuditHistory(file, { limit: 100 });
      expect(ids(result)).toEqual(["1"]);
      expect(result.truncated).toBe(true);
    }),
  );

  it.effect(
    "bounds scanned rows and results, including when an old cursor is outside the tail",
    () =>
      Effect.gen(function* () {
        const { fs, file } = yield* fixture;
        yield* fs.writeFileString(file, line(1) + line(2));
        const initial = yield* readComputerAuditHistory(file, { limit: 1 });
        yield* fs.writeFileString(file, line(3).repeat(COMPUTER_AUDIT_HISTORY_MAX_ROWS + 1), {
          flag: "a",
        });
        const result = yield* readComputerAuditHistory(file, { limit: 100 });
        expect(result.entries).toHaveLength(100);
        expect(result.truncated).toBe(true);
        expect(
          yield* readComputerAuditHistory(file, { before: initial.nextCursor! }),
        ).toMatchObject({ entries: [], truncated: true });
      }),
  );

  it.effect("refuses symbolic links instead of following arbitrary paths", () =>
    Effect.gen(function* () {
      // Windows symlinks need elevated rights; the refusal is platform-neutral.
      if (yield* isHostWindows) return;
      const { fs, file } = yield* fixture;
      yield* fs.writeFileString(`${file}.private`, line(1));
      yield* fs.symlink(`${file}.private`, file);
      const error = yield* Effect.flip(readComputerAuditHistory(file, {}));
      expect(error.message).toBe("Could not read Computer activity history.");
    }),
  );

  it.effect(
    "rejects invalid limits and cursor formats without treating them as filesystem paths",
    () =>
      Effect.gen(function* () {
        const { file } = yield* fixture;
        expect(
          (yield* Effect.flip(readComputerAuditHistory(file, { limit: 101 }))).message,
        ).toContain("between 1 and 100");
        for (const before of ["../../private", "e30"]) {
          expect(
            (yield* Effect.flip(readComputerAuditHistory(file, { before }))).message,
          ).toContain("Invalid Computer activity cursor");
        }
      }),
  );

  it.effect("waits for queued evidence before reading through the log owner", () =>
    Effect.gen(function* () {
      const { file } = yield* fixture;
      const log = yield* makeComputerAuditLog(file);
      yield* log.record({ tool: "computer_click", effect: "verified", mcpRequestId: "request-1" });
      expect(yield* log.readHistory({})).toMatchObject({
        entries: [{ tool: "computer_click", effect: "verified", mcpRequestId: "request-1" }],
      });
    }),
  );
});

describe("audit MCP request identity", () => {
  it("keeps actual bounded transport identities and omits payload-like values", () => {
    expect(computerAuditMcpRequestId(42)).toEqual({ mcpRequestId: "42" });
    expect(computerAuditMcpRequestId("rpc-request-1")).toEqual({ mcpRequestId: "rpc-request-1" });
    for (const invalid of [
      null,
      undefined,
      NaN,
      "/private/file",
      "token\nvalue",
      "x".repeat(129),
    ]) {
      expect(computerAuditMcpRequestId(invalid)).toEqual({});
    }
  });
});
