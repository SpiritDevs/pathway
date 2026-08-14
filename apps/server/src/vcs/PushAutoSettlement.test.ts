import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import { runPushAutoSettlementCountdown } from "./PushAutoSettlement.ts";

const threadId = ThreadId.make("thread-pushed");
const commandId = CommandId.make("push:auto-settle");
const at = (iso: string) => DateTime.makeUnsafe(iso);

function thread() {
  return {
    activeRunId: null,
    activityRunStatus: null,
    archivedAt: null,
    deletedAt: null,
    hasActionableProposedPlan: false,
    itemCount: 4,
    latestRunCompletedAt: at("2026-08-14T00:00:02.000Z"),
    latestRunId: RunId.make("run-1"),
    latestRunRequestedAt: at("2026-08-14T00:00:00.000Z"),
    latestRunStartedAt: at("2026-08-14T00:00:01.000Z"),
    latestUserMessageAt: at("2026-08-14T00:00:00.000Z"),
    latestVisibleMessage: null,
    pendingRuntimeRequest: null,
    pinnedAt: null,
    settledOverride: null,
    snoozedUntil: null,
    status: "completed" as const,
    visibleItemCount: 4,
  };
}

it.effect("settles after ten quiet seconds", () =>
  Effect.gen(function* () {
    const state = yield* Ref.make(thread());
    const settled = yield* Ref.make<Array<{ threadId: ThreadId; commandId: CommandId }>>([]);
    const fiber = yield* runPushAutoSettlementCountdown(
      {
        readThread: () => Ref.get(state),
        settleThread: (input) => Ref.update(settled, (commands) => [...commands, input]),
      },
      { threadId, commandId },
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Effect.yieldNow;
    yield* TestClock.adjust("10 seconds");

    assert.isTrue(yield* Fiber.join(fiber));
    assert.deepEqual(yield* Ref.get(settled), [{ threadId, commandId }]);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not settle after new thread activity", () =>
  Effect.gen(function* () {
    const initial = thread();
    const state = yield* Ref.make(initial);
    const settled = yield* Ref.make(0);
    const fiber = yield* runPushAutoSettlementCountdown(
      {
        readThread: () => Ref.get(state),
        settleThread: () => Ref.update(settled, (count) => count + 1),
      },
      { threadId, commandId },
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Effect.yieldNow;
    yield* Ref.set(state, {
      ...initial,
      itemCount: initial.itemCount + 1,
      latestUserMessageAt: at("2026-08-14T00:00:08.000Z"),
    });
    yield* TestClock.adjust("10 seconds");

    assert.isFalse(yield* Fiber.join(fiber));
    assert.equal(yield* Ref.get(settled), 0);
  }).pipe(Effect.provide(TestClock.layer())),
);
