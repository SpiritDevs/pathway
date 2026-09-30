import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { deriveThreadCheckpointSummaries } from "@spiritdevs/client-runtime/state/thread-checkpoints";
import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";
import { inferCheckpointTurnCountByRunId } from "../session-logic";
import { environmentThreadDetails } from "../state/threads";
import type { TurnDiffSummary } from "../types";

const EMPTY_TURN_DIFF_SUMMARIES: ReadonlyArray<TurnDiffSummary> = [];

function sameTurnDiffFiles(left: TurnDiffSummary["files"], right: TurnDiffSummary["files"]) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((file, index) => {
        const other = right[index];
        return (
          other !== undefined &&
          file.path === other.path &&
          file.kind === other.kind &&
          file.additions === other.additions &&
          file.deletions === other.deletions
        );
      }))
  );
}

/** Whether two derivations describe the same checkpoints, so a streaming delta can keep the old one. */
export function sameTurnDiffSummaries(
  left: ReadonlyArray<TurnDiffSummary>,
  right: ReadonlyArray<TurnDiffSummary>,
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((summary, index) => {
        const other = right[index];
        return (
          other !== undefined &&
          summary.checkpointId === other.checkpointId &&
          summary.scopeId === other.scopeId &&
          summary.runId === other.runId &&
          summary.checkpointTurnCount === other.checkpointTurnCount &&
          summary.checkpointRef === other.checkpointRef &&
          summary.status === other.status &&
          summary.assistantMessageId === other.assistantMessageId &&
          summary.completedAt === other.completedAt &&
          sameTurnDiffFiles(summary.files, other.files)
        );
      }))
  );
}

// Keyed by the thread key so every caller shares one derivation, and equality-gated so a
// streaming delta that leaves the checkpoints alone notifies no subscriber.
const threadTurnDiffSummariesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [
    ScopedThreadRef["environmentId"],
    ScopedThreadRef["threadId"],
  ];
  return Atom.make((get) => {
    const thread = get(environmentThreadDetails.threadAtom({ environmentId, threadId }));
    return thread === null
      ? EMPTY_TURN_DIFF_SUMMARIES
      : deriveThreadCheckpointSummaries(thread.projection);
  }).pipe(
    Atom.withEquality(sameTurnDiffSummaries),
    Atom.withLabel(`web-thread-turn-diff-summaries:${key}`),
  );
});
const EMPTY_TURN_DIFF_SUMMARIES_ATOM = Atom.make(EMPTY_TURN_DIFF_SUMMARIES).pipe(
  Atom.withLabel("web-thread-turn-diff-summaries:empty"),
);

/**
 * A thread's checkpoint summaries without subscribing to its whole projection: the caller
 * re-renders when a checkpoint lands, not on every streamed delta.
 */
export function useThreadTurnDiffSummaries(ref: ScopedThreadRef | null) {
  const key = ref === null ? null : JSON.stringify([ref.environmentId, ref.threadId]);
  const turnDiffSummaries = useAtomValue(
    key === null ? EMPTY_TURN_DIFF_SUMMARIES_ATOM : threadTurnDiffSummariesAtom(key),
  );
  const inferredCheckpointTurnCountByRunId = useMemo(
    () => inferCheckpointTurnCountByRunId(turnDiffSummaries),
    [turnDiffSummaries],
  );
  return { turnDiffSummaries, inferredCheckpointTurnCountByRunId };
}

export function useTurnDiffSummaries(projection: OrchestrationV2ThreadProjection | null) {
  const turnDiffSummaries = useMemo<ReadonlyArray<TurnDiffSummary>>(() => {
    if (projection === null) {
      return [];
    }
    return deriveThreadCheckpointSummaries(projection);
  }, [projection]);

  const inferredCheckpointTurnCountByRunId = useMemo(
    () => inferCheckpointTurnCountByRunId(turnDiffSummaries),
    [turnDiffSummaries],
  );

  return { turnDiffSummaries, inferredCheckpointTurnCountByRunId };
}
