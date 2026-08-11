import { type CSSProperties, type ReactNode, useEffect, useState } from "react";

import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME,
} from "../rightPanelLayout";
import { useResizableWidth } from "../hooks/useResizableWidth";
import {
  PREVIEW_PANEL_DEFAULT_WIDTH,
  PREVIEW_PANEL_MIN_WIDTH,
  PREVIEW_PANEL_WIDTH_STORAGE_KEY,
} from "./preview/PreviewPanelShell";
import { RightPanelResizeHandle } from "./preview/RightPanelResizeHandle";
import { Sheet, SheetPopup } from "./ui/sheet";

const RIGHT_PANEL_SHEET_RIGHT_INSET = 8;

export function resolveRightPanelSheetMaxWidth(input: {
  viewportWidth: number;
  navigationRailRight: number;
}): number {
  return Math.max(
    PREVIEW_PANEL_MIN_WIDTH,
    Math.floor(input.viewportWidth - input.navigationRailRight - RIGHT_PANEL_SHEET_RIGHT_INSET),
  );
}

function readRightPanelSheetMaxWidth(): number {
  if (typeof window === "undefined") return PREVIEW_PANEL_DEFAULT_WIDTH;
  const navigationRail = document.querySelector<HTMLElement>('[aria-label="Primary navigation"]');
  const navigationRailRight = navigationRail?.getBoundingClientRect().right ?? 0;
  return resolveRightPanelSheetMaxWidth({
    viewportWidth: window.innerWidth,
    navigationRailRight,
  });
}

function useRightPanelSheetMaxWidth(): number {
  const [maxWidth, setMaxWidth] = useState(readRightPanelSheetMaxWidth);

  useEffect(() => {
    const navigationRail = document.querySelector<HTMLElement>('[aria-label="Primary navigation"]');
    let frame = 0;
    const update = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setMaxWidth(readRightPanelSheetMaxWidth());
      });
    };
    const observer = new ResizeObserver(update);
    if (navigationRail) observer.observe(navigationRail);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, []);

  return maxWidth;
}

export function RightPanelSheet(props: {
  children: ReactNode;
  open: boolean;
  onClose: () => void;
  widthStorageKey?: string;
  defaultWidth?: number;
}) {
  const maxWidth = useRightPanelSheetMaxWidth();
  const { width, handlers } = useResizableWidth({
    storageKey: props.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: props.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  const sheetStyle = {
    "--right-panel-sheet-width": `${width}px`,
    "--right-panel-sheet-max-width": `${maxWidth}px`,
  } as CSSProperties;

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        side="right"
        showCloseButton={false}
        keepMounted
        className={RIGHT_PANEL_SHEET_CLASS_NAME}
        style={sheetStyle}
        viewportClassName={RIGHT_PANEL_SHEET_VIEWPORT_CLASS_NAME}
      >
        <RightPanelResizeHandle className="max-sm:hidden" handlers={handlers} />
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
