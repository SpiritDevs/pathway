import { describe, expect, it } from "vite-plus/test";
import { groupReactions } from "./conversationReactions";

describe("message reactions", () => {
  it("groups by emoji in menu order and marks the viewer's own", () => {
    expect(
      groupReactions(
        [
          { emoji: "😂", userId: "colleague" },
          { emoji: "👍", userId: "me" },
          { emoji: "👍", userId: "colleague-2" },
        ],
        "me",
      ),
    ).toEqual([
      { emoji: "👍", count: 2, mine: true },
      { emoji: "😂", count: 1, mine: false },
    ]);
    expect(groupReactions(undefined, "me")).toEqual([]);
  });
});
