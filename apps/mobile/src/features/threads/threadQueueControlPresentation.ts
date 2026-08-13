import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";

export const REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Remove queued message";
export const REORDER_QUEUED_MESSAGE_ACCESSIBILITY_LABEL = "Reorder queued message";

/** Rows are a fixed height so a drag can turn a finger's travel into a queue position. */
export const QUEUE_ROW_HEIGHT = 44;

export interface ThreadQueueRowControls {
  readonly canDismiss: boolean;
  /** Whether the handle can be dragged at all: a queue of one has nowhere to go. */
  readonly canDrag: boolean;
  /** VoiceOver's decrement/increment on the handle, for reordering without a drag. */
  readonly canMoveDown: boolean;
  readonly canMoveUp: boolean;
  readonly canSteer: boolean;
  readonly dismissAccessibilityLabel: string;
  readonly displayText: string;
  readonly reorderAccessibilityLabel: string;
  readonly positionAccessibilityText: string;
}

export function resolveThreadQueueRowControls(input: {
  readonly busy: boolean;
  readonly canPromoteToSteer: boolean;
  readonly canReorder: boolean;
  readonly index: number;
  readonly queuedCount: number;
  readonly text: string;
}): ThreadQueueRowControls {
  const mutationEnabled = !input.busy;
  const reorderEnabled = mutationEnabled && input.canReorder;

  return {
    canDismiss: !input.busy,
    canDrag: reorderEnabled && input.queuedCount > 1,
    canMoveDown: reorderEnabled && input.index < input.queuedCount - 1,
    canMoveUp: reorderEnabled && input.index > 0,
    canSteer: mutationEnabled && input.canPromoteToSteer,
    dismissAccessibilityLabel: REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    displayText: input.text,
    reorderAccessibilityLabel: REORDER_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
    positionAccessibilityText: `Position ${input.index + 1} of ${input.queuedCount}`,
  };
}

/**
 * Where a vertical drag of `translationY` from `startIndex` would drop the row.
 * Runs on the UI thread while the finger moves, so the gesture only crosses
 * back to JS when the landing position actually changes.
 */
export function resolveQueueDropIndex(input: {
  readonly startIndex: number;
  readonly translationY: number;
  readonly rowHeight: number;
  readonly count: number;
}): number {
  "worklet";
  const moved = input.startIndex + Math.round(input.translationY / input.rowHeight);
  return Math.min(Math.max(moved, 0), input.count - 1);
}

export function buildCancelQueuedRunCommand(input: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId;
  readonly threadId: ThreadId;
}): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly runId: RunId;
    readonly threadId: ThreadId;
  };
} {
  return {
    environmentId: input.environmentId,
    input: {
      runId: input.runId,
      threadId: input.threadId,
    },
  };
}
