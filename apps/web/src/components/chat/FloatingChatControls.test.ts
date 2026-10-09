import { describe, expect, it } from "vite-plus/test";

import { nearestFloatingChatCorner, replyPreview } from "./FloatingChatControls";

describe("replyPreview", () => {
  it("keeps the first paragraph as plain text", () => {
    expect(
      replyPreview(
        "The URL points to **Session Settings** in a [scratch org](https://x.test).\n\nMore detail.",
      ),
    ).toBe("The URL points to Session Settings in a scratch org.");
  });

  it("skips leading code blocks and strips list and heading markers", () => {
    expect(replyPreview("```ts\nconst a = 1;\n```\n\n## Done\n- `fixed` it")).toBe("Done fixed it");
  });

  it("is empty for an empty reply", () => {
    expect(replyPreview("  \n\n ")).toBe("");
  });
});

describe("nearestFloatingChatCorner", () => {
  const bounds = { left: 100, top: 50, width: 1600, height: 1000 };
  const chat = (left: number, top: number) => ({ left, top, width: 600, height: 400 });

  it("flies to the spot nearest the drop", () => {
    expect(nearestFloatingChatCorner(bounds, chat(1050, 600))).toBe("bottom-right");
    expect(nearestFloatingChatCorner(bounds, chat(150, 120))).toBe("top-left");
    expect(nearestFloatingChatCorner(bounds, chat(620, 580))).toBe("bottom-center");
    expect(nearestFloatingChatCorner(bounds, chat(1000, 90))).toBe("top-right");
  });

  it("has no top-center spot, so a drop there goes to a top corner", () => {
    expect(nearestFloatingChatCorner(bounds, chat(560, 60))).toMatch(/^top-(left|right)$/);
  });
});
