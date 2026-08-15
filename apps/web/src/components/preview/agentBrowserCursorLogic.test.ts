import { describe, expect, it } from "vite-plus/test";

import { agentBrowserCursorGlidePosition } from "./agentBrowserCursorLogic";

describe("agentBrowserCursorGlidePosition", () => {
  it("scales guest coordinates by zoom and presentation scale", () => {
    expect(agentBrowserCursorGlidePosition({ x: 100, y: 40 }, 2, 0.5)).toEqual({ x: 100, y: 40 });
  });

  it("passes coordinates through at unit zoom and scale", () => {
    expect(agentBrowserCursorGlidePosition({ x: 30, y: 20 }, 1, 1)).toEqual({ x: 30, y: 20 });
  });
});
