import type {
  MessageId,
  NodeId,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadHistory,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadHistoryRequest,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** A large reconnect replaces replay with a recent snapshot; global sequence gaps are not a count. */
export const threadHistoryNeedsSnapshot = Effect.fn("threadHistoryNeedsSnapshot")(function* (
  threadId: ThreadId,
  afterSequence: number,
  throughSequence: number,
) {
  if (afterSequence > throughSequence) return true;
  const sql = yield* SqlClient.SqlClient;
  // Unary `+` keeps SQLite on the (aggregate_kind, stream_id, sequence) index.
  const backlog = yield* sql<{ sequence: number }>`
    SELECT sequence FROM orchestration_events
    WHERE +application_event_version = 2 AND aggregate_kind = 'thread'
      AND stream_id = ${threadId}
      AND sequence > ${afterSequence} AND sequence <= ${throughSequence}
    ORDER BY sequence LIMIT 251
  `;
  return backlog.length > 250;
});

/**
 * Whether a resume can target the thread: the same rows `getThreadShell` treats
 * as present, without assembling the shell (tens of ms on long threads).
 */
export const threadProjectionExists = Effect.fn("threadProjectionExists")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly present: number }>`
    SELECT 1 AS present FROM orchestration_v2_projection_threads
    WHERE thread_id = ${threadId} AND deleted_at IS NULL
    LIMIT 1
  `;
  return rows.length > 0;
});

/** Small projection columns used to choose a page before reading message/tool bodies. */
export interface ThreadHistoryItem {
  readonly id: TurnItemId;
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2TurnItem["runId"];
  readonly nodeId: OrchestrationV2TurnItem["nodeId"];
  readonly type: OrchestrationV2TurnItem["type"];
  readonly status: OrchestrationV2TurnItem["status"];
  readonly ordinal: number;
  readonly inputIntent?: Extract<OrchestrationV2TurnItem, { type: "user_message" }>["inputIntent"];
  readonly messageId?: MessageId;
  readonly preview?: string;
}

export function selectThreadHistory(
  items: ReadonlyArray<ThreadHistoryItem>,
  request: OrchestrationV2ThreadHistoryRequest,
): {
  readonly start: number;
  readonly items: ReadonlyArray<ThreadHistoryItem>;
  readonly history: OrchestrationV2ThreadHistory;
} {
  let start = Math.max(0, items.length - request.limit);
  let end = items.length;
  if (request.before !== undefined) {
    const position = items.findIndex((item) => item.id === request.before);
    if (position === -1) throw new RangeError("The older-history cursor is no longer available.");
    if (position !== -1) {
      end = position;
      start = Math.max(0, end - request.limit);
    }
  } else if (request.after !== undefined) {
    const position = items.findIndex((item) => item.id === request.after);
    if (position === -1) throw new RangeError("The newer-history cursor is no longer available.");
    if (position !== -1) {
      start = position + 1;
      end = Math.min(items.length, start + request.limit);
    }
  } else if (request.around !== undefined) {
    const position = items.findIndex((item) => item.messageId === request.around);
    if (position === -1)
      throw new RangeError("The requested history message is no longer available.");
    if (position !== -1) {
      start = Math.max(
        0,
        Math.min(position - Math.floor(request.limit / 2), items.length - request.limit),
      );
      end = Math.min(items.length, start + request.limit);
    }
  }
  const page = items.slice(start, end);
  const index: Array<OrchestrationV2ThreadHistory["index"][number]> = [];
  for (const item of items) {
    if (item.type === "user_message" && item.messageId !== undefined) {
      index.push({ messageId: item.messageId, role: "user", preview: item.preview ?? "" });
    } else if (item.type === "assistant_message" && index.length > 0) {
      const previous = index[index.length - 1]!;
      index[index.length - 1] = { ...previous, assistantPreview: item.preview ?? "" };
    }
  }
  const first = page[0];
  const last = page.at(-1);
  return {
    start,
    items: page,
    history: {
      hasOlder: start > 0,
      hasNewer: end < items.length,
      ...(first === undefined ? {} : { beforeCursor: first.id }),
      ...(last === undefined ? {} : { afterCursor: last.id }),
      index,
    },
  };
}

/** Settled run and node statuses; provider turns cannot be rolled back. */
const SETTLED_STATUSES = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const SETTLED_TURN_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/** Linking columns of a node, enough to choose it for a page without its payload. */
export type HistorySupportNode = Pick<
  OrchestrationV2ExecutionNode,
  "id" | "parentNodeId" | "rootNodeId" | "status" | "providerTurnId"
>;
/** Linking columns of a provider turn, enough to choose it for a page without its payload. */
export type HistorySupportProviderTurn = Pick<
  OrchestrationV2ProviderTurn,
  "id" | "nodeId" | "runAttemptId" | "status"
>;

/**
 * Chooses the nodes, attempts and provider turns a history page needs: those
 * its items reference, the thread's live or latest work, subagents, plans and
 * requests, plus every parent and root of the chosen nodes. `nodes` and
 * `providerTurns` need only their linking columns, so the store can choose
 * before it reads or decodes any payload.
 */
export function selectHistoryPageSupport(
  input: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "messages" | "subagents" | "plans" | "runtimeRequests"
  > & {
    readonly threadId: ThreadId;
    readonly items: ReadonlyArray<
      Pick<OrchestrationV2TurnItem, "threadId" | "runId" | "nodeId" | "providerTurnId">
    >;
    readonly nodes: ReadonlyArray<HistorySupportNode>;
    readonly providerTurns: ReadonlyArray<HistorySupportProviderTurn>;
  },
): {
  readonly attempts: OrchestrationV2ThreadProjection["attempts"];
  readonly nodeIds: ReadonlySet<NodeId>;
  readonly providerTurnIds: ReadonlySet<string>;
} {
  const latestRun = input.runs.reduce<(typeof input.runs)[number] | undefined>(
    (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
    undefined,
  );
  const runIds = new Set<RunId>();
  const nodeIds = new Set<NodeId>();
  const providerTurnIds = new Set<string>();
  const addRun = (runId: RunId | null) => runId !== null && runIds.add(runId);
  const addNode = (nodeId: NodeId | null) => nodeId !== null && nodeIds.add(nodeId);
  if (latestRun !== undefined) addRun(latestRun.id);
  for (const run of input.runs) {
    if (!SETTLED_STATUSES.has(run.status)) addRun(run.id);
  }
  for (const item of input.items) {
    if (item.threadId !== input.threadId) continue;
    addRun(item.runId);
    addNode(item.nodeId);
    if (item.providerTurnId !== null) providerTurnIds.add(item.providerTurnId);
  }
  for (const message of input.messages) addRun(message.runId);
  for (const run of input.runs) if (runIds.has(run.id)) addNode(run.rootNodeId);
  const attempts = input.attempts.filter((attempt) => runIds.has(attempt.runId));
  for (const attempt of attempts) {
    addNode(attempt.rootNodeId);
    if (attempt.providerTurnId !== null) providerTurnIds.add(attempt.providerTurnId);
  }
  for (const subagent of input.subagents) {
    addNode(subagent.id);
    addNode(subagent.parentNodeId);
  }
  for (const entry of [...input.plans, ...input.runtimeRequests]) addNode(entry.nodeId);
  for (const node of input.nodes) {
    if (!SETTLED_STATUSES.has(node.status)) addNode(node.id);
  }
  const nodeById = new Map(input.nodes.map((node) => [node.id, node] as const));
  // Set iteration visits ids added during the loop, closing over every ancestor.
  for (const nodeId of nodeIds) {
    const node = nodeById.get(nodeId);
    if (node === undefined) continue;
    addNode(node.parentNodeId);
    addNode(node.rootNodeId);
  }
  for (const node of input.nodes) {
    if (nodeIds.has(node.id) && node.providerTurnId !== null) {
      providerTurnIds.add(node.providerTurnId);
    }
  }
  const attemptIds = new Set<string>(attempts.map((attempt) => attempt.id));
  const turnIds = new Set<string>();
  for (const turn of input.providerTurns) {
    if (
      providerTurnIds.has(turn.id) ||
      nodeIds.has(turn.nodeId) ||
      (turn.runAttemptId !== null && attemptIds.has(turn.runAttemptId)) ||
      !SETTLED_TURN_STATUSES.has(turn.status)
    ) {
      turnIds.add(turn.id);
    }
  }
  return { attempts, nodeIds, providerTurnIds: turnIds };
}

/**
 * Narrows an already-read history page's nodes, attempts and provider turns
 * with {@link selectHistoryPageSupport}. The SQL store chooses before reading;
 * stores that hold whole projections in memory narrow afterwards. Clients union
 * these arrays by id across pages and live events upsert ids they do not hold,
 * so older pages bring their own support.
 */
export function narrowHistoryPageSupport(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const support = selectHistoryPageSupport({
    ...projection,
    threadId: projection.thread.id,
    items: [...projection.turnItems, ...projection.visibleTurnItems.map((row) => row.item)],
  });
  return {
    ...projection,
    attempts: support.attempts,
    nodes: projection.nodes.filter((node) => support.nodeIds.has(node.id)),
    providerTurns: projection.providerTurns.filter((turn) =>
      support.providerTurnIds.has(turn.id),
    ),
  };
}
