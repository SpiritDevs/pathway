import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import { isOrchestrationV2TurnItemVisible } from "@spiritdevs/shared/orchestrationV2Timeline";

// Streaming updates almost always target the newest entities, so search from the tail.
function upsertEntity<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findLastIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  const next = [...items];
  next[index] = item;
  return next;
}

function removeVisibleItem(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
  sourceItemId: OrchestrationV2TurnItem["id"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const index = rows.findLastIndex((row) => row.sourceItemId === sourceItemId);
  if (index === -1) return rows;
  return renumberVisibleItems([...rows.slice(0, index), ...rows.slice(index + 1)]);
}

function renumberVisibleItems(
  rows: OrchestrationV2ThreadProjection["visibleTurnItems"],
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  return rows.map((row, position) => (row.position === position ? row : { ...row, position }));
}

function shouldShowLocalTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): boolean {
  return isOrchestrationV2TurnItemVisible({
    item,
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
}

/**
 * Drops local rows hidden by rolled-back/cancelled runs or superseded interrupts.
 * Only those runs, attempts, and interrupt requests can hide a row, so the
 * per-row check runs against those small subsets instead of the whole thread.
 */
function activeVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const runs = projection.runs.filter(
    (run) => run.status === "rolled_back" || run.status === "cancelled",
  );
  const attempts = projection.attempts.filter((attempt) => attempt.status === "superseded");
  if (runs.length === 0 && attempts.length === 0) return rows;
  const items =
    attempts.length === 0
      ? []
      : projection.turnItems.filter((item) => item.type === "run_interrupt_request");
  const hidingRunIds = new Set<unknown>([
    ...runs.map((run) => run.id),
    ...attempts.map((attempt) => attempt.runId),
  ]);
  let next: Array<(typeof rows)[number]> | null = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const keep =
      row.visibility !== "local" ||
      !hidingRunIds.has(row.item.runId) ||
      isOrchestrationV2TurnItemVisible({ item: row.item, runs, attempts, items });
    if (!keep) {
      next ??= rows.slice(0, index);
      continue;
    }
    next?.push(row);
  }
  return next === null ? rows : renumberVisibleItems(next);
}

function upsertVisibleTurnItem(
  projection: OrchestrationV2ThreadProjection,
  item: OrchestrationV2TurnItem,
): OrchestrationV2ThreadProjection["visibleTurnItems"] {
  const rows = projection.visibleTurnItems;
  const index = rows.findLastIndex((row) => row.sourceItemId === item.id);
  const next = {
    position: 0,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  };
  const previous = index === -1 ? undefined : rows[index]!;
  if (
    previous !== undefined &&
    previous.visibility === next.visibility &&
    previous.sourceThreadId === next.sourceThreadId &&
    previous.sourceItemId === next.sourceItemId &&
    previous.item === item
  ) {
    return rows;
  }
  // A streaming update keeps its ordinal, so the row keeps its slot.
  if (
    previous !== undefined &&
    previous.visibility === "local" &&
    previous.item.ordinal === item.ordinal
  ) {
    const updated = [...rows];
    updated[index] = { ...next, position: previous.position };
    return updated;
  }
  const updated = index === -1 ? [...rows] : [...rows.slice(0, index), ...rows.slice(index + 1)];
  // Local rows are ordered by (ordinal, id); new items usually land at the tail,
  // so scan backwards for the first local row that sorts after the item.
  let insertionIndex = updated.length;
  for (let position = updated.length - 1; position >= 0; position -= 1) {
    const row = updated[position]!;
    if (row.visibility !== "local") continue;
    const after =
      row.item.ordinal > item.ordinal ||
      (row.item.ordinal === item.ordinal && String(row.item.id).localeCompare(String(item.id)) > 0);
    if (!after) break;
    insertionIndex = position;
  }
  updated.splice(insertionIndex, 0, next);
  return renumberVisibleItems(updated);
}

/** Applies one committed event to a matching thread projection. */
export function applyOrchestrationV2ProjectionEvent(
  projection: OrchestrationV2ThreadProjection | null,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection | null {
  if (projection === null || event.threadId !== projection.thread.id) return projection;

  const base = { ...projection, updatedAt: event.occurredAt };
  switch (event.type) {
    case "thread.model-reported":
      return {
        ...base,
        thread: {
          ...base.thread,
          modelSelection: event.payload.modelSelection,
          updatedAt: event.occurredAt,
        },
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.metadata-updated":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return { ...base, thread: event.payload };
    // Visited tracking is read state, not activity: skip the updatedAt bump.
    case "thread.visited":
    case "thread.marked-unread":
      return { ...projection, thread: event.payload };
    case "run.created":
    case "run.updated": {
      const next = { ...base, runs: upsertEntity(base.runs, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "run-attempt.created":
    case "run-attempt.updated": {
      const next = { ...base, attempts: upsertEntity(base.attempts, event.payload) };
      return { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
    }
    case "node.updated":
      return { ...base, nodes: upsertEntity(base.nodes, event.payload) };
    case "subagent.updated":
      return { ...base, subagents: upsertEntity(base.subagents, event.payload) };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertEntity(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return { ...base, providerThreads: upsertEntity(base.providerThreads, event.payload) };
    case "provider-turn.updated":
      return { ...base, providerTurns: upsertEntity(base.providerTurns, event.payload) };
    case "runtime-request.updated":
      return { ...base, runtimeRequests: upsertEntity(base.runtimeRequests, event.payload) };
    case "message.updated":
      return { ...base, messages: upsertEntity(base.messages, event.payload) };
    case "plan.updated":
      return { ...base, plans: upsertEntity(base.plans, event.payload) };
    case "turn-item.updated": {
      const next = { ...base, turnItems: upsertEntity(base.turnItems, event.payload) };
      const visible = { ...next, visibleTurnItems: activeVisibleTurnItems(next) };
      return {
        ...next,
        visibleTurnItems: shouldShowLocalTurnItem(next, event.payload)
          ? upsertVisibleTurnItem(visible, event.payload)
          : removeVisibleItem(visible.visibleTurnItems, event.payload.id),
      };
    }
    case "checkpoint-scope.created":
      return { ...base, checkpointScopes: upsertEntity(base.checkpointScopes, event.payload) };
    case "checkpoint.captured":
      return { ...base, checkpoints: upsertEntity(base.checkpoints, event.payload) };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return { ...base, contextHandoffs: upsertEntity(base.contextHandoffs, event.payload) };
    case "context-transfer.created":
    case "context-transfer.updated":
      return { ...base, contextTransfers: upsertEntity(base.contextTransfers, event.payload) };
  }
}
