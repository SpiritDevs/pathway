import type {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  OrchestrationV2ThreadProjection,
  RunId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

const EMPTY_SUMMARIES: ReadonlyArray<ThreadCheckpointSummary> = [];

/** Shares checkpoint rows across streamed content changes, which cannot change message ownership. */
export function createThreadCheckpointSummaryDeriver() {
  let previousMessages: OrchestrationV2ThreadProjection["messages"] = [];
  let assistantMessageByRun = new Map<RunId, MessageId>();
  let previousCheckpoints: OrchestrationV2ThreadProjection["checkpoints"] = [];
  let previous = EMPTY_SUMMARIES;
  const summaries = new WeakMap<
    OrchestrationV2ThreadProjection["checkpoints"][number],
    ThreadCheckpointSummary
  >();
  return (projection: OrchestrationV2ThreadProjection): ReadonlyArray<ThreadCheckpointSummary> => {
    const messages = projection.messages;
    const sameAssociations =
      messages === previousMessages ||
      (messages.length === previousMessages.length &&
        messages.every((message, index) => {
          const old = previousMessages[index]!;
          return message.id === old.id && message.runId === old.runId && message.role === old.role;
        }));
    previousMessages = messages;
    if (!sameAssociations) {
      const next = new Map<RunId, MessageId>();
      for (const message of messages) {
        if (message.role === "assistant" && message.runId !== null) {
          next.set(message.runId, message.id);
        }
      }
      if (
        next.size !== assistantMessageByRun.size ||
        [...next].some(([runId, messageId]) => assistantMessageByRun.get(runId) !== messageId)
      ) {
        assistantMessageByRun = next;
        previousCheckpoints = [];
      }
    }
    if (projection.checkpoints === previousCheckpoints) return previous;
    previousCheckpoints = projection.checkpoints;
    const next: ThreadCheckpointSummary[] = [];
    for (const checkpoint of projection.checkpoints) {
      if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) continue;
      const assistantMessageId = assistantMessageByRun.get(checkpoint.runId) ?? null;
      let summary = summaries.get(checkpoint);
      if (summary === undefined || summary.assistantMessageId !== assistantMessageId) {
        summary = {
          checkpointId: checkpoint.id,
          scopeId: checkpoint.scopeId,
          runId: checkpoint.runId,
          checkpointTurnCount: checkpoint.appRunOrdinal,
          checkpointRef: checkpoint.ref,
          status: checkpoint.status,
          files: checkpoint.files,
          assistantMessageId,
          completedAt: DateTime.formatIso(checkpoint.capturedAt),
        };
        summaries.set(checkpoint, summary);
      }
      next.push(summary);
    }
    if (
      next.length === previous.length &&
      next.every((summary, index) => summary === previous[index])
    ) {
      return previous;
    }
    previous = next.length === 0 ? EMPTY_SUMMARIES : next;
    return previous;
  };
}

/** Derives the checkpoint/diff rows needed by review UIs from native V2 entities. */
export function deriveThreadCheckpointSummaries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return createThreadCheckpointSummaryDeriver()(projection);
}
