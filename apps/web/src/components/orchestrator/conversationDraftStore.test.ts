import { describe, expect, it, vi } from "vite-plus/test";
import { createConversationDraftStore } from "./conversationDraftStore";

describe("conversation drafts", () => {
  it("notifies only that chat's composers and ignores identical edits", () => {
    const drafts = createConversationDraftStore();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = drafts.subscribe("a", first);
    drafts.subscribe("b", second);
    drafts.set("a", "Hello");
    drafts.set("a", "Hello");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    unsubscribe();
    drafts.set("a", "Saved across remounts");
    expect(drafts.get("a")).toBe("Saved across remounts");
    expect(first).toHaveBeenCalledTimes(1);
  });

  it("clears account drafts and notifies active composers", () => {
    const drafts = createConversationDraftStore();
    drafts.set("a", "Unsent");
    const changed = vi.fn();
    drafts.subscribe("a", changed);
    drafts.clear();
    expect(drafts.get("a")).toBe("");
    expect(changed).toHaveBeenCalledTimes(1);
    drafts.clear();
    expect(changed).toHaveBeenCalledTimes(1);
  });
});
