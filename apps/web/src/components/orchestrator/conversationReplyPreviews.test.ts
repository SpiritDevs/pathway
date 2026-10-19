import { describe, expect, it } from "vite-plus/test";
import type { OrchestratorMessage } from "@spiritdevs/contracts/aiOrchestrator";
import { redundantReplyPreviews } from "./conversationReplyPreviews";

const request = (id: string, sequence: number): OrchestratorMessage => ({
  id,
  sequence,
  chatId: "chat",
  createdAt: sequence * 1000,
  senderKind: "user",
  senderId: "user",
  senderName: "You",
  text: id,
  status: "sent",
  replyToId: null,
});
const reply = (
  id: string,
  sequence: number,
  replyToId = "request",
  senderId = "chief",
): OrchestratorMessage => ({
  ...request(id, sequence),
  senderKind: "orchestrator",
  senderId,
  senderName: senderId,
  replyToId,
});
describe("redundant reply previews", () => {
  it("hides three consecutive updates without changing their reply relationships", () => {
    const messages = [request("request", 1), reply("one", 2), reply("two", 3), reply("three", 4)];
    expect([...redundantReplyPreviews(messages)]).toEqual(["one", "two", "three"]);
    expect(messages.slice(1).map((m) => m.replyToId)).toEqual(["request", "request", "request"]);
  });
  it("keeps older targets after a new user request and suppresses replies to the new request", () => {
    expect([
      ...redundantReplyPreviews([
        request("request", 1),
        reply("one", 2),
        request("new", 3),
        reply("old", 4),
        reply("still-old", 5),
      ]),
    ]).toEqual(["one"]);
    expect([
      ...redundantReplyPreviews([
        request("request", 1),
        request("new", 2),
        reply("new-reply", 3, "new"),
      ]),
    ]).toEqual(["new-reply"]);
  });
  it("keeps previews once another coordinator participates, including when the first returns", () => {
    expect([
      ...redundantReplyPreviews([
        request("request", 1),
        reply("one", 2),
        reply("other", 3, "request", "project"),
        reply("return", 4),
      ]),
    ]).toEqual(["one"]);
  });
  it("keeps an older target when another human participates", () => {
    expect([
      ...redundantReplyPreviews([
        request("request", 1),
        { ...request("other-user", 2), senderId: "other" },
        reply("old", 3),
      ]),
    ]).toEqual([]);
  });
  it("keeps previews after intervening conversation, worker or system messages", () => {
    for (const middle of [
      reply("aside", 3, "older"),
      { ...reply("worker", 3), worker: { workId: "work" } },
      { ...reply("system", 3), senderKind: "system" as const },
      { ...reply("unthreaded", 3), replyToId: null },
    ]) {
      expect([
        ...redundantReplyPreviews([
          request("request", 1),
          reply("one", 2),
          middle,
          reply("later", 4),
        ]),
      ]).toEqual(["one"]);
    }
  });
  it("keeps missing targets and replies across missing history or long pauses", () => {
    expect([...redundantReplyPreviews([reply("missing", 2)])]).toEqual([]);
    expect([...redundantReplyPreviews([request("request", 1), reply("gap", 3)])]).toEqual([]);
    expect([
      ...redundantReplyPreviews([
        request("request", 1),
        { ...reply("late", 2), createdAt: 3 * 60 * 60 * 1000 },
      ]),
    ]).toEqual([]);
  });
});
