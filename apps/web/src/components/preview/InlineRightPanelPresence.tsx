import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";
import {
  resolveInlineRightPanelHostSelector,
  useIsSplitWindow,
  usePaneId,
} from "~/panes/usePaneFocus";

const INLINE_RIGHT_PANEL_ENTER_DURATION_MS = 280;
const INLINE_RIGHT_PANEL_EXIT_DURATION_MS = 200;
const INLINE_RIGHT_PANEL_EASING = "cubic-bezier(0.32, 0.72, 0, 1)";

/** The gap the row puts before the panel, which also has to open and close with it. */
function rowGapBefore(element: HTMLElement): number {
  let row = element.parentElement;
  while (row && getComputedStyle(row).display === "contents") row = row.parentElement;
  return row ? Number.parseFloat(getComputedStyle(row).columnGap) || 0 : 0;
}

/**
 * Opens and closes the inline panel by growing and shrinking its width, so the page
 * beside it slides over rather than jumping. The panel keeps its full width while
 * the frame reveals it from the right edge.
 */
export function InlineRightPanelPresence({
  children,
  open,
}: {
  children: ReactNode;
  open: boolean;
}) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [mounted, setMounted] = useState(open);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const animationRef = useRef<Animation | null>(null);
  // Already open when the page mounts (such as switching threads), so no entrance.
  const lastOpenRef = useRef(open);

  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const content = contentRef.current;
    if (!frame || !content || lastOpenRef.current === open) return;
    lastOpenRef.current = open;

    // Start from wherever an interrupted animation left the frame.
    const previous = animationRef.current;
    const fromStyle = previous ? getComputedStyle(frame) : null;
    const from = fromStyle
      ? {
          width: `${frame.getBoundingClientRect().width}px`,
          marginLeft: fromStyle.marginLeft,
          opacity: Number(fromStyle.opacity),
        }
      : null;
    previous?.cancel();
    animationRef.current = null;
    content.style.width = "";
    frame.style.overflow = "";

    if (prefersReducedMotion || typeof frame.animate !== "function") {
      if (!open) setMounted(false);
      return;
    }

    const width = frame.getBoundingClientRect().width;
    const collapsed = { width: "0px", marginLeft: `${-rowGapBefore(frame)}px`, opacity: 0 };
    const expanded = { width: `${width}px`, marginLeft: "0px", opacity: 1 };

    // Pin the panel at its full width so its contents never reflow mid-animation.
    content.style.width = `${width}px`;
    frame.style.overflow = "hidden";
    const animation = frame.animate(
      open ? [from ?? collapsed, expanded] : [from ?? expanded, collapsed],
      {
        duration: open ? INLINE_RIGHT_PANEL_ENTER_DURATION_MS : INLINE_RIGHT_PANEL_EXIT_DURATION_MS,
        easing: INLINE_RIGHT_PANEL_EASING,
        fill: "forwards",
      },
    );
    animationRef.current = animation;
    animation.finished.then(
      () => {
        if (animationRef.current !== animation) return;
        animationRef.current = null;
        if (!open) {
          setMounted(false);
          return;
        }
        animation.cancel();
        content.style.width = "";
        frame.style.overflow = "";
      },
      () => {},
    );
  }, [open, prefersReducedMotion]);

  useEffect(() => () => animationRef.current?.cancel(), []);

  if (!mounted) return null;

  return (
    <div
      ref={frameRef}
      aria-hidden={!open}
      className={cn("flex min-h-0 min-w-0 shrink-0 justify-end", !open && "pointer-events-none")}
      data-inline-right-panel-presence={open ? "open" : "closing"}
    >
      <div ref={contentRef} className="flex min-h-0 shrink-0">
        {children}
      </div>
    </div>
  );
}

/** Renders the panel beside the page, in the host that belongs to the page's pane. */
export function InlineRightPanelPortal(props: { children: ReactNode; open: boolean }) {
  const hostSelector = resolveInlineRightPanelHostSelector(usePaneId(), useIsSplitWindow());
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.querySelector<HTMLElement>(hostSelector));
  }, [hostSelector]);

  if (host === null) return null;

  return createPortal(<InlineRightPanelPresence {...props} />, host);
}
