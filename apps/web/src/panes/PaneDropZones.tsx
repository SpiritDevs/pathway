import { createPortal } from "react-dom";

import { cn } from "../lib/utils";
import { useRailDragStore } from "./railDrag";

/**
 * Drop targets over the pane row while a rail page is being dragged out of the
 * rail: the left and right thirds open a new pane at that edge. The middle third
 * has no target; dropping there opens the page in the focused pane, as a click does.
 *
 * Mounted for the whole drag so it can fade in when the pointer leaves the rail.
 * Drawn fixed over the row's rect, measured at drag start, from a portal so no
 * pane's clipping or stacking can hide it.
 */
export function PaneDropZones() {
  const row = useRailDragStore((state) => state.row);
  const visible = useRailDragStore((state) => state.phase === "pane");
  const zone = useRailDragStore((state) => state.zone);
  if (!row) return null;

  return createPortal(
    <div
      aria-hidden="true"
      className={cn(
        "fixed z-50 grid grid-cols-3 gap-2 p-2 transition-opacity duration-150 motion-reduce:transition-none",
        visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      )}
      style={{ left: row.left, top: row.top, width: row.width, height: row.height }}
    >
      <DropZone highlighted={zone === "left"} label="Open on left" />
      <div />
      <DropZone highlighted={zone === "right"} label="Open on right" />
    </div>,
    document.body,
  );
}

function DropZone({ highlighted, label }: { highlighted: boolean; label: string }) {
  return (
    <div className="relative flex items-center justify-center overflow-hidden rounded-xl border border-dashed border-primary/40 bg-primary/5">
      <div
        className={cn(
          "absolute inset-0 bg-primary/15 transition-opacity duration-150 motion-reduce:transition-none",
          highlighted ? "opacity-100" : "opacity-0",
        )}
      />
      <span className="relative rounded-md bg-background/80 px-2 py-1 text-sm font-medium text-foreground shadow-sm">
        {label}
      </span>
    </div>
  );
}
