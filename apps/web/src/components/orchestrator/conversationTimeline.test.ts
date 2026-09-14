import { describe, expect, it } from "vite-plus/test";
import type {
  OrchestratorMessage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import {
  buildConversationTimeline,
  conversationTimeMarker,
  conversationMessageTime,
} from "./conversationTimeline";

const message = (id: string, sequence: number, createdAt: number): OrchestratorMessage => ({
  id,
  sequence,
  createdAt,
  chatId: "chat",
  senderKind: "user",
  senderId: "owner",
  senderName: "You",
  text: id,
  status: "sent",
  replyToId: null,
});
const work = (id: string, createdAt?: number): OrchestratorWorkItem => ({
  id,
  ...(createdAt === undefined ? {} : { createdAt }),
  title: id,
  orchestratorId: "agent",
  environmentId: "environment",
  projectId: null,
  threadId: null,
  status: "working",
  detail: "",
});
const ids = (messages: OrchestratorMessage[], items: OrchestratorWorkItem[]) =>
  buildConversationTimeline(messages, items).flatMap((entry) =>
    entry.kind === "message" ? [entry.message.id] : entry.items.map((item) => item.id),
  );

describe("conversation timeline", () => {
  it("places follow-up messages after earlier delegated work, including status updates", () => {
    const messages = [message("request", 1, 100), message("follow-up", 2, 300)];
    const item = work("delegation", 200);
    expect(ids(messages, [item])).toEqual(["request", "delegation", "follow-up"]);
    expect(ids(messages, [{ ...item, status: "completed" }])).toEqual([
      "request",
      "delegation",
      "follow-up",
    ]);
  });

  it("keeps messages in sequence and groups only work between the same messages", () => {
    const messages = [message("request", 1, 100), message("reply", 2, 300)];
    const items = [work("latest", 400), work("second", 220), work("first", 200)];
    expect(ids(messages, items)).toEqual(["request", "first", "second", "reply", "latest"]);
    expect(buildConversationTimeline(messages, items).map((entry) => entry.kind)).toEqual([
      "message",
      "work",
      "message",
      "work",
    ]);
  });

  it("puts same-time work after messages and preserves its position when history loads", () => {
    const items = [work("delegation", 100)];
    expect(ids([message("follow-up", 2, 300)], items)).toEqual(["delegation", "follow-up"]);
    expect(ids([message("request", 1, 100), message("follow-up", 2, 300)], items)).toEqual([
      "request",
      "delegation",
      "follow-up",
    ]);
  });

  it("keeps legacy work without timestamps above new messages", () => {
    expect(ids([message("new", 1, 100)], [work("legacy")])).toEqual(["legacy", "new"]);
    expect(ids([], [work("only", 200)])).toEqual(["only"]);
  });
});

const presentation = (messages: OrchestratorMessage[], items: OrchestratorWorkItem[] = []) =>
  buildConversationTimeline(messages, items).flatMap((entry) =>
    entry.kind === "message"
      ? [
          {
            id: entry.message.id,
            start: entry.startsGroup,
            end: entry.endsGroup,
            marker: entry.timeMarker,
          },
        ]
      : [],
  );
const morning = new Date(2026, 8, 15, 9).getTime();
const minute = 60_000;

describe("message groups", () => {
  it("groups consecutive messages from one sender within five minutes", () => {
    expect(
      presentation([
        message("first", 1, morning),
        message("second", 2, morning + 5 * minute),
        message("later", 3, morning + 11 * minute),
      ]),
    ).toEqual([
      { id: "first", start: true, end: false, marker: true },
      { id: "second", start: false, end: true, marker: false },
      { id: "later", start: true, end: true, marker: false },
    ]);
  });
  it("breaks groups at sender changes, system messages, and hidden search results", () => {
    const messages = [
      message("first", 1, morning),
      { ...message("other", 2, morning + minute), senderId: "someone-else" },
      { ...message("notice", 3, morning + 2 * minute), senderKind: "system" as const },
      message("reply", 4, morning + 3 * minute),
      message("search-match", 6, morning + 4 * minute),
    ];
    expect(presentation(messages).every((entry) => entry.start && entry.end)).toBe(true);
  });
  it("keeps work cards between distinct groups and stable when earlier history loads", () => {
    const messages = [message("first", 1, morning), message("follow-up", 2, morning + 2 * minute)];
    const items = [work("task", morning + minute)];
    expect(presentation(messages, items).map((entry) => [entry.start, entry.end])).toEqual([
      [true, true],
      [true, true],
    ]);
    const loaded = presentation([message("older", 0, morning - minute), ...messages], items);
    expect(loaded.at(-1)).toEqual(presentation(messages, items).at(-1));
  });
  it("inserts time markers after gaps over two hours, not at exactly two hours", () => {
    expect(
      presentation([
        message("first", 1, morning),
        message("two-hours", 2, morning + 120 * minute),
        message("more-than-two", 3, morning + 241 * minute),
      ]).map((entry) => entry.marker),
    ).toEqual([true, false, true]);
  });
  it("starts a new group and time marker across midnight even a minute apart", () => {
    const midnight = new Date(2026, 8, 16).getTime();
    expect(
      presentation([message("before", 1, midnight - minute), message("after", 2, midnight)]),
    ).toEqual([
      { id: "before", start: true, end: true, marker: true },
      { id: "after", start: true, end: true, marker: true },
    ]);
  });
});

it("labels time markers with a day and time, including the year for old history", () => {
  const now = new Date(2026, 8, 15, 12).getTime();
  expect(conversationTimeMarker(morning, now)).toBe(
    `Today ${conversationMessageTime.format(morning)}`,
  );
  const yesterday = new Date(2026, 8, 14, 13, 30).getTime();
  expect(conversationTimeMarker(yesterday, now)).toBe(
    `Yesterday ${conversationMessageTime.format(yesterday)}`,
  );
  expect(conversationTimeMarker(new Date(2025, 8, 14).getTime(), now)).toContain("2025");
});
