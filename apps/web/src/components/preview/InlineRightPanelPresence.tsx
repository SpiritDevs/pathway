import { type ReactNode, useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

const INLINE_RIGHT_PANEL_EXIT_DURATION_MS = 180;

export function InlineRightPanelPresence({
  children,
  fill = false,
  open,
}: {
  children: ReactNode;
  fill?: boolean;
  open: boolean;
}) {
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      if (prefersReducedMotion) {
        setVisible(true);
        return;
      }
      const frame = window.requestAnimationFrame(() => setVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }

    setVisible(false);
    if (prefersReducedMotion) {
      setMounted(false);
      return;
    }
    const timeout = window.setTimeout(() => setMounted(false), INLINE_RIGHT_PANEL_EXIT_DURATION_MS);
    return () => window.clearTimeout(timeout);
  }, [open, prefersReducedMotion]);

  if (!mounted) return null;

  return (
    <div
      aria-hidden={!open}
      className={cn(
        "flex min-h-0 min-w-0 transform-gpu transition-[transform,opacity] ease-[cubic-bezier(0.16,1,0.3,1)] motion-reduce:translate-x-0 motion-reduce:transition-none",
        fill ? "flex-1" : "shrink-0",
        visible
          ? "translate-x-0 opacity-100 duration-[240ms]"
          : "pointer-events-none translate-x-4 opacity-0 duration-[180ms]",
      )}
      data-inline-right-panel-presence={visible ? "open" : "closing"}
      data-inline-right-panel-fill={fill ? "true" : "false"}
    >
      {children}
    </div>
  );
}

export function InlineRightPanelPortal(props: {
  children: ReactNode;
  fill?: boolean;
  open: boolean;
}) {
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.querySelector<HTMLElement>("[data-inline-right-panel-host]"));
  }, []);

  if (host === null) return null;

  return createPortal(<InlineRightPanelPresence {...props} />, host);
}
