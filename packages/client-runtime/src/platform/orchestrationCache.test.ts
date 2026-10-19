import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ORCHESTRATION_CACHE_SCHEMA_VERSION,
  StoredOrchestrationShellSnapshot,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "./orchestrationCache.ts";
import {
  v2Now,
  v2Projection,
  v2ShellSnapshot,
  v2ThreadShell,
  v2ThreadId,
} from "../state/orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("environment-cache-test");
const StoredShellSnapshotJson = Schema.fromJsonString(StoredOrchestrationShellSnapshot);
const StoredThreadSnapshotJson = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
const encodeStoredShellSnapshot = Schema.encodeSync(StoredOrchestrationShellSnapshot);
const decodeStoredShellSnapshotSync = Schema.decodeUnknownSync(StoredOrchestrationShellSnapshot);
const encodeStoredShellSnapshotJson = Schema.encodeSync(StoredShellSnapshotJson);
const decodeStoredShellSnapshotJson = Schema.decodeUnknownSync(StoredShellSnapshotJson);
const encodeStoredThreadSnapshotJson = Schema.encodeSync(StoredThreadSnapshotJson);
const decodeStoredThreadSnapshotJson = Schema.decodeUnknownSync(StoredThreadSnapshotJson);

const turnItem = (id: string, threadId = v2ThreadId): OrchestrationV2TurnItem => ({
  id: TurnItemId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  type: "command_execution",
  status: "completed",
  title: null,
  input: "example",
  output: `${id} output`,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
});

const inherited = turnItem("inherited", ThreadId.make("thread-source"));
const synthetic = turnItem("synthetic");
const local = [turnItem("local-1"), turnItem("local-2")];
const projectionWithRows: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  turnItems: local,
  visibleTurnItems: [inherited, synthetic, ...local].map((item, position) => ({
    position,
    visibility: position === 0 ? "inherited" : position === 1 ? "synthetic" : "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  })),
};
const encodeThread = (projection: OrchestrationV2ThreadProjection) =>
  encodeStoredThreadSnapshotJson({
    schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
    environmentId,
    threadId: v2ThreadId,
    snapshot: {
      snapshotSequence: 7,
      projection,
      history: { hasOlder: true, hasNewer: false, beforeCursor: local[0]!.id, index: [] },
    },
  });

class TestCacheDecodeError extends Schema.TaggedErrorClass<TestCacheDecodeError>()(
  "TestCacheDecodeError",
  {
    message: Schema.String,
  },
) {}

const shellSnapshotWithSummaries: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  threads: [
    {
      ...v2ThreadShell,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("runtime-request-v2"),
        kind: "command",
        createdAt: v2Now,
      },
      latestVisibleMessage: {
        id: MessageId.make("message-v2"),
        role: "assistant",
        text: "Done",
        updatedAt: v2Now,
      },
      latestUserMessageAt: v2Now,
      settledAt: v2Now,
      titleRegeneration: { requestId: CommandId.make("command-title"), startedAt: v2Now },
    },
  ],
};

describe("orchestration cache envelopes", () => {
  it.effect("round-trips V2 shell and thread cache envelopes as JSON", () =>
    Effect.sync(() => {
      const encodedShell = encodeStoredShellSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: shellSnapshotWithSummaries,
      });
      const shell = decodeStoredShellSnapshotJson(encodedShell);
      const encodedThread = encodeStoredThreadSnapshotJson({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId: v2ThreadId,
        snapshot: {
          snapshotSequence: 4,
          projection: v2Projection,
          history: {
            hasOlder: true,
            hasNewer: false,
            beforeCursor: TurnItemId.make("cursor-4"),
            afterCursor: TurnItemId.make("cursor-9"),
            index: [
              {
                messageId: MessageId.make("message-1"),
                role: "user",
                preview: "First question",
                assistantPreview: "Reply",
              },
            ],
          },
        },
      });
      const thread = decodeStoredThreadSnapshotJson(encodedThread);
      const [threadShell] = shell.snapshot.threads;

      expect(threadShell?.latestVisibleMessage?.text).toBe("Done");
      expect(
        threadShell?.latestVisibleMessage === null ||
          threadShell?.latestVisibleMessage === undefined
          ? null
          : DateTime.formatIso(threadShell.latestVisibleMessage.updatedAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(
        threadShell?.latestUserMessageAt === null || threadShell?.latestUserMessageAt === undefined
          ? null
          : DateTime.formatIso(threadShell.latestUserMessageAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(
        threadShell?.settledAt === null || threadShell?.settledAt === undefined
          ? null
          : DateTime.formatIso(threadShell.settledAt),
      ).toBe("2026-06-20T00:00:00.000Z");
      expect(threadShell?.titleRegeneration).toEqual({
        requestId: "command-title",
        startedAt: v2Now,
      });
      expect(DateTime.formatIso(thread.snapshot.projection.thread.updatedAt)).toBe(
        "2026-06-20T00:00:00.000Z",
      );
      expect(thread.snapshot.projection).toEqual(v2Projection);
      expect(thread.snapshot.snapshotSequence).toBe(4);
      expect(thread.snapshot.history).toEqual({
        hasOlder: true,
        hasNewer: false,
        beforeCursor: "cursor-4",
        afterCursor: "cursor-9",
        index: [
          {
            messageId: "message-1",
            role: "user",
            preview: "First question",
            assistantPreview: "Reply",
          },
        ],
      });
      expect(() =>
        decodeStoredThreadSnapshotJson(
          encodedThread.replace('"schemaVersion":5', '"schemaVersion":4'),
        ),
      ).toThrow();
    }),
  );

  it.effect("discards V1-versioned cache envelopes after a decode failure", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const encodedShell = encodeStoredShellSnapshot({
        schemaVersion: ORCHESTRATION_CACHE_SCHEMA_VERSION,
        environmentId,
        snapshot: v2ShellSnapshot,
      });
      const decoded = Effect.try({
        try: () => decodeStoredShellSnapshotSync({ ...encodedShell, schemaVersion: 1 }),
        catch: (cause) => new TestCacheDecodeError({ message: String(cause) }),
      }).pipe(Effect.map(Option.some));

      const result = yield* decodeOrDiscardOrchestrationCache(
        decoded,
        Effect.sync(() => {
          discardCount += 1;
        }),
      );

      expect(Option.isNone(result)).toBe(true);
      expect(discardCount).toBe(1);
    }),
  );

  it("stores each thread item body once and restores shared item identity", () => {
    const encoded = encodeThread(projectionWithRows);
    const stored = JSON.parse(encoded).snapshot.projection;
    expect(
      stored.visibleTurnItems.every((row: object) => !("item" in row)),
      "visible rows store references only",
    ).toBe(true);
    expect(stored.turnItems.map((item: { id: string }) => item.id)).toEqual(["local-1", "local-2"]);
    expect(stored.referencedTurnItems.map((item: { id: string }) => item.id)).toEqual([
      "inherited",
      "synthetic",
    ]);

    const decoded = decodeStoredThreadSnapshotJson(encoded).snapshot;
    const { projection } = decoded;
    expect(projection).toEqual(projectionWithRows);
    expect(projection).not.toHaveProperty("payloadFormat");
    expect(projection).not.toHaveProperty("referencedTurnItems");
    expect(projection.visibleTurnItems[2]!.item).toBe(projection.turnItems[0]);
    expect(projection.visibleTurnItems[3]!.item).toBe(projection.turnItems[1]);
    expect(projection.turnItems).not.toContainEqual(inherited);
    expect(projection.turnItems).not.toContainEqual(synthetic);
    expect(decoded.snapshotSequence).toBe(7);
    expect(decoded.history).toEqual({
      hasOlder: true,
      hasNewer: false,
      beforeCursor: "local-1",
      index: [],
    });
  });

  it("rejects a cached visible row whose item reference is missing", () => {
    const encoded = encodeThread(projectionWithRows).replace(
      '"sourceItemId":"local-2"',
      '"sourceItemId":"missing"',
    );
    expect(() => decodeStoredThreadSnapshotJson(encoded)).toThrow(
      "Missing visible turn item missing",
    );
  });

  it.effect("discards thread caches written by the previous duplicated-item format", () =>
    Effect.gen(function* () {
      let discardCount = 0;
      const previous = encodeThread(projectionWithRows).replace(
        '"schemaVersion":5',
        '"schemaVersion":4',
      );
      const result = yield* decodeOrDiscardOrchestrationCache(
        Effect.try({
          try: () => Option.some(decodeStoredThreadSnapshotJson(previous)),
          catch: (cause) => new TestCacheDecodeError({ message: String(cause) }),
        }),
        Effect.sync(() => {
          discardCount += 1;
        }),
      );
      expect(Option.isNone(result)).toBe(true);
      expect(discardCount).toBe(1);
    }),
  );
});
