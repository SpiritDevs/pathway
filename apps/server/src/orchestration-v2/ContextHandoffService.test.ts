import { assert, it } from "@effect/vitest";
import {
  ContextTransferId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layer, ContextHandoffServiceV2 } from "./ContextHandoffService.ts";
import { layer as idAllocatorLayer } from "./IdAllocator.ts";

const createdAt = DateTime.makeUnsafe("2026-08-12T00:00:00.000Z");
const threadId = ThreadId.make("thread:bounded-handoff");
const targetRunId = RunId.make("run:bounded-handoff");
const providerThreadId = ProviderThreadId.make("provider-thread:bounded-handoff");

function userItem(ordinal: number, text: string): OrchestrationV2TurnItem {
  return {
    createdBy: "user",
    creationSource: "web",
    id: TurnItemId.make(`turn-item:${ordinal}`),
    threadId,
    runId: RunId.make(`run:${ordinal}`),
    nodeId: null,
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: createdAt,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "user_message",
    messageId: MessageId.make(`message:${ordinal}`),
    inputIntent: "turn_start",
    text,
    attachments: [],
  };
}

it.effect("bounds portable handoff text and retains the newest complete entries", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffServiceV2;
    const handoff = yield* service.prepareProviderHandoff({
      threadId,
      targetRunId,
      transferId: ContextTransferId.make("transfer:bounded-handoff"),
      fromProviderThreadIds: [providerThreadId],
      toProviderThreadId: providerThreadId,
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("claude"),
      coveredRunOrdinals: { from: 1, to: 3 },
      strategy: "full_thread_summary",
      items: [
        userItem(1, `oldest-${"a".repeat(180)}`),
        userItem(2, `middle-${"b".repeat(180)}`),
        userItem(3, "newest-context-must-survive"),
      ],
      maxChars: 360,
      createdAt,
    });

    assert.isAtMost(handoff.summaryText.length, 360);
    assert.include(handoff.summaryText, "Earlier context truncated");
    assert.include(handoff.summaryText, "newest-context-must-survive");
    assert.notInclude(handoff.summaryText, "oldest-");
  }).pipe(Effect.provide(layer.pipe(Layer.provide(idAllocatorLayer)))),
);

it.effect("hands short model-switch context off directly", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffServiceV2;
    const directRequest = `Keep this exact short request ${"context ".repeat(1_200)}tail-marker`;
    const handoff = yield* service.prepareProviderHandoff({
      threadId,
      targetRunId,
      transferId: ContextTransferId.make("transfer:short-model-switch"),
      fromProviderThreadIds: [providerThreadId],
      toProviderThreadId: ProviderThreadId.make("provider-thread:short-target"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("claude"),
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      items: [userItem(1, directRequest)],
      compactIfNeeded: true,
      createdAt,
    });

    assert.strictEqual(handoff.status, "ready");
    assert.strictEqual(handoff.compaction?.generation, "not_needed");
    assert.strictEqual(handoff.summaryText, `User: ${directRequest}`);
    assert.isAbove(handoff.summaryText.length, 8_000);
    assert.include(handoff.summaryText, "tail-marker");
    assert.isAtMost(handoff.summaryText.length, 16_000);
  }).pipe(Effect.provide(layer.pipe(Layer.provide(idAllocatorLayer)))),
);

it.effect("marks long model-switch context for summary generation with a bounded fallback", () =>
  Effect.gen(function* () {
    const service = yield* ContextHandoffServiceV2;
    const handoff = yield* service.prepareProviderHandoff({
      threadId,
      targetRunId,
      transferId: ContextTransferId.make("transfer:long-model-switch"),
      fromProviderThreadIds: [providerThreadId],
      toProviderThreadId: ProviderThreadId.make("provider-thread:long-target"),
      fromProviderInstanceId: ProviderInstanceId.make("codex"),
      toProviderInstanceId: ProviderInstanceId.make("claude"),
      coveredRunOrdinals: { from: 1, to: 1 },
      strategy: "full_thread_summary",
      items: [userItem(1, `Long request ${"context ".repeat(2_100)}`)],
      compactIfNeeded: true,
      createdAt,
    });

    assert.strictEqual(handoff.status, "pending");
    assert.strictEqual(handoff.compaction?.generation, "pending");
    assert.isAbove(handoff.compaction?.sourceChars ?? 0, 16_000);
    assert.isAtMost(handoff.summaryText.length, 8_000);
    assert.include(handoff.summaryText, "## Current goal and latest user intent");
  }).pipe(Effect.provide(layer.pipe(Layer.provide(idAllocatorLayer)))),
);
