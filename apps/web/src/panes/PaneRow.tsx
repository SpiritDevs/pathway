import { RouterContextProvider, RouterProvider, useRouterState } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "../lib/utils";
import type { AppRouter } from "../router";
import { PaneChrome } from "./PaneChrome";
import { describePaneLocation } from "./paneDestinations";
import { PaneDropZones } from "./PaneDropZones";
import {
  isSplit,
  MIN_PANE_WIDTH,
  paneCapacity,
  PRIMARY_PANE_ID,
  resolveVisiblePanes,
  type PaneEntry,
} from "./paneLayout";
import { getSidePaneRouter, pruneSidePaneRouters } from "./paneRouters";
import { SidePaneContext } from "./paneScope";
import { usePaneStore } from "./paneStore";
import { startPaneTearOut } from "./paneTearOut";

/**
 * The main window's panes, side by side. `primary` is the app router's outlet;
 * every other pane renders its own router. Panes keep a stable DOM order and are
 * placed with CSS `order`, so flipping or adding panes never remounts a page.
 *
 * The row renders inside the focused pane's router context, so the primary pane
 * is put back under the app router explicitly.
 */
export function PaneRow({
  appRouter,
  primary,
}: {
  readonly appRouter: AppRouter;
  readonly primary: ReactNode;
}) {
  const layout = usePaneStore((state) => state.layout);
  const focusPane = usePaneStore((state) => state.focusPane);
  const enteringPaneId = usePaneStore((state) => state.enteringPaneId);
  const clearEnteringPane = usePaneStore((state) => state.clearEnteringPane);
  const rowRef = useRef<HTMLDivElement>(null);
  const frameRefs = useRef(new Map<string, HTMLDivElement>());
  const rowWidth = useElementWidth(rowRef);
  const split = isSplit(layout);
  const { visible, collapsedLeft, collapsedRight } = resolveVisiblePanes(
    layout,
    rowWidth === null ? layout.panes.length : paneCapacity(rowWidth),
  );
  const visibleIds = new Set(visible.map((entry) => entry.id));
  const paneIdsKey = layout.panes.map((entry) => entry.id).join("\n");

  useEffect(() => {
    pruneSidePaneRouters(new Set(paneIdsKey.split("\n")));
  }, [paneIdsKey]);
  useSlideMovedPanes(frameRefs, layout.panes.map((entry) => entry.id).join("\n"));

  const stableOrder = [...layout.panes].sort((a, b) =>
    a.id === PRIMARY_PANE_ID ? -1 : b.id === PRIMARY_PANE_ID ? 1 : a.id.localeCompare(b.id),
  );

  return (
    <div ref={rowRef} className="flex min-h-0 min-w-0 flex-1" data-pane-row="">
      {collapsedLeft.length > 0 ? (
        <CollapsedPaneTabs
          appRouter={appRouter}
          panes={collapsedLeft}
          side="left"
          onSelect={focusPane}
        />
      ) : null}
      {stableOrder.map((entry) => {
        if (!visibleIds.has(entry.id)) return null;
        const index = visible.indexOf(entry);
        const focused = split && layout.focusedPaneId === entry.id;
        return (
          <div
            key={entry.id}
            ref={(element) => {
              if (element) frameRefs.current.set(entry.id, element);
              else frameRefs.current.delete(entry.id);
            }}
            className={cn(
              // Each pane holds its own frame, with its inline right panel beside it.
              "relative flex min-h-0 min-w-0 gap-2 overflow-hidden rounded-t-xl md:rounded-xl",
              entry.id === enteringPaneId && "pane-enter",
              // An inset ring marks the focused pane without shifting its layout.
              focused &&
                "after:pointer-events-none after:absolute after:inset-0 after:z-30 after:rounded-[inherit] after:ring-1 after:ring-primary/60 after:ring-inset",
            )}
            data-pane-frame={entry.id}
            data-pane-focused={focused ? "" : undefined}
            onAnimationEnd={(event) => {
              if (event.target === event.currentTarget && entry.id === enteringPaneId) {
                clearEnteringPane();
              }
            }}
            onFocusCapture={() => focusPane(entry.id)}
            onPointerDownCapture={() => focusPane(entry.id)}
            style={{ flex: `${entry.weight} 1 0%`, order: index * 2 }}
          >
            {entry.id === PRIMARY_PANE_ID ? (
              <RouterContextProvider router={appRouter}>{primary}</RouterContextProvider>
            ) : (
              <SidePane paneId={entry.id} initialHref={entry.href} />
            )}
            {/* Split, a page's inline right panel sits inside its own pane. */}
            <div className="contents" data-pane-right-panel-host={entry.id} />
            {split ? (
              <PaneChrome
                focused={focused}
                onDragHandlePointerDown={startPaneTearOut}
                paneId={entry.id}
              />
            ) : null}
          </div>
        );
      })}
      {visible.slice(1).map((entry, offset) => (
        <PaneDivider
          key={`divider:${entry.id}`}
          frameRefs={frameRefs}
          leftIndex={layout.panes.indexOf(visible[offset]!)}
          leftPaneId={visible[offset]!.id}
          order={offset * 2 + 1}
          rightPaneId={entry.id}
        />
      ))}
      <PaneDropZones />
      {collapsedRight.length > 0 ? (
        <CollapsedPaneTabs
          appRouter={appRouter}
          panes={collapsedRight}
          side="right"
          onSelect={focusPane}
        />
      ) : null}
    </div>
  );
}

function SidePane({
  paneId,
  initialHref,
}: {
  readonly paneId: string;
  readonly initialHref: string;
}) {
  const router = getSidePaneRouter(paneId, initialHref);
  return (
    <SidePaneContext.Provider value={paneId}>
      <RouterProvider router={router} />
    </SidePaneContext.Provider>
  );
}

/**
 * Drag to share the width of the two panes either side; double-click to give
 * every pane an equal share.
 */
function PaneDivider({
  frameRefs,
  leftIndex,
  leftPaneId,
  rightPaneId,
  order,
}: {
  readonly frameRefs: { readonly current: Map<string, HTMLDivElement> };
  readonly leftIndex: number;
  readonly leftPaneId: string;
  readonly rightPaneId: string;
  readonly order: number;
}) {
  const resizeAtDivider = usePaneStore((state) => state.resizeAtDivider);
  const equalizePanes = usePaneStore((state) => state.equalizePanes);
  const frameRef = useRef<number | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const left = frameRefs.current.get(leftPaneId);
      const right = frameRefs.current.get(rightPaneId);
      if (!left || !right) return;
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const pairLeft = left.getBoundingClientRect().left;
      const pairWidth = right.getBoundingClientRect().right - pairLeft;
      const minFraction = Math.min(0.5, MIN_PANE_WIDTH / pairWidth);
      let pointerX = event.clientX;

      const onMove = (moveEvent: PointerEvent) => {
        pointerX = moveEvent.clientX;
        if (frameRef.current !== null) return;
        frameRef.current = window.requestAnimationFrame(() => {
          frameRef.current = null;
          resizeAtDivider(leftIndex, (pointerX - pairLeft) / pairWidth, minFraction);
        });
      };
      const onEnd = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onEnd);
        handle.removeEventListener("pointercancel", onEnd);
        document.body.style.removeProperty("cursor");
        document.body.style.removeProperty("user-select");
      };
      document.body.style.setProperty("cursor", "col-resize");
      document.body.style.setProperty("user-select", "none");
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onEnd);
      handle.addEventListener("pointercancel", onEnd);
    },
    [frameRefs, leftIndex, leftPaneId, resizeAtDivider, rightPaneId],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  return (
    // The gap between two panes' frames is the hit area; its rule shows on hover.
    <div
      aria-label="Resize panels"
      aria-orientation="vertical"
      className="group/pane-divider relative z-40 w-2 shrink-0 cursor-col-resize touch-none"
      onDoubleClick={equalizePanes}
      onPointerDown={onPointerDown}
      role="separator"
      style={{ order }}
      title="Drag to resize · Double-click to share equally"
    >
      <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors group-hover/pane-divider:bg-primary/60" />
    </div>
  );
}

/** Panes that do not fit the row, as narrow tabs on the side they sit. */
function CollapsedPaneTabs({
  appRouter,
  panes,
  side,
  onSelect,
}: {
  readonly appRouter: AppRouter;
  readonly panes: readonly PaneEntry[];
  readonly side: "left" | "right";
  readonly onSelect: (paneId: string) => void;
}) {
  return (
    <div
      className={cn(
        // A narrow card of its own, set off from the frames like the panes are.
        "flex w-7 shrink-0 flex-col gap-1 rounded-xl border border-sidebar-border bg-background py-2",
        side === "left" ? "order-[-1] mr-2" : "order-[999] ml-2",
      )}
    >
      {panes.map((entry) => (
        <CollapsedPaneTab key={entry.id} appRouter={appRouter} entry={entry} onSelect={onSelect} />
      ))}
    </div>
  );
}

function CollapsedPaneTab({
  appRouter,
  entry,
  onSelect,
}: {
  readonly appRouter: AppRouter;
  readonly entry: PaneEntry;
  readonly onSelect: (paneId: string) => void;
}) {
  const primaryHref = useRouterState({
    router: appRouter,
    select: (state) => state.location.href,
  });
  const label = describePaneLocation(entry.id === PRIMARY_PANE_ID ? primaryHref : entry.href);
  return (
    <button
      className="mx-auto rounded-md px-1 py-2 text-xs text-muted-foreground [writing-mode:vertical-rl] hover:bg-accent hover:text-foreground"
      onClick={() => onSelect(entry.id)}
      title={`Show ${label}`}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * Panes that change place when another opens or closes slide from where they
 * were, instead of jumping. One transform animation per moved pane, and none
 * with reduced motion.
 */
function useSlideMovedPanes(
  frameRefs: { readonly current: Map<string, HTMLDivElement> },
  paneIdsKey: string,
) {
  const previousLeftByIdRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const previousLeftById = previousLeftByIdRef.current;
    const nextLeftById = new Map<string, number>();
    const animate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [paneId, element] of frameRefs.current) {
      const left = element.getBoundingClientRect().left;
      nextLeftById.set(paneId, left);
      const previousLeft = previousLeftById.get(paneId);
      if (!animate || previousLeft === undefined || Math.abs(previousLeft - left) < 1) continue;
      element.animate(
        [{ transform: `translateX(${previousLeft - left}px)` }, { transform: "none" }],
        { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
    previousLeftByIdRef.current = nextLeftById;
  }, [frameRefs, paneIdsKey]);
}

function useElementWidth(ref: { readonly current: HTMLElement | null }): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}
