/**
 * The split-pane layout of one window: rail pages placed side by side, left to right.
 *
 * Exactly one pane is the primary pane. It renders the app router's own outlet and
 * owns the URL, so its `href` here is always empty. Every other pane stores the
 * location its private router is showing. Pure functions only; the store in
 * `paneStore.ts` applies them.
 */

export const PRIMARY_PANE_ID = "primary";

/** Narrowest a pane may render. How many panes fit side by side follows from it. */
export const MIN_PANE_WIDTH = 360;

export interface PaneEntry {
  readonly id: string;
  /** Location of a side pane's router. Empty for the primary pane. */
  readonly href: string;
  /** Share of the row, relative to the other panes' weights. */
  readonly weight: number;
}

export interface PaneLayout {
  readonly panes: readonly PaneEntry[];
  readonly focusedPaneId: string;
}

export type PaneEdge = "left" | "right";

export const SINGLE_PANE_LAYOUT: PaneLayout = {
  panes: [{ id: PRIMARY_PANE_ID, href: "", weight: 1 }],
  focusedPaneId: PRIMARY_PANE_ID,
};

export function isSplit(layout: PaneLayout): boolean {
  return layout.panes.length > 1;
}

/** Opens a page as a new pane at one edge of the row and focuses it. It takes an equal share. */
export function openPane(
  layout: PaneLayout,
  pane: { readonly id: string; readonly href: string; readonly edge: PaneEdge },
): PaneLayout {
  const totalWeight = layout.panes.reduce((total, entry) => total + entry.weight, 0);
  const entry: PaneEntry = {
    id: pane.id,
    href: pane.href,
    weight: totalWeight / layout.panes.length,
  };
  return {
    panes: pane.edge === "left" ? [entry, ...layout.panes] : [...layout.panes, entry],
    focusedPaneId: pane.id,
  };
}

/**
 * Where splitting the focused pane opens its copy: the right edge when the
 * focused pane is last in the row, otherwise the left edge.
 */
export function splitEdge(layout: PaneLayout): PaneEdge {
  const last = layout.panes[layout.panes.length - 1];
  return last === undefined || last.id === layout.focusedPaneId ? "right" : "left";
}

export interface ClosePaneResult {
  readonly layout: PaneLayout;
  /**
   * Set when the primary pane closed: the neighbour that took its place, whose
   * location the app router must now show.
   */
  readonly promotedHref: string | null;
}

/**
 * Closes a pane. Closing the primary pane promotes its nearest neighbour, which
 * keeps its position and hands its location to the app router. Focus moves to
 * whichever pane now sits where the closed one was.
 */
export function closePane(layout: PaneLayout, paneId: string): ClosePaneResult {
  const index = layout.panes.findIndex((entry) => entry.id === paneId);
  if (index < 0 || layout.panes.length === 1) {
    return { layout, promotedHref: null };
  }

  const neighbourIndex = index > 0 ? index - 1 : index + 1;
  const neighbour = layout.panes[neighbourIndex]!;
  const closingPrimary = paneId === PRIMARY_PANE_ID;
  const replacement: PaneEntry = closingPrimary
    ? { id: PRIMARY_PANE_ID, href: "", weight: neighbour.weight }
    : neighbour;
  const panes = layout.panes.flatMap((entry, entryIndex) => {
    if (entryIndex === index) return [];
    if (entryIndex === neighbourIndex) return [replacement];
    return [entry];
  });
  const focusedPaneId =
    layout.focusedPaneId === paneId || (closingPrimary && layout.focusedPaneId === neighbour.id)
      ? replacement.id
      : layout.focusedPaneId;

  return {
    layout: { panes, focusedPaneId },
    promotedHref: closingPrimary ? neighbour.href : null,
  };
}

/** Closes every pane except the primary one. */
export function closeSidePanes(layout: PaneLayout): PaneLayout {
  return isSplit(layout) ? SINGLE_PANE_LAYOUT : layout;
}

/**
 * Swaps a pane with its right-hand neighbour, or its left-hand one when it is
 * already last. With two panes this is a plain flip.
 */
export function flipPane(layout: PaneLayout, paneId: string): PaneLayout {
  const index = layout.panes.findIndex((entry) => entry.id === paneId);
  if (index < 0 || layout.panes.length === 1) return layout;
  const otherIndex = index < layout.panes.length - 1 ? index + 1 : index - 1;
  const panes = [...layout.panes];
  [panes[index], panes[otherIndex]] = [panes[otherIndex]!, panes[index]!];
  return { ...layout, panes };
}

export function focusPane(layout: PaneLayout, paneId: string): PaneLayout {
  if (layout.focusedPaneId === paneId) return layout;
  if (!layout.panes.some((entry) => entry.id === paneId)) return layout;
  return { ...layout, focusedPaneId: paneId };
}

/** Moves focus to the next pane in a direction, stopping at the ends. */
export function focusAdjacentPane(layout: PaneLayout, direction: PaneEdge): PaneLayout {
  const index = layout.panes.findIndex((entry) => entry.id === layout.focusedPaneId);
  const next = layout.panes[direction === "left" ? index - 1 : index + 1];
  return next ? focusPane(layout, next.id) : layout;
}

export function setPaneHref(layout: PaneLayout, paneId: string, href: string): PaneLayout {
  if (paneId === PRIMARY_PANE_ID) return layout;
  let changed = false;
  const panes = layout.panes.map((entry) => {
    if (entry.id !== paneId || entry.href === href) return entry;
    changed = true;
    return { ...entry, href };
  });
  return changed ? { ...layout, panes } : layout;
}

/**
 * Moves the divider to the right of `leftIndex` so the pane on its left spans
 * `leftFraction` of the width the two panes share. Both stay at least
 * `minFraction` of that width.
 */
export function resizeAtDivider(
  layout: PaneLayout,
  leftIndex: number,
  leftFraction: number,
  minFraction: number,
): PaneLayout {
  const left = layout.panes[leftIndex];
  const right = layout.panes[leftIndex + 1];
  if (!left || !right) return layout;
  const pairWeight = left.weight + right.weight;
  const clamped = Math.min(Math.max(leftFraction, minFraction), 1 - minFraction);
  const panes = [...layout.panes];
  panes[leftIndex] = { ...left, weight: pairWeight * clamped };
  panes[leftIndex + 1] = { ...right, weight: pairWeight * (1 - clamped) };
  return { ...layout, panes };
}

export function equalizePanes(layout: PaneLayout): PaneLayout {
  if (layout.panes.every((entry) => entry.weight === 1)) return layout;
  return { ...layout, panes: layout.panes.map((entry) => ({ ...entry, weight: 1 })) };
}

/** How many panes fit side by side in a row this wide. Never less than one. */
export function paneCapacity(rowWidth: number): number {
  return Math.max(1, Math.floor(rowWidth / MIN_PANE_WIDTH));
}

export interface VisiblePanes {
  readonly visible: readonly PaneEntry[];
  /** Panes that do not fit, shown as edge tabs on the side they sit. */
  readonly collapsedLeft: readonly PaneEntry[];
  readonly collapsedRight: readonly PaneEntry[];
}

/**
 * The run of panes that fits the row, centred on the focused pane where the ends allow.
 * Panes outside it collapse to edge tabs rather than closing.
 */
export function resolveVisiblePanes(layout: PaneLayout, capacity: number): VisiblePanes {
  const count = layout.panes.length;
  if (capacity >= count) {
    return { visible: layout.panes, collapsedLeft: [], collapsedRight: [] };
  }
  const focusedIndex = Math.max(
    0,
    layout.panes.findIndex((entry) => entry.id === layout.focusedPaneId),
  );
  const start = Math.min(Math.max(focusedIndex - Math.floor(capacity / 2), 0), count - capacity);
  return {
    visible: layout.panes.slice(start, start + capacity),
    collapsedLeft: layout.panes.slice(0, start),
    collapsedRight: layout.panes.slice(start + capacity),
  };
}

/** Drops anything a stored layout could carry that the current model does not allow. */
export function normalizePaneLayout(layout: PaneLayout | null | undefined): PaneLayout {
  if (!layout || !Array.isArray(layout.panes)) return SINGLE_PANE_LAYOUT;
  const seen = new Set<string>();
  const panes = layout.panes.flatMap((entry): PaneEntry[] => {
    if (!entry || typeof entry.id !== "string" || seen.has(entry.id)) return [];
    seen.add(entry.id);
    const isPrimary = entry.id === PRIMARY_PANE_ID;
    if (!isPrimary && (typeof entry.href !== "string" || !entry.href.startsWith("/"))) return [];
    const weight = Number.isFinite(entry.weight) && entry.weight > 0 ? entry.weight : 1;
    return [{ id: entry.id, href: isPrimary ? "" : entry.href, weight }];
  });
  if (!seen.has(PRIMARY_PANE_ID)) return SINGLE_PANE_LAYOUT;
  const focusedPaneId = panes.some((entry) => entry.id === layout.focusedPaneId)
    ? layout.focusedPaneId
    : PRIMARY_PANE_ID;
  return { panes, focusedPaneId };
}
