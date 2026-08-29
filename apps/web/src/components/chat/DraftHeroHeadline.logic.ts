import {
  ALL_FOCUS_ID,
  sortFocuses,
  type ActiveFocusId,
} from "@spiritdevs/client-runtime/state/focuses";
import type { Focus, FocusAssignment } from "@spiritdevs/contracts/focus";

import { projectFocusSelection } from "../focus/FocusStrip.logic";

export interface ProjectPickerFocusGroup<Entry> {
  readonly focusId: ActiveFocusId;
  readonly focus: Focus | null;
  readonly entries: ReadonlyArray<Entry>;
}

export function groupProjectPickerEntriesByFocus<
  Entry extends { readonly projectKeys: ReadonlyArray<string> },
>(input: {
  readonly entries: ReadonlyArray<Entry>;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
}): ReadonlyArray<ProjectPickerFocusGroup<Entry>> {
  const orderedFocuses = sortFocuses(input.focuses);
  const focusById = new Map(orderedFocuses.map((focus) => [focus.id, focus] as const));
  const entriesByFocus = new Map<ActiveFocusId, Entry[]>();

  for (const entry of input.entries) {
    const selection = projectFocusSelection(entry.projectKeys, input.assignments);
    const focusId =
      selection !== "none" && selection !== "mixed" && focusById.has(selection)
        ? selection
        : ALL_FOCUS_ID;
    const group = entriesByFocus.get(focusId) ?? [];
    group.push(entry);
    entriesByFocus.set(focusId, group);
  }

  const groups = orderedFocuses.flatMap((focus): ProjectPickerFocusGroup<Entry>[] => {
    const entries = entriesByFocus.get(focus.id);
    return entries === undefined ? [] : [{ focusId: focus.id, focus, entries }];
  });
  const otherEntries = entriesByFocus.get(ALL_FOCUS_ID);
  if (otherEntries !== undefined) {
    groups.push({ focusId: ALL_FOCUS_ID, focus: null, entries: otherEntries });
  }
  return groups;
}
