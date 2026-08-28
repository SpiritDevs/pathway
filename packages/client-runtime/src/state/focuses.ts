import type {
  Focus,
  FocusAssignment,
  FocusId,
  FocusProjectKey,
  FocusReadModel,
} from "@spiritdevs/contracts/focus";
import { Atom } from "effect/unstable/reactivity";

import { sortBySyncOrder, syncOrderKeyAfter, syncOrderKeyBetween } from "../sync/orderKey.ts";

export const ALL_FOCUS_ID = "all" as const;
export type ActiveFocusId = FocusId | typeof ALL_FOCUS_ID;

export interface FocusSearchGroup<Result> {
  readonly focusId: ActiveFocusId;
  readonly focus: Focus | null;
  readonly results: ReadonlyArray<Result>;
}

export const focusReadModelAtom = Atom.make<FocusReadModel | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("focuses:read-model"),
);

const EMPTY_FOCUSES: ReadonlyArray<Focus> = Object.freeze([]);
const EMPTY_ASSIGNMENTS: ReadonlyArray<FocusAssignment> = Object.freeze([]);

export const focusListAtom = Atom.make(
  (get): ReadonlyArray<Focus> => get(focusReadModelAtom)?.focuses ?? EMPTY_FOCUSES,
).pipe(Atom.withLabel("focuses:list"));

export const focusAssignmentsAtom = Atom.make(
  (get): ReadonlyArray<FocusAssignment> =>
    get(focusReadModelAtom)?.assignments ?? EMPTY_ASSIGNMENTS,
).pipe(Atom.withLabel("focuses:assignments"));

export function sortFocuses(focuses: ReadonlyArray<Focus>): ReadonlyArray<Focus> {
  return sortBySyncOrder(focuses);
}

export function focusOrderKeyBetween(before: string | null, after: string | null): string | null {
  return syncOrderKeyBetween(before, after);
}

export function focusOrderKeyAfter(last: string | null): string {
  return syncOrderKeyAfter(last);
}

/** `null` is the sidebar's existing representation for an unfiltered project scope. */
export function scopedProjectKeysForFocus(
  assignments: ReadonlyArray<FocusAssignment>,
  activeFocusId: ActiveFocusId,
): ReadonlySet<FocusProjectKey> | null {
  if (activeFocusId === ALL_FOCUS_ID) return null;
  return new Set(
    assignments
      .filter((assignment) => assignment.focusId === activeFocusId)
      .map((assignment) => assignment.projectKey),
  );
}

/** A Focus hides only when its assignments all fall outside the visible projects; an empty Focus stays visible. */
export function focusIsVisible(input: {
  readonly focusId: FocusId;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  readonly visibleProjectKeys: ReadonlySet<string>;
}): boolean {
  let assigned = false;
  for (const assignment of input.assignments) {
    if (assignment.focusId !== input.focusId) continue;
    if (input.visibleProjectKeys.has(assignment.projectKey)) return true;
    assigned = true;
  }
  return !assigned;
}

export function visibleFocuses(input: {
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  readonly visibleProjectKeys: ReadonlySet<string>;
}): ReadonlyArray<Focus> {
  return sortFocuses(input.focuses).filter((focus) =>
    focusIsVisible({
      focusId: focus.id,
      assignments: input.assignments,
      visibleProjectKeys: input.visibleProjectKeys,
    }),
  );
}

export function resolveActiveFocusId(input: {
  readonly preferredId: ActiveFocusId;
  readonly focuses: ReadonlyArray<Pick<Focus, "id">>;
  readonly assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>;
  readonly visibleProjectKeys: ReadonlySet<string>;
}): ActiveFocusId {
  if (input.preferredId === ALL_FOCUS_ID) return ALL_FOCUS_ID;
  if (!input.focuses.some((focus) => focus.id === input.preferredId)) return ALL_FOCUS_ID;
  return focusIsVisible({
    focusId: input.preferredId,
    assignments: input.assignments,
    visibleProjectKeys: input.visibleProjectKeys,
  })
    ? input.preferredId
    : ALL_FOCUS_ID;
}

export function groupSearchResultsByFocus<Result>(input: {
  readonly results: ReadonlyArray<Result>;
  readonly focuses: ReadonlyArray<Focus>;
  readonly assignments: ReadonlyArray<FocusAssignment>;
  readonly activeFocusId: ActiveFocusId;
  readonly projectKey: (result: Result) => string;
}): ReadonlyArray<FocusSearchGroup<Result>> {
  const orderedFocuses = sortFocuses(input.focuses);
  const focusById = new Map(orderedFocuses.map((focus) => [focus.id, focus] as const));
  const focusIdByProject = new Map<string, FocusId>(
    input.assignments.map((assignment) => [assignment.projectKey, assignment.focusId] as const),
  );
  const resultsByFocus = new Map<ActiveFocusId, Result[]>();

  for (const result of input.results) {
    const assignedFocusId = focusIdByProject.get(input.projectKey(result));
    const focusId =
      assignedFocusId !== undefined && focusById.has(assignedFocusId)
        ? assignedFocusId
        : ALL_FOCUS_ID;
    const group = resultsByFocus.get(focusId) ?? [];
    group.push(result);
    resultsByFocus.set(focusId, group);
  }

  const focusOrder = orderedFocuses.map((focus) => focus.id);
  if (input.activeFocusId !== ALL_FOCUS_ID && focusById.has(input.activeFocusId)) {
    const activeIndex = focusOrder.indexOf(input.activeFocusId);
    focusOrder.splice(activeIndex, 1);
    focusOrder.unshift(input.activeFocusId);
  }

  const groups: FocusSearchGroup<Result>[] = [];
  for (const focusId of focusOrder) {
    const results = resultsByFocus.get(focusId);
    const focus = focusById.get(focusId);
    if (results !== undefined && focus !== undefined) groups.push({ focusId, focus, results });
  }
  const unassigned = resultsByFocus.get(ALL_FOCUS_ID);
  if (unassigned !== undefined) {
    groups.push({ focusId: ALL_FOCUS_ID, focus: null, results: unassigned });
  }
  return groups;
}
