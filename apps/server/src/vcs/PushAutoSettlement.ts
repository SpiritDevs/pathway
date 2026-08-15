import {
  canStartPushAutoSettlement,
  type CommandId,
  PUSH_AUTO_SETTLE_DELAY_MS,
  pushAutoSettlementActivityKey,
  pushAutoSettlementStillEligible,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

type PushSettlementThread = Parameters<typeof pushAutoSettlementActivityKey>[0];

export interface PushAutoSettlementOperations {
  readonly readThread: (threadId: ThreadId) => Effect.Effect<PushSettlementThread | null, never>;
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
  }) => Effect.Effect<unknown, never>;
}

export const runPushAutoSettlementCountdown = Effect.fn("PushAutoSettlement.countdown")(function* (
  operations: PushAutoSettlementOperations,
  input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly delay?: Duration.Input;
  },
) {
  const initialThread = yield* operations.readThread(input.threadId);
  if (initialThread === null || !canStartPushAutoSettlement(initialThread)) {
    return false;
  }
  const activityKey = pushAutoSettlementActivityKey(initialThread);

  yield* Effect.sleep(input.delay ?? Duration.millis(PUSH_AUTO_SETTLE_DELAY_MS));

  const currentThread = yield* operations.readThread(input.threadId);
  if (currentThread === null || !pushAutoSettlementStillEligible(activityKey, currentThread)) {
    return false;
  }

  yield* operations.settleThread({
    threadId: input.threadId,
    commandId: input.commandId,
  });
  return true;
});
