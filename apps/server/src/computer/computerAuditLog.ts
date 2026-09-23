/**
 * Append-only local evidence for mutating `computer_*` calls.
 *
 * One JSON object per line beside `computer-control.json`, written at the seam
 * where the call's final effect is already known — after the tool handler has
 * the delivered effect, or after the refusal is typed. It exists for abuse
 * review: which thread drove which app, what it asked for, and what happened.
 * It is not telemetry — nothing leaves the machine — and it is deliberately
 * lossy about arguments: keys and sizes, never typed text, never clipboard
 * contents, never a payload a secret could hide in.
 *
 * Bounded two ways at once: at most {@link COMPUTER_AUDIT_MAX_ENTRIES} lines
 * and at most {@link COMPUTER_AUDIT_MAX_BYTES} bytes. Crossing either cap
 * compacts toward the newest half of both caps, written through the same
 * temp-file + rename `ComputerControlState` persists with, so a crash
 * mid-compaction leaves the old file intact rather than a truncated one.
 * Legacy files are read from a bounded tail, and a single oversized or
 * unserializable record is omitted.
 *
 * Writes are serialized on a private queue drained by one fiber — the desktop
 * operation queue cannot serialize refusals that happen before an operation
 * slot is taken, and a `computer_run`'s steps all finish inside one slot.
 * Every line is a single append, which local filesystems deliver atomically
 * for writes this size. A write failure is swallowed: evidence collection must
 * never fail the action it records, and a caller told "the click failed" when
 * the click landed is a worse failure than a gap in the log.
 *
 * @module computer/computerAuditLog
 */
import type {
  ComputerAuditEffect,
  ComputerGetAuditHistoryInput,
  ComputerGetAuditHistoryResult,
} from "@spiritdevs/contracts";
import {
  parseCuaActionDiagnostics,
  type CuaActionDiagnostics,
} from "@spiritdevs/shared/cuaActionDiagnostics";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";

import { computerAuditTailLines, readComputerAuditFileTail } from "./computerAuditFile.ts";
import {
  type ComputerAuditHistoryError,
  readComputerAuditHistory,
} from "./computerAuditHistory.ts";

/** The audit log's file name inside the environment's state directory. */
export const COMPUTER_AUDIT_LOG_FILE = "computer-audit.jsonl";
export const COMPUTER_AUDIT_MAX_ENTRIES = 10_000;
export const COMPUTER_AUDIT_MAX_BYTES = 2 * 1024 * 1024;
/** Compaction keeps the newest half so the log stays bounded without churning. */
const COMPUTER_AUDIT_COMPACT_TO = Math.floor(COMPUTER_AUDIT_MAX_ENTRIES / 2);
const COMPUTER_AUDIT_COMPACT_BYTES = Math.floor(COMPUTER_AUDIT_MAX_BYTES / 2);

export interface ComputerAuditEntry {
  /** ISO timestamp; written by the log, not the caller. */
  readonly ts: string;
  /** The tool name as the model sees it, e.g. `computer_click`. */
  readonly tool: string;
  readonly threadId?: string;
  readonly turnId?: string;
  /** MCP JSON-RPC request identity; it is not a provider tool-item ID. */
  readonly mcpRequestId?: string;
  /** The resolved target when one is known — window id, pid, app, bundle id. */
  readonly target?: {
    readonly windowId?: string;
    readonly pid?: number;
    readonly app?: string;
    readonly bundleId?: string;
  };
  /**
   * Argument summary produced by {@link summarizeComputerAuditArgs} — keys and
   * sizes only for payload-bearing fields.
   */
  readonly args?: Record<string, unknown>;
  /**
   * The first three values are the delivery taxonomy the wire result already
   * reports; `refused` covers every typed refusal (denylist, approval denied,
   * control revoked, target errors), and `error` is anything else that stopped
   * the call — always with `code` naming what refused or failed.
   */
  readonly effect: ComputerAuditEffect;
  /** The typed refusal or error code when `effect` is `refused`/`error`. */
  readonly code?: string;
  /** Native actuator metadata only; never raw driver messages or field values. */
  readonly diagnostics?: CuaActionDiagnostics;
  readonly layer?: "driver-host" | "native-driver" | "server-manager";
}

/**
 * Argument keys whose values are user payloads. Recorded as sizes only —
 * typed text, a set-value payload, a clipboard write, a launch argument list
 * and an upload's file paths are exactly the fields a secret could ride in.
 */
const COMPUTER_AUDIT_SENSITIVE_ARGS: ReadonlySet<string> = new Set([
  "text",
  "value",
  "arguments",
  "files",
  "clipboard",
  "contents",
  "data",
  "payload",
]);

/** Longest logged string field; a label or path longer than this is cut. */
const COMPUTER_AUDIT_MAX_STRING = 256;

/** Keep a bounded transport identity without inventing a provider call ID. */
export function computerAuditMcpRequestId(value: unknown): { mcpRequestId?: string } {
  const id =
    typeof value === "string"
      ? value
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : undefined;
  return id !== undefined && /^[A-Za-z0-9_.:-]{1,128}$/.test(id) ? { mcpRequestId: id } : {};
}

/**
 * Project one tool-call argument object onto what the log may keep: scalars
 * pass through for the non-sensitive keys, payload keys become a character or
 * item count, arrays become their contents' scalars, and nested target objects
 * keep one level of scalars. The result must never contain a typed string, a
 * clipboard payload, or a file path list.
 */
export function summarizeComputerAuditArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = summarizeComputerAuditValue(key, value);
  }
  return out;
}

function summarizeComputerAuditValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (COMPUTER_AUDIT_SENSITIVE_ARGS.has(key)) return { chars: value.length };
    return value.length > COMPUTER_AUDIT_MAX_STRING
      ? `${value.slice(0, COMPUTER_AUDIT_MAX_STRING)}…`
      : value;
  }
  if (Array.isArray(value)) {
    if (key === "steps") {
      // A computer_run's step list is its declaration: the count and the step
      // types are the useful record; the payloads stay out.
      return {
        count: value.length,
        types: value
          .map((step) =>
            step !== null && typeof step === "object" && !Array.isArray(step)
              ? String(Reflect.get(step, "type") ?? "unknown")
              : "unknown",
          )
          .slice(0, 64),
      };
    }
    if (COMPUTER_AUDIT_SENSITIVE_ARGS.has(key)) return { items: value.length };
    return value
      .slice(0, 64)
      .map((item) =>
        typeof item === "number" || typeof item === "boolean"
          ? item
          : typeof item === "string"
            ? item.slice(0, COMPUTER_AUDIT_MAX_STRING)
            : "[object]",
      );
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [innerKey, innerValue] of Object.entries(value as Record<string, unknown>)) {
      out[innerKey] =
        typeof innerValue === "number" || typeof innerValue === "boolean"
          ? innerValue
          : typeof innerValue === "string"
            ? COMPUTER_AUDIT_SENSITIVE_ARGS.has(innerKey)
              ? { chars: innerValue.length }
              : innerValue.slice(0, COMPUTER_AUDIT_MAX_STRING)
            : innerValue === null
              ? null
              : "[object]";
    }
    return out;
  }
  return `[${typeof value}]`;
}

export interface ComputerAuditLog {
  /** Queue one record. Never fails and never waits: the log is fire-and-forget. */
  readonly record: (entry: Omit<ComputerAuditEntry, "ts">) => Effect.Effect<void>;
  /** Completes once every record queued before it — and any compaction — has been written. */
  readonly flush: Effect.Effect<void>;
  /** Reads the activity history after queued evidence lands. */
  readonly readHistory: (
    input: ComputerGetAuditHistoryInput,
  ) => Effect.Effect<ComputerGetAuditHistoryResult, ComputerAuditHistoryError>;
}

type AuditWork =
  | { readonly _tag: "append"; readonly line: string }
  | { readonly _tag: "flush"; readonly done: Deferred.Deferred<void> };

/**
 * Opens the audit log at `filePath`; `undefined` turns auditing off and
 * history reads report `disabled`. The writer fiber lives in the caller's
 * scope, and closing the scope first writes everything already queued.
 */
export const makeComputerAuditLog = Effect.fn("makeComputerAuditLog")(function* (
  filePath: string | undefined,
): Effect.fn.Return<ComputerAuditLog, never, FileSystem.FileSystem | Path.Path | Scope.Scope> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const work = yield* Queue.unbounded<AuditWork>();
  /**
   * Estimated size/count of the file as this process sees it, loaded on the
   * first append so a pre-existing log counts toward the caps rather than
   * being measured only from this boot's writes.
   */
  let entries = 0;
  let bytes = 0;
  let loaded = false;
  let needsSeparator = false;

  const compact = Effect.fn("ComputerAuditLog.compact")(function* (file: string) {
    const existing = yield* readComputerAuditFileTail(file, COMPUTER_AUDIT_MAX_BYTES);
    if (existing === null) return;
    const kept: Buffer[] = [];
    let keptBytes = 0;
    let scannedRows = 0;
    for (const { line } of computerAuditTailLines(existing)) {
      if (scannedRows >= COMPUTER_AUDIT_MAX_ENTRIES) break;
      scannedRows += 1;
      if (line.length <= 1) continue;
      if (
        kept.length >= COMPUTER_AUDIT_COMPACT_TO ||
        (kept.length > 0 && keptBytes + line.length > COMPUTER_AUDIT_COMPACT_BYTES)
      ) {
        break;
      }
      kept.push(line);
      keptBytes += line.length;
    }
    const content = Buffer.concat(kept.toReversed(), keptBytes);
    const temporaryPath = `${file}.tmp`;
    yield* fs.writeFile(temporaryPath, content, { mode: 0o600 });
    yield* fs.rename(temporaryPath, file);
    entries = kept.length;
    bytes = content.length;
  });

  const append = Effect.fn("ComputerAuditLog.append")(function* (file: string, line: string) {
    if (!loaded) {
      const existing = yield* readComputerAuditFileTail(file, COMPUTER_AUDIT_MAX_BYTES);
      if (existing !== null) {
        bytes = existing.totalBytes;
        needsSeparator = existing.contents.length > 0 && existing.contents.at(-1) !== 10;
        entries = needsSeparator ? 1 : 0;
        const lines = computerAuditTailLines(existing);
        while (entries <= COMPUTER_AUDIT_MAX_ENTRIES && !lines.next().done) entries += 1;
      }
      loaded = true;
    }
    yield* fs.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
    const content = needsSeparator ? `\n${line}` : line;
    yield* fs.writeFileString(file, content, { flag: "a", mode: 0o600 });
    needsSeparator = false;
    entries += 1;
    bytes += Buffer.byteLength(content, "utf8");
    if (entries > COMPUTER_AUDIT_MAX_ENTRIES || bytes > COMPUTER_AUDIT_MAX_BYTES) {
      yield* compact(file);
    }
  });

  const handle = (item: AuditWork): Effect.Effect<void> => {
    if (item._tag === "flush") return Deferred.succeed(item.done, undefined).pipe(Effect.asVoid);
    if (filePath === undefined) return Effect.void;
    // Evidence collection must never fail the action it records, and one bad
    // write must not stop the writer.
    return append(filePath, item.line).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.exit,
      Effect.asVoid,
    );
  };

  yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(work), handle)));

  const flush: Effect.Effect<void> = Effect.suspend(() => {
    const done = Deferred.makeUnsafe<void>();
    return Queue.offerUnsafe(work, { _tag: "flush", done }) ? Deferred.await(done) : Effect.void;
  });
  yield* Effect.addFinalizer(() => flush);

  const record = (entry: Omit<ComputerAuditEntry, "ts">): Effect.Effect<void> =>
    filePath === undefined
      ? Effect.void
      : Effect.flatMap(DateTime.now, (now) =>
          Effect.sync(() => {
            try {
              // Re-project at the persistence boundary, even if a caller supplied
              // an object carrying extra native fields despite its static type.
              const { diagnostics: suppliedDiagnostics, ...metadata } = entry;
              const diagnostics = parseCuaActionDiagnostics({ diagnostics: suppliedDiagnostics });
              // Evidence is caller-shaped JSON; an unserializable entry is dropped below.
              // @effect-diagnostics-next-line preferSchemaOverJson:off
              const line = `${JSON.stringify({
                ts: DateTime.formatIso(now),
                ...metadata,
                ...(diagnostics ? { diagnostics } : {}),
              })}\n`;
              if (Buffer.byteLength(line, "utf8") > COMPUTER_AUDIT_MAX_BYTES) return;
              Queue.offerUnsafe(work, { _tag: "append", line });
            } catch {
              // A malformed evidence object must not make a delivered action fail.
            }
          }),
        );

  const readHistory = (input: ComputerGetAuditHistoryInput) =>
    flush.pipe(
      Effect.andThen(readComputerAuditHistory(filePath, input)),
      Effect.provideService(FileSystem.FileSystem, fs),
    );

  return { record, flush, readHistory } satisfies ComputerAuditLog;
});
