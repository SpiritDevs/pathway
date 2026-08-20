export const COMPANY_ASSIGNMENT_BATCH_LIMIT = 500;

export type AssignmentFilter = "all" | "selected" | "unselected";
export type AssignmentStatusFilter = "all" | "active" | "locked" | "left";

export interface CompanyAssignmentPickerItem<Id extends string = string> {
  readonly id: Id;
  readonly primaryLabel: string;
  readonly secondaryLabel?: string | undefined;
  readonly searchableText: string;
  readonly status?: Exclude<AssignmentStatusFilter, "all"> | "archived" | undefined;
  readonly statusLabel?: string | undefined;
  readonly selected: boolean;
  readonly mayAdd: boolean;
  readonly mayRemove: boolean;
  readonly disabledReason?: string | undefined;
}

export function normalizeAssignmentSearch(value: string): string {
  return value.toLocaleLowerCase().trim().replace(/\s+/g, " ");
}

export function matchesAssignmentSearch(searchableText: string, query: string): boolean {
  const tokens = normalizeAssignmentSearch(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeAssignmentSearch(searchableText);
  return tokens.every((token) => haystack.includes(token));
}

export function filterAssignmentItems<Id extends string>(
  items: ReadonlyArray<CompanyAssignmentPickerItem<Id>>,
  input: {
    readonly query: string;
    readonly assignment: AssignmentFilter;
    readonly status?: AssignmentStatusFilter;
  },
): ReadonlyArray<CompanyAssignmentPickerItem<Id>> {
  return items.filter((item) => {
    if (!matchesAssignmentSearch(item.searchableText, input.query)) return false;
    if (input.assignment === "selected" && !item.selected) return false;
    if (input.assignment === "unselected" && item.selected) return false;
    if (input.status !== undefined && input.status !== "all" && item.status !== input.status) {
      return false;
    }
    return true;
  });
}

export function assignmentSelectionSummary<Id extends string>(
  allItems: ReadonlyArray<CompanyAssignmentPickerItem<Id>>,
  visibleItems: ReadonlyArray<CompanyAssignmentPickerItem<Id>>,
) {
  const selected = allItems.reduce((count, item) => count + Number(item.selected), 0);
  const visibleSelected = visibleItems.reduce((count, item) => count + Number(item.selected), 0);
  const addIds = visibleItems
    .filter((item) => !item.selected && item.mayAdd)
    .map((item) => item.id);
  const removeIds = visibleItems
    .filter((item) => item.selected && item.mayRemove)
    .map((item) => item.id);
  return {
    total: allItems.length,
    visible: visibleItems.length,
    selected,
    visibleSelected,
    addIds,
    removeIds,
    addOverLimit: addIds.length > COMPANY_ASSIGNMENT_BATCH_LIMIT,
    removeOverLimit: removeIds.length > COMPANY_ASSIGNMENT_BATCH_LIMIT,
  };
}

export function applyVisibleAssignmentDelta<Id extends string>(
  selectedIds: ReadonlySet<Id>,
  input: { readonly addIds: ReadonlyArray<Id>; readonly removeIds: ReadonlyArray<Id> },
): ReadonlySet<Id> {
  const next = new Set(selectedIds);
  for (const id of input.addIds) next.add(id);
  for (const id of input.removeIds) next.delete(id);
  return next;
}
