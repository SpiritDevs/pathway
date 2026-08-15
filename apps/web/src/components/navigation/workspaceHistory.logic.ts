import type { HistoryLocation, RouterHistory } from "@tanstack/react-router";

type HistoryAction = "PUSH" | "REPLACE" | "FORWARD" | "BACK" | "GO";

export type WorkspaceHistoryEntry = {
  readonly href: string | null;
  readonly index: number;
  readonly label: string;
};

export type WorkspaceHistorySnapshot = {
  readonly backEntries: ReadonlyArray<WorkspaceHistoryEntry>;
  readonly forwardEntries: ReadonlyArray<WorkspaceHistoryEntry>;
  readonly index: number;
};

export type WorkspaceHistoryTracker = {
  furthestIndex: number;
  index: number;
  readonly entries: Map<number, WorkspaceHistoryEntry>;
  snapshot: WorkspaceHistorySnapshot;
  getSnapshot: () => WorkspaceHistorySnapshot;
  subscribe: (listener: () => void) => () => void;
};

const trackerListeners = new WeakMap<WorkspaceHistoryTracker, Set<() => void>>();

const ROUTE_LABELS: Readonly<Record<string, string>> = {
  "/": "Home",
  "/calendar": "Calendar",
  "/dashboard": "Dashboard",
  "/email": "Email",
  "/issues": "Issues",
  "/issues/milestones": "Milestones",
  "/orchestrator": "Agent",
  "/pull-requests": "Pull requests",
  "/settings": "Settings",
  "/settings/appearance": "Appearance settings",
  "/settings/appearance/action-palette": "Action palette settings",
  "/settings/archived": "Archived threads",
  "/settings/connections": "Connection settings",
  "/settings/diagnostics": "Diagnostics settings",
  "/settings/email": "Email settings",
  "/settings/general": "General settings",
  "/settings/issues-enrichment": "Issue enrichment settings",
  "/settings/issues-import": "Issue import settings",
  "/settings/issues-intake": "Issue intake settings",
  "/settings/issues-labels": "Issue label settings",
  "/settings/issues-milestones": "Issue milestone settings",
  "/settings/issues-statuses": "Issue status settings",
  "/settings/keybindings": "Keybinding settings",
  "/settings/projects": "Project settings",
  "/settings/providers": "Provider settings",
  "/settings/scheduled-tasks": "Scheduled tasks",
  "/settings/source-control": "Source control settings",
  "/settings/usage": "Usage settings",
  "/threads": "Threads",
  "/usage": "Usage",
};

function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function workspaceHistoryLocationLabel(
  location: Pick<HistoryLocation, "pathname" | "search">,
): string {
  const pathname = location.pathname.replace(/\/+$/, "") || "/";
  const search = new URLSearchParams(location.search);

  if (pathname === "/issues") {
    const issueKey = search.get("issue")?.trim();
    if (issueKey) return `Issue ${issueKey}`;
    if (search.get("triage") === "true") return "Issue triage";
    const tab = search.get("tab");
    if (tab === "backlog") return "Backlog issues";
    if (tab === "all") return "All issues";
    return "Active issues";
  }

  const staticLabel = ROUTE_LABELS[pathname];
  if (staticLabel !== undefined) return staticLabel;

  const segments = pathname.split("/").filter(Boolean).map(decodePathSegment);
  if (segments[0] === "threads" && segments.length >= 3) {
    return `Thread ${segments.at(-1)}`;
  }
  if (segments[0] === "draft" || (segments[0] === "threads" && segments[1] === "draft")) {
    return "New thread";
  }
  if (segments[0] === "issues" && segments[1] === "milestones" && segments[2]) {
    return `Milestone ${segments[2]}`;
  }
  if (segments[0] === "projects" && segments[1]) {
    return `Project ${segments[1]}`;
  }
  if (segments[0] === "settings" && segments[1] === "projects" && segments[2]) {
    return `Project settings · ${segments[2]}`;
  }

  return segments.length === 0
    ? "Home"
    : segments.map((part) => part.replaceAll("-", " ")).join(" · ");
}

function placeholderEntry(index: number, distance: number): WorkspaceHistoryEntry {
  return {
    href: null,
    index,
    label: distance === 1 ? "Previous view" : `${distance} views back`,
  };
}

function snapshotFor(tracker: WorkspaceHistoryTracker): WorkspaceHistorySnapshot {
  const backEntries: Array<WorkspaceHistoryEntry> = [];
  for (let index = tracker.index - 1; index >= 0; index -= 1) {
    backEntries.push(tracker.entries.get(index) ?? placeholderEntry(index, tracker.index - index));
  }

  const forwardEntries: Array<WorkspaceHistoryEntry> = [];
  for (let index = tracker.index + 1; index <= tracker.furthestIndex; index += 1) {
    const entry = tracker.entries.get(index);
    if (entry !== undefined) forwardEntries.push(entry);
  }

  return { backEntries, forwardEntries, index: tracker.index };
}

function entryFromLocation(location: HistoryLocation): WorkspaceHistoryEntry {
  return {
    href: location.href,
    index: location.state.__TSR_index,
    label: workspaceHistoryLocationLabel(location),
  };
}

export function createWorkspaceHistoryTracker(location: HistoryLocation): WorkspaceHistoryTracker {
  const listeners = new Set<() => void>();
  const index = location.state.__TSR_index;
  const entries = new Map([[index, entryFromLocation(location)]]);
  const tracker: WorkspaceHistoryTracker = {
    entries,
    furthestIndex: index,
    index,
    snapshot: { backEntries: [], forwardEntries: [], index },
    getSnapshot: () => tracker.snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  tracker.snapshot = snapshotFor(tracker);
  trackerListeners.set(tracker, listeners);
  return tracker;
}

export function recordWorkspaceHistoryNavigation(
  tracker: WorkspaceHistoryTracker,
  location: HistoryLocation,
  action?: HistoryAction,
): WorkspaceHistorySnapshot {
  const index = location.state.__TSR_index;
  if (action === "PUSH") {
    tracker.furthestIndex = index;
    for (const entryIndex of tracker.entries.keys()) {
      if (entryIndex > index) tracker.entries.delete(entryIndex);
    }
  } else {
    tracker.furthestIndex = Math.max(tracker.furthestIndex, index);
  }
  tracker.index = index;
  tracker.entries.set(index, entryFromLocation(location));
  tracker.snapshot = snapshotFor(tracker);
  for (const listener of trackerListeners.get(tracker) ?? []) listener();
  return tracker.snapshot;
}

const workspaceHistoryTrackers = new WeakMap<RouterHistory, WorkspaceHistoryTracker>();

export function workspaceHistoryTracker(history: RouterHistory): WorkspaceHistoryTracker {
  const existing = workspaceHistoryTrackers.get(history);
  if (existing) return existing;

  const tracker = createWorkspaceHistoryTracker(history.location);
  workspaceHistoryTrackers.set(history, tracker);
  // Share the history instance's lifetime so pushes on routes without workspace controls still
  // discard the forward range and every visited destination remains available after a remount.
  history.subscribe(({ location, action }) => {
    recordWorkspaceHistoryNavigation(tracker, location, action.type);
  });
  return tracker;
}
