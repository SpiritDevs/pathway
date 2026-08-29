import { focusOrderKeyBetween, sortFocuses } from "@spiritdevs/client-runtime/state/focuses";
import {
  FocusProjectKey,
  type Focus,
  type FocusAssignment,
  type FocusId,
} from "@spiritdevs/contracts/focus";

export interface FocusProjectOption {
  readonly id: string;
  readonly projectKeys: ReadonlyArray<FocusProjectKey>;
  readonly name: string;
}

export function buildFocusProjectOptions(
  groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly displayName: string;
    readonly memberProjectRefs: ReadonlyArray<{
      readonly environmentId: string;
      readonly projectId: string;
    }>;
  }>,
): ReadonlyArray<FocusProjectOption> {
  return groups
    .flatMap((group): FocusProjectOption[] => {
      const projectKeys = group.memberProjectRefs.map((projectRef) =>
        FocusProjectKey.make(`${projectRef.environmentId}:${projectRef.projectId}`),
      );
      return projectKeys.length === 0
        ? []
        : [{ id: group.projectKey, projectKeys, name: group.displayName }];
    })
    .toSorted(
      (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    );
}

export type ProjectFocusSelection = FocusId | "mixed" | "none";

export function projectFocusSelection(
  projectKeys: ReadonlyArray<string>,
  assignments: ReadonlyArray<Pick<FocusAssignment, "focusId" | "projectKey">>,
): ProjectFocusSelection {
  if (projectKeys.length === 0) return "none";
  const focusByProject = new Map<string, FocusId>(
    assignments.map((assignment) => [assignment.projectKey, assignment.focusId] as const),
  );
  const selections = new Set(projectKeys.map((projectKey) => focusByProject.get(projectKey)));
  if (selections.size !== 1) return "mixed";
  return selections.values().next().value ?? "none";
}

export function focusOrderKeyForMove(
  focuses: ReadonlyArray<Focus>,
  movedFocusId: FocusId,
  overFocusId: FocusId,
): string | null {
  const ordered = [...sortFocuses(focuses)];
  const from = ordered.findIndex((focus) => focus.id === movedFocusId);
  const to = ordered.findIndex((focus) => focus.id === overFocusId);
  if (from === -1 || to === -1 || from === to) return null;
  const [moved] = ordered.splice(from, 1);
  if (moved === undefined) return null;
  ordered.splice(to, 0, moved);
  const movedIndex = ordered.indexOf(moved);
  return focusOrderKeyBetween(
    ordered[movedIndex - 1]?.orderKey ?? null,
    ordered[movedIndex + 1]?.orderKey ?? null,
  );
}
