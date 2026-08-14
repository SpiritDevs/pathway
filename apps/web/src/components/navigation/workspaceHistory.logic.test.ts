import { describe, expect, it } from "vite-plus/test";

import {
  createForwardHistoryTracker,
  recordForwardHistoryNavigation,
} from "./workspaceHistory.logic";

describe("workspace forward history", () => {
  it("keeps forward navigation available when controls remount after Back", () => {
    const tracker = createForwardHistoryTracker(0);

    expect(recordForwardHistoryNavigation(tracker, 1, "PUSH")).toBe(false);
    expect(recordForwardHistoryNavigation(tracker, 0, "BACK")).toBe(true);
    expect(recordForwardHistoryNavigation(tracker, 0)).toBe(true);
    expect(recordForwardHistoryNavigation(tracker, 1, "FORWARD")).toBe(false);
  });

  it("discards the old forward range after pushing from a previous entry", () => {
    const tracker = createForwardHistoryTracker(0);

    recordForwardHistoryNavigation(tracker, 1, "PUSH");
    recordForwardHistoryNavigation(tracker, 2, "PUSH");
    expect(recordForwardHistoryNavigation(tracker, 1, "BACK")).toBe(true);
    expect(recordForwardHistoryNavigation(tracker, 2, "PUSH")).toBe(false);
  });
});
