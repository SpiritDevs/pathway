import { describe, expect, it } from "vite-plus/test";

import { agentBrowserCursorOpacity } from "./agentBrowserCursorLogic";

describe("agentBrowserCursorOpacity", () => {
  it("keeps active movement fully visible", () => {
    expect(agentBrowserCursorOpacity(true)).toBe(1);
  });

  it("settles to a visible idle state", () => {
    expect(agentBrowserCursorOpacity(false)).toBe(0.35);
  });
});
