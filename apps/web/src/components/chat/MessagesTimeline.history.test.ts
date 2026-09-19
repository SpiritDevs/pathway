import { MessageId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deriveMessagesTimelineRows } from "./MessagesTimeline.logic";
import {
  deriveTimelineMinimapItems,
  resolveTimelineHistoryNavigation,
  resolveTimelineHistoryScrollRequest,
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

describe("automatic history requests", () => {
  const input = {
    previousScroll: 140,
    scroll: 100,
    atEnd: false,
    liveFollowEnabled: false,
    userScrollDirection: "older" as const,
    history: { hasOlder: true, hasNewer: true, isLoading: false, error: null },
  };

  it("loads older content when the user scrolls toward the top", () => {
    expect(resolveTimelineHistoryScrollRequest(input)).toBe("older");
  });

  it("does not fetch on mount, programmatic positioning, layout correction, or while following", () => {
    expect(resolveTimelineHistoryScrollRequest({ ...input, previousScroll: null })).toBeNull();
    expect(resolveTimelineHistoryScrollRequest({ ...input, userScrollDirection: null })).toBeNull();
    expect(resolveTimelineHistoryScrollRequest({ ...input, previousScroll: 90 })).toBeNull();
    expect(resolveTimelineHistoryScrollRequest({ ...input, liveFollowEnabled: true })).toBeNull();
  });

  it("keeps errors available for explicit retry and does not overlap requests", () => {
    expect(
      resolveTimelineHistoryScrollRequest({
        ...input,
        history: { ...input.history, error: "Disconnected" },
      }),
    ).toBeNull();
    expect(
      resolveTimelineHistoryScrollRequest({
        ...input,
        history: { ...input.history, isLoading: true },
      }),
    ).toBeNull();
    expect(
      resolveTimelineHistoryScrollRequest({
        ...input,
        history: { ...input.history, hasOlder: false },
      }),
    ).toBeNull();
  });

  it("loads newer content at the end of a historical window only for downward navigation", () => {
    const atEnd = { ...input, previousScroll: 100, scroll: 140, atEnd: true };
    expect(resolveTimelineHistoryScrollRequest({ ...atEnd, userScrollDirection: "newer" })).toBe(
      "newer",
    );
    expect(resolveTimelineHistoryScrollRequest(atEnd)).toBeNull();
    expect(
      resolveTimelineHistoryScrollRequest({
        ...atEnd,
        userScrollDirection: "newer",
        history: { ...input.history, hasNewer: false },
      }),
    ).toBeNull();
  });
});
