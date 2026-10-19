import { describe, expect, it } from "vite-plus/test";
import type { OrchestratorMessage, OrchestratorReader } from "@spiritdevs/contracts/aiOrchestrator";
import {
  conversationReceiptLabel,
  hasReadMessage,
  placeConversationReaders,
} from "./conversationReceipts";
const message = (
  sequence: number,
  extra: Partial<OrchestratorMessage> = {},
): OrchestratorMessage => ({
  id: `m${sequence}`,
  chatId: "chat",
  sequence,
  senderKind: "user",
  senderId: "owner",
  senderName: "You",
  text: "Hello",
  status: "queued",
  createdAt: sequence,
  replyToId: null,
  ...extra,
});
const person: OrchestratorReader = {
  id: "jamie",
  kind: "user",
  name: "Jamie",
  fromSequence: 2,
  readSequence: 3,
};
const bot: OrchestratorReader = {
  id: "chief",
  kind: "orchestrator",
  name: "Chief",
  fromSequence: 0,
};
describe("conversation receipts", () => {
  it("separates saved delivery from worker queue and receipt state", () => {
    const pending = message(4, {
      delivery: {
        id: "d",
        workId: "w",
        revision: 1,
        queuePosition: 2,
        mode: "queue",
        state: "pending",
        detail: "Waiting",
      },
    });
    expect(conversationReceiptLabel(pending, [], true)).toBe("Sending…");
    expect(conversationReceiptLabel(pending, [])).toBe("Delivered");
    expect(conversationReceiptLabel({ ...pending, status: "working" }, [])).toBe("Delivered");
    expect(conversationReceiptLabel({ ...pending, seenAt: 42, seenBy: ["chief"] }, [bot])).toBe(
      "Read",
    );
  });
  it("places each reader under only their latest read outgoing message", () => {
    const rows = [message(1), message(2, { seenBy: ["chief"] }), message(3), message(4)];
    const placements = placeConversationReaders(
      rows,
      [person, bot, { ...person, id: "owner" }],
      "owner",
    );
    expect([...placements.entries()]).toEqual([
      ["m3", [person]],
      ["m2", [bot]],
    ]);
    expect(conversationReceiptLabel(rows[2]!, [person])).toBe("Read");
    expect(conversationReceiptLabel(rows[3]!, [person, bot])).toBe("Delivered");
  });
  it("respects joined history and never infers reads for every orchestrator in a group", () => {
    expect(hasReadMessage(person, message(1))).toBe(false);
    expect(hasReadMessage(bot, message(2, { seenBy: ["scout"] }))).toBe(false);
    expect(hasReadMessage(bot, message(2, { seenBy: ["chief"] }))).toBe(true);
    expect(hasReadMessage({ ...bot, fromSequence: 3 }, message(2, { seenBy: ["chief"] }))).toBe(
      false,
    );
  });
  it("keeps failure and cancellation states actionable even after a reader viewed a message", () => {
    expect(conversationReceiptLabel(message(2, { status: "failed", seenAt: 42 }), [person])).toBe(
      "Could not complete this request",
    );
    expect(conversationReceiptLabel(message(2, { status: "cancelled" }), [person])).toBe(
      "Cancelled",
    );
  });
});
