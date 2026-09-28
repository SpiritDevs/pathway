/**
 * A rail page dragged out of the rail. While the pointer is over the rail the drag
 * reorders the rail; once it crosses into the content the drag opens the page
 * beside the other panes instead. The rail owns the drag (dnd-kit) and writes
 * here; `PaneDropZones` reads this to draw the targets over the pane row.
 */
import { create } from "zustand";

import { canTearOutByDrag } from "./pageWindows";
import { openDestinationInWindow } from "./paneActions";
import type { PaneDestination } from "./paneDestinations";
import type { PaneEdge } from "./paneLayout";
import { isOutsideViewport, readCursorScreenPoint } from "./paneTearOut";

/** Left and right thirds open a new pane at that edge; the middle navigates the focused pane. */
export type PaneDropZone = PaneEdge | "center";

export type RailDragTarget =
  | { readonly kind: "rail" }
  | { readonly kind: "pane"; readonly zone: PaneDropZone }
  | { readonly kind: "outside" };

export interface RailDragRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Measured once when a drag starts; none of it moves while the pointer is down. */
export interface RailDragGeometry {
  readonly railRight: number;
  readonly row: RailDragRect;
  readonly viewport: { readonly width: number; readonly height: number };
}

export interface RailDragPoint {
  readonly x: number;
  readonly y: number;
}

export function resolvePaneDropZone(pointerX: number, row: RailDragRect): PaneDropZone {
  const third = row.width / 3;
  if (pointerX < row.left + third) return "left";
  if (pointerX >= row.left + row.width - third) return "right";
  return "center";
}

/** What a drop at `pointer` (viewport coordinates) would do. */
export function resolveRailDragTarget(
  pointer: RailDragPoint,
  geometry: RailDragGeometry,
): RailDragTarget {
  if (isOutsideViewport(pointer, geometry.viewport)) return { kind: "outside" };
  if (pointer.x <= geometry.railRight) return { kind: "rail" };
  return { kind: "pane", zone: resolvePaneDropZone(pointer.x, geometry.row) };
}

interface RailDragState {
  /** The page being dragged, from drag start until it drops or cancels. */
  readonly destination: PaneDestination | null;
  /** The pane row's rect while a drag that can split is in progress. */
  readonly row: RailDragRect | null;
  readonly phase: RailDragTarget["kind"];
  /** The hovered drop zone while `phase` is "pane". */
  readonly zone: PaneDropZone | null;
}

const IDLE: RailDragState = { destination: null, row: null, phase: "rail", zone: null };

export const useRailDragStore = create<RailDragState>()(() => IDLE);

export function beginRailDrag(destination: PaneDestination, row: RailDragRect | null): void {
  useRailDragStore.setState({ ...IDLE, destination, row });
}

/** Called on every pointer move; only a change of phase or zone re-renders anything. */
export function updateRailDragTarget(target: RailDragTarget): void {
  const zone = target.kind === "pane" ? target.zone : null;
  const state = useRailDragStore.getState();
  if (state.phase === target.kind && state.zone === zone) return;
  useRailDragStore.setState({ phase: target.kind, zone });
}

export function endRailDrag(): void {
  useRailDragStore.setState(IDLE);
}

/**
 * Called when a rail page is dropped outside the main window, with the pointer's
 * position on screen. On desktop it opens the page in a new window there.
 */
export function handleRailDragEndedOutsideWindow(
  destination: PaneDestination,
  screenPoint: RailDragPoint,
): void {
  if (!canTearOutByDrag) return;
  // The bridge's cursor position is in the shell's own units, unaffected by page zoom.
  void readCursorScreenPoint(screenPoint).then((point) =>
    openDestinationInWindow(destination, { screenPoint: point }),
  );
}
