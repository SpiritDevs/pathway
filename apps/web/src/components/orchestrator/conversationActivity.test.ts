import { describe, expect, it } from "vite-plus/test";
import { activeConversationIds, conversationAtBottom } from "./conversationActivity";

describe("conversation live edge", () => {
  it("shows return-to-latest outside the bottom tolerance", () => {
    expect(conversationAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 200 })).toBe(
      false,
    );
    expect(conversationAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(
      true,
    );
    expect(conversationAtBottom({ scrollHeight: 200, clientHeight: 400, scrollTop: 0 })).toBe(true);
  });
  it("ends typing at expiry and responds to removed activity", () => {
    const activity = [
      { id: "chief", expiresAt: 100 },
      { id: "project", expiresAt: 200 },
    ];
    expect([...activeConversationIds(activity, 99)]).toEqual(["chief", "project"]);
    expect([...activeConversationIds(activity, 100)]).toEqual(["project"]);
    expect([...activeConversationIds(activity, 200)]).toEqual([]);
    expect([...activeConversationIds([], 99)]).toEqual([]);
  });
});
