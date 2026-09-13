import { describe, expect, it } from "vite-plus/test";
import type {
  OrchestratorMessage,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import { buildConversationTimeline } from "./conversationTimeline";

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
