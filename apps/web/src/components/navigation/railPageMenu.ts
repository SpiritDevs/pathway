/**
 * The rail's right-click menu for a page: open it in a pane or window, close the
 * panes and windows already showing it, and move it within the rail.
 */
import type { ContextMenuItem } from "@spiritdevs/contracts";

import type { PaneDestination } from "../../panes/paneDestinations";
import type { PageWindow } from "../../panes/pageWindows";
import { resolvePrimaryNavigationDestination } from "./PrimaryNavigationRail";

export type RailPageMenuAction =
  | "open-left"
  | "open-right"
  | "open-window"
  | "close-pane-menu"
  | `close-pane:${string}`
  | "close-window-menu"
  | `close-window:${string}`
  | "close-all-panes"
  | "close-all-windows"
  | "move-up"
  | "move-down";

export interface RailPagePlacement {
  readonly id: string;
  readonly label: string;
}

export interface RailPageMenuInput {
  readonly canOpenWindows: boolean;
  readonly split: boolean;
  /** Panes showing this page, left to right. */
  readonly panes: readonly RailPagePlacement[];
  /** Page windows showing this page. */
  readonly windows: readonly RailPagePlacement[];
  readonly anyWindows: boolean;
  /** Only pages the rail lets you reorder can move. */
  readonly move: { readonly canMoveUp: boolean; readonly canMoveDown: boolean } | null;
}

type MenuItem = ContextMenuItem<RailPageMenuAction>;

export function buildRailPageMenu(input: RailPageMenuInput): readonly MenuItem[] {
  const open: MenuItem[] = [
    { id: "open-left", label: "Open in left panel" },
    { id: "open-right", label: "Open in right panel" },
  ];
  if (input.canOpenWindows) open.push({ id: "open-window", label: "Open in new window" });

  const close: MenuItem[] = [];
  const closePane = closeItem("Close panel", "close-pane-menu", "close-pane", input.panes);
  if (closePane) close.push(closePane);
  const closeWindow = closeItem("Close window", "close-window-menu", "close-window", input.windows);
  if (closeWindow) close.push(closeWindow);
  if (input.split) close.push({ id: "close-all-panes", label: "Close all panels" });
  if (input.anyWindows) close.push({ id: "close-all-windows", label: "Close all windows" });

  const move: MenuItem[] = input.move
    ? [
        { id: "move-up", label: "Move up", disabled: !input.move.canMoveUp },
        { id: "move-down", label: "Move down", disabled: !input.move.canMoveDown },
      ]
    : [];

  const groups = [open, close, move].filter((group) => group.length > 0);
  return groups.flatMap((group, groupIndex) =>
    groupIndex === groups.length - 1
      ? group
      : [...group.slice(0, -1), { ...group[group.length - 1]!, separatorAfter: true }],
  );
}

/** One item when a single pane or window matches; a submenu naming each when several do. */
function closeItem(
  label: string,
  menuId: "close-pane-menu" | "close-window-menu",
  prefix: "close-pane" | "close-window",
  placements: readonly RailPagePlacement[],
): MenuItem | null {
  const [only] = placements;
  if (!only) return null;
  if (placements.length === 1) return { id: `${prefix}:${only.id}`, label };
  return {
    id: menuId,
    label,
    children: placements.map((placement) => ({
      id: `${prefix}:${placement.id}`,
      label: placement.label,
    })),
  };
}

/** A pane's place in the row, as the close submenu names it. */
export function describePanePosition(index: number, count: number): string {
  if (count === 2) return index === 0 ? "Left" : "Right";
  if (count === 3) return ["Left", "Middle", "Right"][index]!;
  return `Panel ${index + 1}`;
}

export function resolveHrefDestination(href: string) {
  return resolvePrimaryNavigationDestination(href.split(/[?#]/, 1)[0] || "/");
}

/** Panes showing `destination`, labelled by position. Only a split row has panes to close. */
export function findPanesShowing(
  destination: PaneDestination,
  panes: readonly { readonly id: string; readonly href: string | null }[],
): readonly RailPagePlacement[] {
  if (panes.length < 2) return [];
  return panes.flatMap((pane, index) =>
    pane.href !== null && resolveHrefDestination(pane.href) === destination
      ? [{ id: pane.id, label: describePanePosition(index, panes.length) }]
      : [],
  );
}

/** Windows showing `destination`. Windows that share a title are numbered apart. */
export function findWindowsShowing(
  destination: PaneDestination,
  windows: readonly PageWindow[],
): readonly RailPagePlacement[] {
  const matching = windows.filter((entry) => resolveHrefDestination(entry.href) === destination);
  const titleCounts = new Map<string, number>();
  for (const entry of matching) {
    titleCounts.set(entry.title, (titleCounts.get(entry.title) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return matching.map((entry) => {
    if (titleCounts.get(entry.title) === 1) return { id: entry.id, label: entry.title };
    const ordinal = (seen.get(entry.title) ?? 0) + 1;
    seen.set(entry.title, ordinal);
    return { id: entry.id, label: `${entry.title} (${ordinal})` };
  });
}
