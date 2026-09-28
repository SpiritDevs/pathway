import type { MouseEvent as ReactMouseEvent } from "react";

import type { ResizableWidthHandlers } from "~/hooks/useResizableWidth";
import { cn } from "~/lib/utils";

interface Props {
  handlers: ResizableWidthHandlers;
  /** Clamps and persists a width; the hook's `resizeTo`. */
  resizeTo: (width: number) => void;
  className?: string;
}

/** The `gap-2` gutter between the main content and the right panel. */
const RIGHT_PANEL_GUTTER_WIDTH = 8;

/** Panel width that splits the workspace row evenly with the main content. */
export function getRightPanelSplitWidth(rowWidth: number): number {
  return Math.floor((rowWidth - RIGHT_PANEL_GUTTER_WIDTH) / 2);
}

/**
 * Hit target for resizing a right-anchored panel via its left edge.
 *
 * - Fills the 8px gutter to the panel's left so the user can grab the whole
 *   gap without aiming.
 * - Visual indicator is a 1px line that lights up on hover/active to mirror
 *   VS Code / Cursor. A 1px optical correction centers it between the two
 *   rendered border strokes rather than the panel border boxes.
 * - Double-click resets the panel to half of the workspace row. Sheets are
 *   portalled outside the row, so they fall back to the document's row.
 */
export function RightPanelResizeHandle({ handlers, resizeTo, className }: Props) {
  const onDoubleClick = (event: ReactMouseEvent<HTMLElement>) => {
    // In a split window the panel shares its pane, not the whole row.
    const selector = "[data-pane-frame], [data-app-workspace-main-row]";
    const row =
      event.currentTarget.closest<HTMLElement>(selector) ??
      document.querySelector<HTMLElement>("[data-app-workspace-main-row]");
    if (!row) return;
    resizeTo(getRightPanelSplitWidth(row.clientWidth));
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        "group absolute inset-y-0 -left-2 z-20 w-2 cursor-col-resize select-none",
        className,
      )}
      onDoubleClick={onDoubleClick}
      {...handlers}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-[calc(50%-1px)] w-px -translate-x-1/2 bg-transparent transition-colors duration-150 group-hover:bg-border group-active:bg-primary/60"
      />
    </div>
  );
}
