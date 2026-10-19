import { describe, expect, it } from "vite-plus/test";

import { resolveTerminalCardHostSelector } from "./TerminalCardPortal";

describe("resolveTerminalCardHostSelector", () => {
  it("keeps the terminal in the primary column by default", () => {
    expect(resolveTerminalCardHostSelector(false)).toBe("[data-terminal-card-host]");
  });

  it("moves the terminal below the full workspace in full-width mode", () => {
    expect(resolveTerminalCardHostSelector(true)).toBe("[data-terminal-full-width-host]");
  });
});
