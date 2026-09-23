import { describe, expect, it } from "vite-plus/test";

import {
  resolveFocusView,
  sortActiveThreadsForFocus,
  type SortableSidebarThread,
} from "./focusViewPreferences";

const thread = (
  id: string,
  createdAt: string,
  fields: Partial<SortableSidebarThread> & { project?: string | null } = {},
) => ({
  id,
  createdAt,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  latestRun: null,
  project: null,
  ...fields,
});

const ids = (threads: readonly { id: string }[]) => threads.map((item) => item.id);

describe("focus view preferences", () => {
  it("defaults to custom order, reads synced choices, and keeps collapse local", () => {
    expect(resolveFocusView([], {}, "all")).toEqual({
      sortOrder: "custom",
      collapsiblePinned: false,
      pinnedCollapsed: false,
    });
    const synced = [
      { focusId: "all", sortOrder: "project", collapsiblePinned: true, updatedAt: 1 },
      { focusId: "work", sortOrder: "from-a-newer-client", collapsiblePinned: false, updatedAt: 1 },
    ];
    expect(resolveFocusView(synced, { all: true }, "all")).toEqual({
      sortOrder: "project",
      collapsiblePinned: true,
      pinnedCollapsed: true,
    });
    expect(resolveFocusView(synced, {}, "work").sortOrder).toBe("custom");
  });

  it("orders by creation, your last message, and latest activity", () => {
    const threads = [
      thread("old", "2026-09-01T00:00:00Z", { latestUserMessageAt: "2026-09-20T00:00:00Z" }),
      thread("new", "2026-09-10T00:00:00Z"),
      thread("ran", "2026-09-05T00:00:00Z", {
        latestRun: { status: "completed", startedAt: null, completedAt: "2026-09-21T00:00:00Z" },
      }),
    ];
    expect(ids(sortActiveThreadsForFocus(threads, "custom"))).toEqual(["old", "new", "ran"]);
    expect(ids(sortActiveThreadsForFocus(threads, "created_at"))).toEqual(["new", "ran", "old"]);
    expect(ids(sortActiveThreadsForFocus(threads, "recent_work"))).toEqual(["old", "new", "ran"]);
    expect(ids(sortActiveThreadsForFocus(threads, "recent_activity"))).toEqual([
      "ran",
      "old",
      "new",
    ]);
  });

  it("puts threads needing attention first and groups by project name", () => {
    const threads = [
      thread("quiet", "2026-09-10T00:00:00Z", { project: "beta" }),
      thread("failed", "2026-09-01T00:00:00Z", {
        project: "Alpha",
        latestRun: { status: "failed", startedAt: null, completedAt: null },
      }),
      thread("input", "2026-09-02T00:00:00Z", { hasPendingUserInput: true }),
    ];
    expect(ids(sortActiveThreadsForFocus(threads, "needs_attention"))).toEqual([
      "input",
      "failed",
      "quiet",
    ]);
    expect(
      ids(sortActiveThreadsForFocus(threads, "project", (item) => item.project ?? null)),
    ).toEqual(["failed", "quiet", "input"]);
  });
});
