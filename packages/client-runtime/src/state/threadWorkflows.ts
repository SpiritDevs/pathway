import type {
  ChatAttachment,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@spiritdevs/contracts";
import { copySorted } from "@spiritdevs/shared/Array";

type Projection = OrchestrationV2ThreadProjection;
type Run = Projection["runs"][number];
type ProviderSession = Projection["providerSessions"][number];

const ACTIVE_RUN_STATUSES = new Set<Run["status"]>(["preparing", "starting", "running", "waiting"]);
const MERGE_BACK_RUN_STATUSES = new Set<Run["status"]>(["waiting", "completed"]);
const MERGE_BACK_BLOCKING_RUN_STATUSES = new Set<Run["status"]>([
  "preparing",
  "starting",
  "running",
]);

export interface QueuedThreadRun {
  readonly run: Run;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  /**
   * Who authored the queued message. Provider continuation wakes (for example
   * "Background command completed") are dispatched with `createdBy: "agent"`;
   * surfaces must attribute those rows instead of presenting them as user text.
   */
  readonly createdBy: Projection["messages"][number]["createdBy"];
}

export interface ThreadQueueWorkflowState {
  readonly activeRun: Run | null;
  readonly queuedRuns: ReadonlyArray<QueuedThreadRun>;
  readonly canReorder: boolean;
  readonly canPromoteToSteer: boolean;
}

export function resolveActiveThreadRun(projection: Projection): Run | null {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status)) ?? null;
}

/**
 * A successfully finished provider turn remains in `waiting` while its
 * checkpoint is captured. Keep that newest turn available for merge-back
 * instead of falling through to an older fully checkpointed run.
 */
export function resolveLatestMergeBackRun(projection: Projection): Run | null {
  const latestProviderFinishedRun = projection.runs.reduce<Run | null>(
    (latest, run) =>
      MERGE_BACK_RUN_STATUSES.has(run.status) && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
  if (latestProviderFinishedRun === null) return null;

  const hasNewerActiveRun = projection.runs.some(
    (run) =>
      run.ordinal > latestProviderFinishedRun.ordinal &&
      MERGE_BACK_BLOCKING_RUN_STATUSES.has(run.status),
  );
  return hasNewerActiveRun ? null : latestProviderFinishedRun;
}

/**
 * Returns the newest stable point that can seed an isolated side chat.
 * Active and queued work stays in the parent while the fork inherits the
 * conversation through the latest completed run.
 */
export function resolveLatestForkableRun(projection: Projection): Run | null {
  return projection.runs.reduce<Run | null>(
    (latest, run) =>
      run.status === "completed" && (latest === null || run.ordinal > latest.ordinal)
        ? run
        : latest,
    null,
  );
}

export function resolveThreadProviderSession(projection: Projection): ProviderSession | null {
  const activeRun = resolveActiveThreadRun(projection);
  const providerThreadId = activeRun?.providerThreadId ?? projection.thread.activeProviderThreadId;
  const activeProviderThread =
    providerThreadId === null
      ? null
      : (projection.providerThreads.find((thread) => thread.id === providerThreadId) ?? null);
  const attachedProviderThread =
    activeProviderThread ??
    projection.providerThreads.find(
      (thread) => thread.appThreadId === projection.thread.id && thread.providerSessionId !== null,
    ) ??
    null;
  const sessionId = attachedProviderThread?.providerSessionId ?? null;
  if (sessionId !== null) {
    return projection.providerSessions.find((session) => session.id === sessionId) ?? null;
  }
  return (
    projection.providerSessions.findLast(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? null
  );
}

export function deriveThreadQueueWorkflowState(projection: Projection): ThreadQueueWorkflowState {
  const activeRun = resolveActiveThreadRun(projection);
  const session = resolveThreadProviderSession(projection);
  const capabilities = session?.capabilities.turns;
  const hasSteerableProviderTurn =
    activeRun?.status === "running" &&
    activeRun.activeAttemptId !== null &&
    projection.providerTurns.some(
      (turn) => turn.runAttemptId === activeRun.activeAttemptId && turn.status === "running",
    );
  const automaticCompletionMessageIds = new Set(
    projection.messages
      .filter((message) => message.delegatedCompletion !== undefined)
      .map((message) => message.id),
  );
  const queuedRuns = copySorted(
    projection.runs.filter(
      (run) => run.status === "queued" && !automaticCompletionMessageIds.has(run.userMessageId),
    ),
    (left, right) =>
      (left.queuePosition ?? left.ordinal) - (right.queuePosition ?? right.ordinal) ||
      left.ordinal - right.ordinal,
  ).map((run) => {
    const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
    return {
      run,
      text: message?.text ?? "Queued message",
      attachments: message?.attachments ?? [],
      createdBy: message?.createdBy ?? "user",
    };
  });

  return {
    activeRun,
    queuedRuns,
    canReorder: capabilities?.supportsQueuedMessages === true,
    canPromoteToSteer:
      hasSteerableProviderTurn &&
      (capabilities?.supportsActiveSteering === true ||
        capabilities?.supportsSteeringByInterruptRestart === true),
  };
}

export interface QueuedRunReorder {
  readonly runId: RunId;
  /** The run the moved run should sit in front of; `null` places it at the bottom. */
  readonly beforeRunId: RunId | null;
  /** The queue order the move produces, for optimistic display until the projection catches up. */
  readonly order: ReadonlyArray<RunId>;
}

/**
 * Translates a finished sort — the run being moved and the run it was dropped
 * onto — into the `queued-run.reorder` contract. Returns `null` when the drop
 * changes nothing, which is how a no-op drag avoids sending a command.
 */
export function resolveQueuedRunReorder(input: {
  /** The queue as displayed, top first. */
  readonly orderedRunIds: ReadonlyArray<RunId>;
  readonly activeRunId: RunId;
  readonly overRunId: RunId;
}): QueuedRunReorder | null {
  const from = input.orderedRunIds.indexOf(input.activeRunId);
  const to = input.orderedRunIds.indexOf(input.overRunId);
  if (from === -1 || to === -1 || from === to) return null;
  const order = [...input.orderedRunIds];
  order.splice(from, 1);
  order.splice(to, 0, input.activeRunId);
  return { runId: input.activeRunId, beforeRunId: order[to + 1] ?? null, order };
}

/**
 * Applies an optimistic order to the projected queue. An order that no longer
 * describes the same set of runs is ignored rather than patched, so a queue
 * that changed underneath a drag renders the server's truth.
 */
export function orderQueuedRuns(
  queued: ReadonlyArray<QueuedThreadRun>,
  order: ReadonlyArray<RunId> | null,
): ReadonlyArray<QueuedThreadRun> {
  if (order === null || order.length !== queued.length) return queued;
  const byRunId = new Map(queued.map((entry) => [entry.run.id, entry]));
  const ordered: Array<QueuedThreadRun> = [];
  for (const runId of order) {
    const entry = byRunId.get(runId);
    if (entry === undefined) return queued;
    ordered.push(entry);
  }
  return ordered;
}

/**
 * Whether an optimistic order should be dropped in favour of the projection.
 *
 * The optimistic order only outlives the drag while the projection still shows
 * what it showed when the drag ended (`baselineRunIds`). Once the projection
 * moves — to the dragged order, to a different order because another device
 * reordered first, or to a different set of runs because one started, was
 * cancelled, or arrived — the server is the authority and the local order goes.
 */
export function isQueuedRunOrderStale(input: {
  readonly serverRunIds: ReadonlyArray<RunId>;
  readonly order: ReadonlyArray<RunId>;
  /** The projected order at the moment the drag was committed. */
  readonly baselineRunIds: ReadonlyArray<RunId>;
}): boolean {
  const serverMatches = (other: ReadonlyArray<RunId>) =>
    input.serverRunIds.length === other.length &&
    input.serverRunIds.every((runId, index) => other[index] === runId);

  if (input.serverRunIds.length !== input.order.length) return true;
  const ordered = new Set(input.order);
  if (input.serverRunIds.some((runId) => !ordered.has(runId))) return true;
  return serverMatches(input.order) || !serverMatches(input.baselineRunIds);
}

export function canForkProjectedAssistantItem(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities?: OrchestrationV2ProviderCapabilities | undefined;
}): boolean {
  const item = input.projectedItem.item;
  if (item.type !== "assistant_message" || item.runId === null || item.status !== "completed") {
    return false;
  }
  if (input.capabilities === undefined) {
    // Historical and inherited rows may outlive their provider-session record.
    // Keep the portable server-side fallback available when capability evidence
    // is absent; a known incapable provider is rejected below.
    return true;
  }
  const capabilities = input.capabilities;
  const canForkNatively =
    capabilities.threads.canForkThread &&
    capabilities.threads.canForkFromTurn &&
    capabilities.identity.nativeThreadIds === "strong";
  return canForkNatively || capabilities.context.supportsFullThreadHandoff;
}

export function canDetachThreadProviderSession(projection: Projection): boolean {
  const session = resolveThreadProviderSession(projection);
  return session !== null && session.status !== "stopped" && session.status !== "error";
}
