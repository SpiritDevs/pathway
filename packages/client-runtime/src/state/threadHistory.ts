import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadHistory,
  OrchestrationV2ThreadProjection,
} from "@spiritdevs/contracts";
import { isOrchestrationV2TurnItemVisible } from "@spiritdevs/shared/orchestrationV2Timeline";
import * as DateTime from "effect/DateTime";

import type { ThreadHistoryDirection } from "./threadState.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";

type Projection = OrchestrationV2ThreadProjection;
export type ThreadHistoryWatermarks = ReadonlyMap<string, number>;

function mergeEntities<T extends { readonly id: unknown }>(
  current: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
  key: string,
  sequence: number,
  watermarks: Map<string, number>,
) {
  const existing = new Set(current.map((item) => item.id));
  const added = incoming.filter((item) => !existing.has(item.id));
  for (const item of added) watermarks.set(`${key}:${String(item.id)}`, sequence);
  return added.length === 0 ? current : [...current, ...added];
}

/** Import historical rows without advancing the live stream cursor or overwriting its rows. */
export function mergeThreadHistoryPage(
  current: Projection,
  currentHistory: OrchestrationV2ThreadHistory,
  snapshot: OrchestrationV2ThreadDetailSnapshot & {
    readonly history: OrchestrationV2ThreadHistory;
  },
  direction: ThreadHistoryDirection,
  previousWatermarks: ThreadHistoryWatermarks,
) {
  const page = snapshot.projection;
  const watermarks = new Map(previousWatermarks);
  const replacing = direction !== "older" && direction !== "newer";
  const merge = <T extends { readonly id: unknown }>(
    items: ReadonlyArray<T>,
    incoming: ReadonlyArray<T>,
    key: string,
  ) => mergeEntities(items, incoming, key, snapshot.snapshotSequence, watermarks);
  const content = <T extends { readonly id: unknown }>(
    items: ReadonlyArray<T>,
    incoming: ReadonlyArray<T>,
    key: string,
  ) => merge(replacing ? [] : items, incoming, key);
  const currentRowIds = new Set(current.visibleTurnItems.map((row) => row.sourceItemId));
  const addedRows = page.visibleTurnItems.filter((row) => !currentRowIds.has(row.sourceItemId));
  const projection: Projection = {
    ...current,
    runs: merge(current.runs, page.runs, "run"),
    attempts: merge(current.attempts, page.attempts, "run-attempt"),
    nodes: merge(current.nodes, page.nodes, "node"),
    subagents: merge(current.subagents, page.subagents, "subagent"),
    providerSessions: merge(current.providerSessions, page.providerSessions, "provider-session"),
    providerThreads: merge(current.providerThreads, page.providerThreads, "provider-thread"),
    providerTurns: merge(current.providerTurns, page.providerTurns, "provider-turn"),
    runtimeRequests: merge(current.runtimeRequests, page.runtimeRequests, "runtime-request"),
    messages: content(current.messages, page.messages, "message").toSorted(
      (a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt),
    ),
    plans: content(current.plans, page.plans, "plan"),
    turnItems: content(current.turnItems, page.turnItems, "turn-item").toSorted(
      (a, b) => a.ordinal - b.ordinal || String(a.id).localeCompare(String(b.id)),
    ),
    checkpointScopes: merge(current.checkpointScopes, page.checkpointScopes, "checkpoint-scope"),
    checkpoints: merge(current.checkpoints, page.checkpoints, "checkpoint"),
    contextHandoffs: merge(current.contextHandoffs, page.contextHandoffs, "context-handoff"),
    contextTransfers: merge(current.contextTransfers, page.contextTransfers, "context-transfer"),
    visibleTurnItems: replacing
      ? page.visibleTurnItems
      : direction === "older"
        ? [...addedRows, ...current.visibleTurnItems]
        : [...current.visibleTurnItems, ...addedRows],
  };
  const history: OrchestrationV2ThreadHistory = replacing
    ? snapshot.history
    : direction === "older"
      ? {
          ...currentHistory,
          hasOlder: snapshot.history.hasOlder,
          ...(snapshot.history.beforeCursor === undefined
            ? {}
            : { beforeCursor: snapshot.history.beforeCursor }),
          index: snapshot.history.index,
        }
      : {
          ...currentHistory,
          hasNewer: snapshot.history.hasNewer,
          ...(snapshot.history.afterCursor === undefined
            ? {}
            : { afterCursor: snapshot.history.afterCursor }),
          index: snapshot.history.index,
        };
  return { projection, history, watermarks, replacing };
}

/** Snapshot rows are already current through their page sequence; replay cannot regress them. */
export function shouldApplyThreadHistoryEvent(
  projection: Projection,
  history: OrchestrationV2ThreadHistory,
  event: OrchestrationV2DomainEvent,
  sequence: number,
  contentSequence: number,
  watermarks: ThreadHistoryWatermarks,
) {
  const entityKey =
    "id" in event.payload ? `${event.type.split(".")[0]}:${String(event.payload.id)}` : null;
  if (entityKey !== null && sequence <= (watermarks.get(entityKey) ?? -1)) return false;
  if (event.type === "turn-item.updated") {
    if (sequence <= contentSequence) return false;
    return true;
  }
  if (event.type === "message.updated" || event.type === "plan.updated") {
    if (sequence <= contentSequence) return false;
    const entities = event.type === "message.updated" ? projection.messages : projection.plans;
    return !history.hasNewer || entities.some((item) => item.id === event.payload.id);
  }
  return true;
}

/** Active support items may live outside the viewport and must not create a gap in its rows. */
export function applyThreadHistoryProjectionEvent(
  projection: Projection,
  history: OrchestrationV2ThreadHistory,
  event: OrchestrationV2DomainEvent,
): Projection {
  if (event.type === "turn-item.updated") {
    const visible = projection.visibleTurnItems.some(
      (row) => row.sourceItemId === event.payload.id,
    );
    const firstLocal = projection.visibleTurnItems.find((row) => row.visibility === "local");
    const atTail =
      !history.hasNewer &&
      (firstLocal === undefined || event.payload.ordinal >= firstLocal.item.ordinal);
    if (!visible && !atTail) {
      const index = projection.turnItems.findIndex((item) => item.id === event.payload.id);
      return index === -1
        ? projection
        : {
            ...projection,
            turnItems: projection.turnItems.map((item, position) =>
              position === index ? event.payload : item,
            ),
            updatedAt: event.occurredAt,
          };
    }
  }
  return applyOrchestrationV2ProjectionEvent(projection, event) ?? projection;
}

export function updateThreadHistoryIndex(
  history: OrchestrationV2ThreadHistory,
  event: OrchestrationV2DomainEvent,
  projection: Projection,
): OrchestrationV2ThreadHistory {
  if (event.type !== "turn-item.updated") return history;
  const item = event.payload;
  if (item.type === "user_message") {
    if (
      !isOrchestrationV2TurnItemVisible({
        item,
        runs: projection.runs,
        attempts: projection.attempts,
        items: projection.turnItems,
      })
    ) {
      const index = history.index.filter((entry) => entry.messageId !== item.messageId);
      return index.length === history.index.length ? history : { ...history, index };
    }
    const index = history.index.findIndex((entry) => entry.messageId === item.messageId);
    const entry = {
      messageId: item.messageId,
      role: "user" as const,
      preview: item.text.slice(0, 280),
    };
    if (index === -1) return { ...history, index: [...history.index, entry] };
    if (history.index[index]?.preview === entry.preview) return history;
    return {
      ...history,
      index: history.index.map((value, position) =>
        position === index ? { ...value, ...entry } : value,
      ),
    };
  }
  if (item.type === "assistant_message" && history.index.length > 0) {
    const user = projection.turnItems.findLast(
      (candidate) =>
        candidate.type === "user_message" &&
        candidate.runId === item.runId &&
        candidate.ordinal <= item.ordinal,
    );
    if (user?.type !== "user_message") return history;
    const index = history.index.findIndex((entry) => entry.messageId === user.messageId);
    if (index === -1) return history;
    const assistantPreview = item.text.slice(0, 280);
    if (history.index[index]?.assistantPreview === assistantPreview) return history;
    return {
      ...history,
      index: history.index.map((value, position) =>
        position === index ? { ...value, assistantPreview } : value,
      ),
    };
  }
  return history;
}
