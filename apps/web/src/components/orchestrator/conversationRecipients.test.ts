import { describe, expect, it } from "vite-plus/test";
import { eligibleRecipients, recipientQuery, recipientTarget } from "./conversationRecipients";
const contacts = [
  { id: "lead", name: "Jarvis", canDirect: true },
  { id: "project", name: "QuoteCloud Bot", canDirect: true },
  { id: "private", name: "Private", canDirect: false },
  { id: "outside", name: "Elsewhere", canDirect: true },
];
describe("conversation recipients", () => {
  it("recognizes inline @ and multiword filters, excluding emails", () => {
    expect(recipientQuery("Check @QuoteCloud B", 19)).toEqual({
      start: 6,
      end: 19,
      query: "QuoteCloud B",
    });
    expect(recipientQuery("@", 1)?.query).toBe("");
    expect(recipientQuery("me@example.com", 14)).toBeNull();
    expect(recipientQuery("@Jarvis\nNext", 12)).toBeNull();
  });
  it("lists only permitted members and filters names case-insensitively", () => {
    expect(eligibleRecipients(contacts, ["lead", "project", "private"]).map((c) => c.id)).toEqual([
      "lead",
      "project",
    ]);
    expect(eligibleRecipients(contacts, ["lead", "project"], "CLOUD").map((c) => c.id)).toEqual([
      "project",
    ]);
    expect(eligibleRecipients(contacts, ["lead"], "missing")).toEqual([]);
  });
  it("routes to an explicit recipient and restores lead routing after removal", () => {
    expect(recipientTarget(contacts, "lead", "project")?.id).toBe("project");
    expect(recipientTarget(contacts, "lead", undefined)?.id).toBe("lead");
  });
  it("does not silently route an unavailable explicit selection to someone else", () => {
    expect(recipientTarget(contacts, "lead", "missing")).toBeUndefined();
    expect(recipientTarget(contacts, "lead", "private")).toBeUndefined();
  });
  it("allows addressing ordinary replies but preserves worker routing", () => {
    expect(recipientTarget(contacts, "lead", "project", "lead")?.id).toBe("project");
    expect(recipientTarget(contacts, "lead", "project", "lead", true)?.id).toBe("lead");
    expect(recipientTarget(contacts, "lead", undefined, "project")?.id).toBe("project");
  });
});
