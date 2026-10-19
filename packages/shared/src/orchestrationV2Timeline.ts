import type {
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
} from "@spiritdevs/contracts";

type TimelineRun = Pick<OrchestrationV2Run, "id" | "status">;
type TimelineRunAttempt = Pick<OrchestrationV2RunAttempt, "runId" | "rootNodeId" | "status">;
type TimelineTurnItem = Pick<OrchestrationV2TurnItem, "type" | "runId" | "nodeId"> & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function buildOrchestrationErrorFixPrompt(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "error" }>,
): string {
  return `Please investigate and fix this error.\n\nError context:\n${JSON.stringify(item, null, 2)}`;
}

export function isOrchestrationV2SupersededInterrupt(input: {
  readonly item: TimelineTurnItem;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (item.type !== "run_interrupt_result" || item.runId === null || item.nodeId === null) {
    return false;
  }

  const isSuperseded = input.attempts.some(
    (attempt) =>
      attempt.runId === item.runId &&
      attempt.rootNodeId === item.nodeId &&
      attempt.status === "superseded",
  );
  if (!isSuperseded) {
    return false;
  }

  // Paired stop-then-steer results have a matching request on the same run and
  // must stay visible. Legacy plain-steer results have no request and stay hidden.
  const hasMatchingRequest = input.items.some(
    (candidate) => candidate.type === "run_interrupt_request" && candidate.runId === item.runId,
  );
  return !hasMatchingRequest;
}

export function isOrchestrationV2TurnItemVisible(input: {
  readonly item: TimelineTurnItem;
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): boolean {
  const { item } = input;
  if (
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "rolled_back")
  ) {
    return false;
  }

  // A queued message is composer state, not conversation history. When its run
  // is cancelled the input never reached the provider, so it must not surface
  // as a transcript row.
  if (
    item.type === "user_message" &&
    item.inputIntent === "queued_turn" &&
    item.runId !== null &&
    input.runs.some((run) => run.id === item.runId && run.status === "cancelled")
  ) {
    return false;
  }

  return !isOrchestrationV2SupersededInterrupt({
    item,
    attempts: input.attempts,
    items: input.items,
  });
}

/**
 * Prepares {@link isOrchestrationV2TurnItemVisible} for checking many items of
 * one thread. Only rolled-back or cancelled runs and superseded attempts can
 * hide an item, so each check runs against those small subsets instead of
 * scanning every run per item.
 */
export function orchestrationV2TurnItemVisibility(input: {
  readonly runs: ReadonlyArray<TimelineRun>;
  readonly attempts: ReadonlyArray<TimelineRunAttempt>;
  readonly items: ReadonlyArray<TimelineTurnItem>;
}): (item: TimelineTurnItem) => boolean {
  const runs = input.runs.filter(
    (run) => run.status === "rolled_back" || run.status === "cancelled",
  );
  const attempts = input.attempts.filter((attempt) => attempt.status === "superseded");
  const hidingRunIds = new Set<string>([
    ...runs.map((run) => run.id),
    ...attempts.map((attempt) => attempt.runId),
  ]);
  if (hidingRunIds.size === 0) return () => true;
  const items =
    attempts.length === 0 ? [] : input.items.filter((item) => item.type === "run_interrupt_request");
  return (item) =>
    item.runId === null ||
    !hidingRunIds.has(item.runId) ||
    isOrchestrationV2TurnItemVisible({ item, runs, attempts, items });
}
