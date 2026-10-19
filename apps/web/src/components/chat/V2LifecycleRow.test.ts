import {
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
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

  it("shows the attached state and detach context-menu affordance", () => {
    const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("turn-item-source-control-attachment"),
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
      committed: false,
      pullRequestAction: "attached",
      pullRequest: { number: 47, url: "https://github.com/SpiritDevs/pathway/pull/47" },
    };

    const markup = renderToStaticMarkup(
      createElement(V2LifecycleRow, {
        item,
        createdAt: "2026-08-14T00:00:00.000Z",
        timestampFormat: "locale",
        providerStatuses: [],
        runs: [],
        subagents: [],
        onOpenThread: () => {},
        onDetachPullRequest: () => {},
      }),
    );

    expect(markup).toContain("PR attached");
    expect(markup).not.toContain("Pushed");
    expect(markup).toContain("#47");
    expect(markup).toContain("Right-click to detach from thread");
  });

  it("renders model-switch compaction as an inspectable collapsed lifecycle row", () => {
    const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
    const item: OrchestrationV2TurnItem = {
      id: TurnItemId.make("turn-item-model-switch-compaction"),
      threadId: ThreadId.make("thread-model-switch-compaction"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Context compaction",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "compaction",
      driver: null,
      kind: "model_switch",
      method: "model",
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      toModel: "gpt-5.6-sol",
      summary: "## Current goal and latest user intent\n- Continue the feature.",
    };

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
    expect(markup).toContain("Context compacted");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("Show compaction summary");
    expect(markup).not.toContain("Continue the feature");
  });
});
