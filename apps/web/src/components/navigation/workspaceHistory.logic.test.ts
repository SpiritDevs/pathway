import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createWorkspaceHistoryTracker,
  recordWorkspaceHistoryNavigation,
  workspaceHistoryLocationLabel,
  workspaceHistoryTracker,
} from "./workspaceHistory.logic";

type HistoryListener = Parameters<RouterHistory["subscribe"]>[0];
type HistoryUpdate = Parameters<HistoryListener>[0];

function location(index: number, pathname: string, search = ""): HistoryLocation {
  return {
    hash: "",
    href: `${pathname}${search}`,
    pathname,
    search,
    state: { __TSR_index: index },
  };
}

describe("workspace navigation history", () => {
  it("lists every known destination in nearest-first order", () => {
    const tracker = createWorkspaceHistoryTracker(location(0, "/threads"));

    recordWorkspaceHistoryNavigation(tracker, location(1, "/issues"), "PUSH");
    recordWorkspaceHistoryNavigation(tracker, location(2, "/settings/general"), "PUSH");
    const snapshot = recordWorkspaceHistoryNavigation(tracker, location(1, "/issues"), "BACK");

    expect(snapshot.backEntries).toEqual([{ href: "/threads", index: 0, label: "Threads" }]);
    expect(snapshot.forwardEntries).toEqual([
      { href: "/settings/general", index: 2, label: "General settings" },
    ]);
  });

  it("discards the old forward destinations after pushing from an older entry", () => {
    const tracker = createWorkspaceHistoryTracker(location(0, "/threads"));

    recordWorkspaceHistoryNavigation(tracker, location(1, "/issues"), "PUSH");
    recordWorkspaceHistoryNavigation(tracker, location(2, "/settings"), "PUSH");
    recordWorkspaceHistoryNavigation(tracker, location(1, "/issues"), "BACK");
    const snapshot = recordWorkspaceHistoryNavigation(tracker, location(2, "/calendar"), "PUSH");

    expect(snapshot.forwardEntries).toEqual([]);
    expect(snapshot.backEntries.map((entry) => entry.label)).toEqual(["Active issues", "Threads"]);
    expect(tracker.entries.get(2)?.label).toBe("Calendar");
  });

  it("keeps destinations current when a history entry is replaced", () => {
    const tracker = createWorkspaceHistoryTracker(location(0, "/issues"));

    recordWorkspaceHistoryNavigation(tracker, location(0, "/issues", "?tab=all"), "REPLACE");
    const snapshot = recordWorkspaceHistoryNavigation(tracker, location(1, "/settings"), "PUSH");

    expect(snapshot.backEntries).toEqual([
      { href: "/issues?tab=all", index: 0, label: "All issues" },
    ]);
  });

  it("tracks navigation while no controls are subscribed", () => {
    let onHistoryChange: HistoryListener | undefined;
    const subscribe = vi.fn((listener: HistoryListener) => {
      onHistoryChange = listener;
      return () => {};
    });
    const navigate = (index: number, pathname: string, type: "PUSH" | "BACK") => {
      onHistoryChange?.({ location: location(index, pathname), action: { type } } as HistoryUpdate);
    };
    const history = {
      location: location(0, "/threads"),
      subscribe,
    } as unknown as RouterHistory;
    const tracker = workspaceHistoryTracker(history);

    navigate(1, "/issues", "PUSH");
    navigate(0, "/threads", "BACK");

    expect(tracker.getSnapshot().forwardEntries.map((entry) => entry.label)).toEqual([
      "Active issues",
    ]);
    expect(workspaceHistoryTracker(history)).toBe(tracker);
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("provides readable labels for dynamic workspace routes", () => {
    expect(workspaceHistoryLocationLabel(location(0, "/issues", "?issue=ISS-35"))).toBe(
      "Issue ISS-35",
    );
    expect(workspaceHistoryLocationLabel(location(0, "/issues", "?triage=true"))).toBe(
      "Issue triage",
    );
    expect(workspaceHistoryLocationLabel(location(0, "/projects/pathway"))).toBe("Project pathway");
    expect(workspaceHistoryLocationLabel(location(0, "/threads/local/thread-123"))).toBe(
      "Thread thread-123",
    );
  });
});
