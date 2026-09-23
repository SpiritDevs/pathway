import { useAtomValue } from "@effect/atom-react";
import { focusReadModelAtom } from "@spiritdevs/client-runtime/state/focuses";
import {
  FOCUS_THREAD_SORT_ORDERS,
  focusThreadSortOrder,
  type FocusThreadSortOrder,
  type FocusViewPreference,
} from "@spiritdevs/contracts/focus";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { focusMutationsAtom } from "../../cloud/focusReadModel";
import { useLocalStorage } from "../../hooks/useLocalStorage";

export { FOCUS_THREAD_SORT_ORDERS, type FocusThreadSortOrder };

export const FOCUS_THREAD_SORT_LABELS: Record<FocusThreadSortOrder, string> = {
  custom: "Custom order",
  recent_work: "Recent work",
  recent_activity: "Recent activity",
  created_at: "Date created",
  needs_attention: "Needs attention first",
  project: "Project",
};

/**
 * How one Focus (All and Conversations included) lays out its sidebar. Sort
 * and collapsibility sync per user; whether the pinned shelf is currently
 * folded is this device's view state, like the snoozed and settled shelves.
 */
export interface FocusView {
  readonly sortOrder: FocusThreadSortOrder;
  readonly collapsiblePinned: boolean;
  readonly pinnedCollapsed: boolean;
}
export type FocusViewChoices = Pick<FocusView, "sortOrder" | "collapsiblePinned">;

const PINNED_COLLAPSED_KEY = "pathway:sidebar:pinned-collapsed";
const PinnedCollapsedSchema = Schema.Record(Schema.String, Schema.Boolean);
const EMPTY_PINNED_COLLAPSED: Record<string, boolean> = {};
const EMPTY_VIEWS: ReadonlyArray<FocusViewPreference> = [];

export function resolveFocusView(
  views: ReadonlyArray<FocusViewPreference>,
  pinnedCollapsed: Readonly<Record<string, boolean>>,
  focusId: string,
): FocusView {
  const view = views.find((candidate) => candidate.focusId === focusId);
  return {
    sortOrder: focusThreadSortOrder(view?.sortOrder),
    collapsiblePinned: view?.collapsiblePinned ?? false,
    pinnedCollapsed: pinnedCollapsed[focusId] ?? false,
  };
}

export function useFocusViews() {
  const views = useAtomValue(focusReadModelAtom)?.viewPreferences ?? EMPTY_VIEWS;
  const mutations = useAtomValue(focusMutationsAtom);
  const [pinnedCollapsed, setPinnedCollapsed] = useLocalStorage(
    PINNED_COLLAPSED_KEY,
    EMPTY_PINNED_COLLAPSED,
    PinnedCollapsedSchema,
  );
  const viewFor = useCallback(
    (focusId: string) => resolveFocusView(views, pinnedCollapsed, focusId),
    [pinnedCollapsed, views],
  );
  const saveFocusView = useCallback(
    async (focusId: string, choices: FocusViewChoices) => {
      if (mutations === null) throw new Error("Sign in to Pathway Cloud to save view settings.");
      await mutations.setViewPreference({ focusId, ...choices });
    },
    [mutations],
  );
  const togglePinnedCollapsed = useCallback(
    (focusId: string) =>
      setPinnedCollapsed((current) => ({ ...current, [focusId]: !current[focusId] })),
    [setPinnedCollapsed],
  );
  return useMemo(
    () => ({ viewFor, saveFocusView, togglePinnedCollapsed, canSave: mutations !== null }),
    [mutations, saveFocusView, togglePinnedCollapsed, viewFor],
  );
}

export interface SortableSidebarThread {
  readonly id: string;
  readonly createdAt: string;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly latestRun: {
    readonly status: string;
    readonly startedAt: string | null;
    readonly completedAt: string | null;
  } | null;
}

const timestampMs = (value: string | null | undefined) => {
  const parsed = value == null ? Number.NaN : Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** Your last message, else creation. */
export const recentWorkMs = (thread: SortableSidebarThread) =>
  timestampMs(thread.latestUserMessageAt ?? thread.createdAt);

/** Latest of your last message and the last run starting or finishing. */
export const recentActivityMs = (thread: SortableSidebarThread) =>
  Math.max(
    timestampMs(thread.createdAt),
    timestampMs(thread.latestUserMessageAt),
    timestampMs(thread.latestRun?.startedAt),
    timestampMs(thread.latestRun?.completedAt),
  );

/** Approval, input, or a failed last run. */
export const threadNeedsAttention = (thread: SortableSidebarThread) =>
  thread.hasPendingApprovals || thread.hasPendingUserInput || thread.latestRun?.status === "failed";

/**
 * Custom keeps the caller's arranged order. The rest are newest first; Needs
 * attention and Project group first, then order each group by recent activity.
 */
export function sortActiveThreadsForFocus<T extends SortableSidebarThread>(
  threads: readonly T[],
  sortOrder: FocusThreadSortOrder,
  projectName: (thread: T) => string | null = () => null,
): readonly T[] {
  if (sortOrder === "custom") return threads;
  const newestFirst = (key: (thread: T) => number) => (left: T, right: T) =>
    key(right) - key(left) || left.id.localeCompare(right.id);
  switch (sortOrder) {
    case "recent_work":
      return threads.toSorted(newestFirst(recentWorkMs));
    case "created_at":
      return threads.toSorted(newestFirst((thread) => timestampMs(thread.createdAt)));
    case "recent_activity":
      return threads.toSorted(newestFirst(recentActivityMs));
    case "needs_attention":
      return threads.toSorted(
        (left, right) =>
          Number(threadNeedsAttention(right)) - Number(threadNeedsAttention(left)) ||
          newestFirst(recentActivityMs)(left, right),
      );
    case "project": {
      const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });
      return threads.toSorted((left, right) => {
        const leftName = projectName(left);
        const rightName = projectName(right);
        // Threads without a project follow the named projects.
        if (leftName !== rightName) {
          if (leftName === null) return 1;
          if (rightName === null) return -1;
          const byName = collator.compare(leftName, rightName);
          if (byName !== 0) return byName;
        }
        return newestFirst(recentActivityMs)(left, right);
      });
    }
  }
}
