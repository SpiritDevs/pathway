import { useRouterState } from "@tanstack/react-router";
import { ArrowLeftRightIcon, SquareArrowOutUpRightIcon, XIcon } from "lucide-react";
import type { PointerEvent as ReactPointerEvent, ReactElement } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { AppRouter } from "../router";
import { canOpenPageWindows } from "./pageWindows";
import { closePaneById, popOutPane } from "./paneActions";
import { describePaneLocation } from "./paneDestinations";
import { PRIMARY_PANE_ID } from "./paneLayout";
import { getPaneRouter } from "./paneRouters";
import { usePaneStore } from "./paneStore";

/** Called when a pointer goes down on the pill's label, the handle for moving or tearing out a pane. */
export type PaneDragHandlePointerDown = (
  event: ReactPointerEvent<HTMLElement>,
  paneId: string,
) => void;

interface PaneChromeProps {
  readonly paneId: string;
  readonly focused: boolean;
  readonly onDragHandlePointerDown?: PaneDragHandlePointerDown;
}

/**
 * Controls drawn over a pane while the window is split: the focused pane's pill
 * (page name, flip, pop out, close). Rendered inside every pane frame; only the
 * focused one shows anything.
 */
export function PaneChrome({ paneId, focused, onDragHandlePointerDown }: PaneChromeProps) {
  if (!focused) return null;
  if (paneId === PRIMARY_PANE_ID) {
    const router = getPaneRouter(PRIMARY_PANE_ID);
    return router ? (
      <PrimaryPanePill router={router} onDragHandlePointerDown={onDragHandlePointerDown} />
    ) : null;
  }
  return <SidePanePill paneId={paneId} onDragHandlePointerDown={onDragHandlePointerDown} />;
}

/** The primary pane shows the app router's location, which the pane store does not track. */
function PrimaryPanePill({
  router,
  onDragHandlePointerDown,
}: {
  readonly router: AppRouter;
  readonly onDragHandlePointerDown: PaneDragHandlePointerDown | undefined;
}) {
  const href = useRouterState({ router, select: (state) => state.location.href });
  return (
    <PanePill
      label={describePaneLocation(href)}
      onDragHandlePointerDown={onDragHandlePointerDown}
      paneId={PRIMARY_PANE_ID}
    />
  );
}

function SidePanePill({
  paneId,
  onDragHandlePointerDown,
}: {
  readonly paneId: string;
  readonly onDragHandlePointerDown: PaneDragHandlePointerDown | undefined;
}) {
  const href = usePaneStore(
    (state) => state.layout.panes.find((entry) => entry.id === paneId)?.href ?? "/",
  );
  return (
    <PanePill
      label={describePaneLocation(href)}
      onDragHandlePointerDown={onDragHandlePointerDown}
      paneId={paneId}
    />
  );
}

function PanePill({
  paneId,
  label,
  onDragHandlePointerDown,
}: {
  readonly paneId: string;
  readonly label: string;
  readonly onDragHandlePointerDown: PaneDragHandlePointerDown | undefined;
}) {
  const flipPane = usePaneStore((state) => state.flipPane);
  return (
    // Sits in the pane's top margin and dims while the pointer is elsewhere, so it
    // never hides page UI for long.
    <div
      aria-label={`${label} panel controls`}
      className="absolute top-1 left-1/2 z-40 flex h-7 -translate-x-1/2 items-center gap-0.5 rounded-full border bg-popover py-0.5 pr-0.5 pl-3 text-popover-foreground opacity-60 not-dark:bg-clip-padding shadow-md/5 transition-opacity duration-150 focus-within:opacity-100 in-[[data-pane-frame]:hover]:opacity-100"
      data-pane-chrome={paneId}
      role="toolbar"
    >
      <span
        className="mr-1 max-w-40 cursor-grab truncate text-xs font-medium select-none"
        data-pane-drag-handle=""
        onPointerDown={
          onDragHandlePointerDown ? (event) => onDragHandlePointerDown(event, paneId) : undefined
        }
      >
        {label}
      </span>
      <PanePillButton
        icon={<ArrowLeftRightIcon />}
        label="Flip panel"
        onClick={() => flipPane(paneId)}
      />
      {canOpenPageWindows ? (
        <PanePillButton
          icon={<SquareArrowOutUpRightIcon />}
          label="Open in window"
          onClick={() => void popOutPane(paneId)}
        />
      ) : null}
      <PanePillButton icon={<XIcon />} label="Close panel" onClick={() => closePaneById(paneId)} />
    </div>
  );
}

function PanePillButton({
  icon,
  label,
  onClick,
}: {
  readonly icon: ReactElement;
  readonly label: string;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="size-6 rounded-full"
            onClick={onClick}
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        {icon}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}
