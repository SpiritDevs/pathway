import { describe, expect, it } from "vite-plus/test";

import {
  QUEUE_ROW_HEIGHT,
  REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  REORDER_QUEUED_MESSAGE_ACCESSIBILITY_LABEL,
  buildCancelQueuedRunCommand,
  resolveQueueDropIndex,
  resolveThreadQueueRowControls,
} from "./threadQueueControlPresentation";

describe("threadQueueControlPresentation", () => {
  it("preserves queue reorder and steer controls with removal", () => {
    const controls = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      createdBy: "user",
      index: 1,
      queuedCount: 3,
      text: "Please review the follow-up change.",
    });

    expect(controls.displayText).toBe("Please review the follow-up change.");
    expect(controls.canDrag).toBe(true);
    expect(controls.canMoveUp).toBe(true);
    expect(controls.canMoveDown).toBe(true);
    expect(controls.canSteer).toBe(true);
    expect(controls.canDismiss).toBe(true);
    expect(controls.dismissAccessibilityLabel).toBe(REMOVE_QUEUED_MESSAGE_ACCESSIBILITY_LABEL);
    expect(controls.reorderAccessibilityLabel).toBe(REORDER_QUEUED_MESSAGE_ACCESSIBILITY_LABEL);
    expect(controls.positionAccessibilityText).toBe("Position 2 of 3");
  });

  it("disables edge reorder controls and busy dismissal", () => {
    const first = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: false,
      canReorder: true,
      createdBy: "user",
      index: 0,
      queuedCount: 2,
      text: "First",
    });
    const busy = resolveThreadQueueRowControls({
      busy: true,
      canPromoteToSteer: true,
      canReorder: true,
      createdBy: "user",
      index: 0,
      queuedCount: 1,
      text: "Queued message",
    });

    expect(first.canMoveUp).toBe(false);
    expect(first.canMoveDown).toBe(true);
    expect(first.canDrag).toBe(true);
    expect(first.canSteer).toBe(false);
    expect(busy.canDismiss).toBe(false);
    expect(busy.canDrag).toBe(false);
    expect(busy.canMoveUp).toBe(false);
    expect(busy.canSteer).toBe(false);
  });

  it("offers no drag when the queue cannot be reordered or holds one message", () => {
    const alone = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: false,
      canReorder: true,
      createdBy: "user",
      index: 0,
      queuedCount: 1,
      text: "Only",
    });
    const incapable = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: false,
      canReorder: false,
      createdBy: "user",
      index: 0,
      queuedCount: 3,
      text: "First",
    });

    expect(alone.canDrag).toBe(false);
    expect(alone.canMoveDown).toBe(false);
    expect(incapable.canDrag).toBe(false);
    expect(incapable.canMoveDown).toBe(false);
    expect(incapable.canDismiss).toBe(true);
  });

  it("attributes agent-queued rows and withholds steer from them", () => {
    const agent = resolveThreadQueueRowControls({
      busy: false,
      canPromoteToSteer: true,
      canReorder: true,
      createdBy: "agent",
      index: 0,
      queuedCount: 2,
      text: "Background command completed (exit 1): sleep 5",
    });

    expect(agent.agentAuthored).toBe(true);
    expect(agent.canSteer).toBe(false);
    expect(agent.canDismiss).toBe(true);
    expect(agent.canDrag).toBe(true);
  });

  it("turns a drag's travel into the row it lands on, clamped to the queue", () => {
    const drop = (startIndex: number, translationY: number) =>
      resolveQueueDropIndex({ startIndex, translationY, rowHeight: QUEUE_ROW_HEIGHT, count: 4 });

    expect(drop(1, 0)).toBe(1);
    // Less than half a row of travel is not a move.
    expect(drop(1, QUEUE_ROW_HEIGHT * 0.4)).toBe(1);
    expect(drop(1, QUEUE_ROW_HEIGHT)).toBe(2);
    expect(drop(1, QUEUE_ROW_HEIGHT * 2)).toBe(3);
    expect(drop(1, QUEUE_ROW_HEIGHT * 9)).toBe(3);
    expect(drop(2, -QUEUE_ROW_HEIGHT * 2)).toBe(0);
    expect(drop(2, -QUEUE_ROW_HEIGHT * 9)).toBe(0);
  });

  it("builds cancelQueuedRun command arguments for removal", () => {
    expect(
      buildCancelQueuedRunCommand({
        environmentId: "environment:test" as never,
        runId: "run:queued" as never,
        threadId: "thread:test" as never,
      }),
    ).toEqual({
      environmentId: "environment:test",
      input: {
        runId: "run:queued",
        threadId: "thread:test",
      },
    });
  });
});
