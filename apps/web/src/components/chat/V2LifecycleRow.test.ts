import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const requests = vi.hoisted(() => ({
  load: vi.fn(),
  fetch: vi.fn((input: unknown) => input),
}));
vi.mock("@spiritdevs/client-runtime/state/threads", () => ({
  fetchEnvironmentItemDetail: requests.fetch,
}));
vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: requests.load } }));
vi.mock("../../state/session", () => ({ readPreparedConnection: () => ({ prepared: true }) }));

import { isV2LifecycleItem, SubagentCard, V2LifecycleRow } from "./V2LifecycleRow";

const environmentId = EnvironmentId.make("environment:local");

describe("V2LifecycleRow", () => {
  it("groups subagents into one card with a count and status summary", () => {
    const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
    const subagent = (id: string, status: "running" | "completed", result: string | null) =>
      ({
        id: TurnItemId.make(id),
        threadId: ThreadId.make("thread-parent"),
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status,
        title: `Subagent: ${id}`,
        startedAt: now,
        completedAt: status === "completed" ? DateTime.add(now, { minutes: 2 }) : null,
        updatedAt: now,
        type: "subagent",
        subagentId: `node:${id}`,
        origin: "app_owned",
        driver: "codex",
        providerInstanceId: ProviderInstanceId.make("codex"),
        childThreadId: ThreadId.make(`thread-${id}`),
        prompt: "Do the work",
        progress: "Reading files",
        result,
      }) as Extract<OrchestrationV2TurnItem, { type: "subagent" }>;

    const markup = renderToStaticMarkup(
      createElement(SubagentCard, {
        environmentId,
        items: [
          subagent("fix-cache", "running", null),
          subagent("audit", "completed", "- No **bugs** found in `cache.ts`"),
        ],
        providerStatuses: [],
        subagents: [],
        onOpenThread: () => {},
      }),
    );
    expect(markup).toContain('data-subagent-group="true"');
    expect(markup).toContain("2 subagents");
    expect(markup).toContain("1 running · 1 finished");
    expect(markup).toContain('aria-label="Open fix-cache"');
    expect(markup).toContain("Reading files");
    // A settled row leads with its result, flattened to one line.
    expect(markup).toContain("No **bugs** found in cache.ts");
    expect(markup).toContain("2m 0s");
    expect(markup).not.toContain("Do the work");
  });

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
        environmentId,
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
        environmentId,
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
        environmentId,
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

  it("fetches a previewed subagent result only when its full text is asked for", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const now = DateTime.makeUnsafe("2026-08-14T00:00:00.000Z");
    const item = {
      id: TurnItemId.make("subagent:large"),
      threadId: ThreadId.make("thread-parent"),
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: "Subagent: audit",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "subagent",
      subagentId: "node:audit",
      origin: "app_owned",
      driver: "codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Audit",
      result: "head\n… omitted …\ntail",
      resultPreview: { totalBytes: 70_000, format: "text" },
    } as Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
    let renderer!: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        createElement(SubagentCard, {
          environmentId,
          items: [item],
          providerStatuses: [],
          subagents: [],
          onOpenThread: () => {},
        }),
      );
    });
    const button = (label: string) =>
      renderer.root
        .findAllByType("button")
        .find((candidate) => String(candidate.props.children).startsWith(label));
    const resultText = () =>
      renderer.root.findByProps({ "data-v2-subagent-result": "true" }).props.children;
    await act(async () => {
      renderer.root.findByProps({ "data-v2-subagent-result-disclosure": "true" }).props.onClick();
    });
    expect(resultText()).toBe("head\n… omitted …\ntail");
    expect(requests.load).not.toHaveBeenCalled();
    requests.load.mockResolvedValue({ text: "the complete result" });
    await act(async () => {
      await button("Show all 69 KB")!.props.onClick();
    });
    expect(requests.fetch).toHaveBeenCalledWith({
      prepared: { prepared: true },
      threadId: item.threadId,
      itemId: item.id,
      field: "result",
    });
    expect(resultText()).toBe("the complete result");
    expect(button("Show all")).toBeUndefined();
    await act(async () => renderer.unmount());
    vi.unstubAllGlobals();
  });
});
