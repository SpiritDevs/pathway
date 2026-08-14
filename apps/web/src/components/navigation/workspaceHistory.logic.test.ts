import type { RouterHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createForwardHistoryTracker,
  forwardHistoryTracker,
  recordForwardHistoryNavigation,
} from "./workspaceHistory.logic";

type HistoryListener = Parameters<RouterHistory["subscribe"]>[0];
type HistoryUpdate = Parameters<HistoryListener>[0];

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

  it("tracks pushes while no controls are subscribed", () => {
    let onHistoryChange: HistoryListener | undefined;
    const subscribe = vi.fn((listener: HistoryListener) => {
      onHistoryChange = listener;
      return () => {};
    });
    const navigate = (index: number, type: "PUSH" | "BACK") => {
      onHistoryChange?.({
        location: { state: { __TSR_index: index } },
        action: { type },
      } as HistoryUpdate);
    };
    const history = {
      location: { state: { __TSR_index: 0 } },
      subscribe,
    } as unknown as RouterHistory;
    const tracker = forwardHistoryTracker(history);

    navigate(1, "PUSH");
    navigate(0, "BACK");
    expect(tracker.getSnapshot()).toBe(true);

    navigate(1, "PUSH");

    expect(tracker.getSnapshot()).toBe(false);
    expect(forwardHistoryTracker(history)).toBe(tracker);
    expect(subscribe).toHaveBeenCalledOnce();
  });
});
