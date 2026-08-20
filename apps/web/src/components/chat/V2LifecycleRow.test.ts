import { ThreadId, TurnItemId, type OrchestrationV2TurnItem } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { isV2LifecycleItem, V2LifecycleRow } from "./V2LifecycleRow";

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
      commitSha: "abc1234567890",
      pullRequest: null,
    };

    expect(isV2LifecycleItem(item)).toBe(true);

    const markup = renderToStaticMarkup(
      createElement(V2LifecycleRow, {
        item,
        createdAt: "2026-08-14T00:00:00.000Z",
        timestampFormat: "locale",
        providerStatuses: [],
        runs: [],
        subagents: [],
        onOpenThread: () => {},
      }),
    );
    expect(markup).toContain("Committed and pushed");
    expect(markup).toContain("abc1234");
    expect(markup).toContain('title="Commit abc1234567890"');
    expect(markup.match(/data-timeline-divider-separator/g)).toHaveLength(2);
  });
});
