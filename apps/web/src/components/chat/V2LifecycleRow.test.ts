import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { isV2LifecycleItem } from "./V2LifecycleRow";

describe("V2LifecycleRow", () => {
  it("renders source-control markers as standalone lifecycle rows", () => {
    const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("turn-item-source-control"),
      threadId: ThreadId.make("thread-source-control"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "source_control",
      committed: true,
      pullRequest: { number: 47, url: "https://github.com/SpiritDevs/pathway/pull/47" },
    };

    expect(isV2LifecycleItem(item)).toBe(true);
  });
});
