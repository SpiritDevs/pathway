import { MessageId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  resolveTimelineHistoryNavigation,
  resolveTimelineHistoryPrefetch,
} from "./MessagesTimeline.history";

function messageRows(messages: Array<{ id: string; role: "user" | "assistant"; text: string }>) {
  return deriveMessagesTimelineRows({
    timelineEntries: messages.map((message) => ({
      kind: "message",
      id: message.id,
      createdAt: "2026-09-19T00:00:00.000Z",
      message: {
        ...message,
        id: MessageId.make(message.id),
        createdAt: "2026-09-19T00:00:00.000Z",
        updatedAt: "2026-09-19T00:00:00.000Z",
        streaming: false,
        runId: null,
      },
    })),
    isWorking: false,
    activeTurnStartedAt: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    revertTurnCountByUserMessageId: new Map(),
  });
}

describe("history minimap", () => {
  it("keeps unloaded markers addressable and uses current rows for loaded previews", () => {
    const rows = messageRows([
      { id: "recent", role: "user", text: "Current prompt" },
      { id: "response", role: "assistant", text: "Current response" },
    ]);
    const items = deriveTimelineMinimapItems(rows, [
      {
        messageId: MessageId.make("old"),
        role: "user",
        preview: "Old prompt",
        assistantPreview: "Old response",
      },
      {
        messageId: MessageId.make("recent"),
        role: "user",
        preview: "Stale prompt",
        assistantPreview: "Stale response",
      },
    ]);
    expect(items).toEqual([
      {
        id: "old",
        messageId: "old",
        rowIndex: null,
        userText: "Old prompt",
        assistantText: "Old response",
      },
      {
        id: "recent",
        messageId: "recent",
        rowIndex: 0,
        userText: "Current prompt",
        assistantText: "Current response",
      },
    ]);
  });

  it("appends a live prompt missing from the index without duplicating loaded markers", () => {
    const rows = messageRows([
      { id: "recent", role: "user", text: "Recent prompt" },
      { id: "live", role: "user", text: "New live prompt" },
    ]);
    const items = deriveTimelineMinimapItems(rows, [
      { messageId: MessageId.make("old"), role: "user", preview: "Old prompt" },
      { messageId: MessageId.make("recent"), role: "user", preview: "Recent prompt" },
    ]);
    expect(items.map((item) => item.messageId)).toEqual(["old", "recent", "live"]);
    expect(items.map((item) => item.rowIndex)).toEqual([null, 0, 1]);
  });

  it("retains a remote answer preview when a loaded page stops immediately after its prompt", () => {
    const items = deriveTimelineMinimapItems(
      messageRows([{ id: "old", role: "user", text: "Old prompt" }]),
      [
        {
          messageId: MessageId.make("old"),
          role: "user",
          preview: "Old prompt",
          assistantPreview: "Answer outside this page",
        },
      ],
    );
    expect(items[0]?.assistantText).toBe("Answer outside this page");
  });
});

describe("remote marker navigation", () => {
  const messageId = MessageId.make("target");
  const rows = messageRows([{ id: "target", role: "user", text: "Requested prompt" }]);

  it("waits for the requested window before scrolling to the target", () => {
    expect(
      resolveTimelineHistoryNavigation({
        messageId,
        rows,
        liveFollowEnabled: false,
        isLoading: true,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      resolveTimelineHistoryNavigation({
        messageId,
        rows: [],
        liveFollowEnabled: false,
        isLoading: false,
      }),
    ).toEqual({ kind: "wait" });
    expect(
      resolveTimelineHistoryNavigation({
        messageId,
        rows,
        liveFollowEnabled: false,
        isLoading: false,
      }),
    ).toEqual({ kind: "scroll", rowIndex: 0 });
  });

  it("cancels a superseded marker on Send or return to latest whether the target is loaded or absent", () => {
    for (const loadedRows of [rows, []]) {
      for (const isLoading of [true, false]) {
        expect(
          resolveTimelineHistoryNavigation({
            messageId,
            rows: loadedRows,
            liveFollowEnabled: true,
            isLoading,
          }),
        ).toEqual({ kind: "cancel" });
      }
    }
  });
});

describe("history prefetch", () => {
  // An 800px viewport prefetches within 2,000px (2.5 viewports) of either edge.
  const input = {
    previousScroll: 2_100,
    scroll: 1_900,
    scrollLength: 800,
    distanceToEnd: 20_000,
    liveFollowEnabled: false,
    userScrollDirection: "older" as const,
    history: {
      hasOlder: true,
      hasNewer: true,
      isLoading: false,
      isPrefetching: false,
      error: null,
    },
  };

  it("prefetches older pages a few viewports before the top edge scrolls into view", () => {
    expect(resolveTimelineHistoryPrefetch(input)).toBe("older");
    expect(
      resolveTimelineHistoryPrefetch({ ...input, previousScroll: 2_300, scroll: 2_100 }),
    ).toBeNull();
  });

  it("prefetches newer pages a few viewports before the end of a historical window", () => {
    const newer = {
      ...input,
      previousScroll: 1_000,
      scroll: 1_200,
      userScrollDirection: "newer" as const,
    };
    expect(resolveTimelineHistoryPrefetch({ ...newer, distanceToEnd: 1_900 })).toBe("newer");
    expect(resolveTimelineHistoryPrefetch({ ...newer, distanceToEnd: 2_100 })).toBeNull();
    expect(
      resolveTimelineHistoryPrefetch({
        ...newer,
        distanceToEnd: 0,
        history: { ...input.history, hasNewer: false },
      }),
    ).toBeNull();
  });

  it("only prefetches in the direction the user is moving", () => {
    const nearBoth = { ...input, scroll: 500, distanceToEnd: 500 };
    expect(
      resolveTimelineHistoryPrefetch({ ...nearBoth, previousScroll: 600, userScrollDirection: "newer" }),
    ).toBeNull();
    expect(
      resolveTimelineHistoryPrefetch({ ...nearBoth, previousScroll: 400, userScrollDirection: "older" }),
    ).toBeNull();
    expect(
      resolveTimelineHistoryPrefetch({ ...nearBoth, previousScroll: 600, userScrollDirection: "either" }),
    ).toBe("older");
    expect(
      resolveTimelineHistoryPrefetch({ ...nearBoth, previousScroll: 400, userScrollDirection: "either" }),
    ).toBe("newer");
  });

  it("keeps a minimum runway before the viewport is measured", () => {
    const unmeasured = { ...input, scrollLength: 0, previousScroll: 200 };
    expect(resolveTimelineHistoryPrefetch({ ...unmeasured, scroll: 120 })).toBe("older");
    expect(resolveTimelineHistoryPrefetch({ ...unmeasured, scroll: 150 })).toBeNull();
  });

  it("does not fetch on mount, programmatic positioning, layout correction, or while following", () => {
    expect(resolveTimelineHistoryPrefetch({ ...input, previousScroll: null })).toBeNull();
    expect(resolveTimelineHistoryPrefetch({ ...input, userScrollDirection: null })).toBeNull();
    expect(resolveTimelineHistoryPrefetch({ ...input, previousScroll: 1_800 })).toBeNull();
    expect(resolveTimelineHistoryPrefetch({ ...input, liveFollowEnabled: true })).toBeNull();
  });

  it("keeps errors available for explicit retry and does not overlap requests", () => {
    for (const history of [
      { ...input.history, error: "Disconnected" },
      { ...input.history, isLoading: true },
      { ...input.history, isPrefetching: true },
      { ...input.history, hasOlder: false },
    ]) {
      expect(resolveTimelineHistoryPrefetch({ ...input, history })).toBeNull();
    }
  });
});
