"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { MousePointer2 } from "lucide-react";
import { useEffect, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";

import {
  AGENT_CURSOR_GLIDE_MS,
  agentBrowserCursorGlidePosition,
  agentBrowserCursorOpacity,
} from "./agentBrowserCursorLogic";

const CURSOR_ACTIVE_MS = 700;

/**
 * Rendered inside the hosted webview's wrapper (a sibling of the `<webview>`
 * element) so it always paints above the guest page, wherever the surface is
 * presented. Coordinates are wrapper-local: `offsetX`/`offsetY` position the
 * guest viewport and the pointer event glides within it.
 */
export function AgentBrowserCursor(props: {
  readonly tabId: string;
  readonly zoomFactor: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}) {
  const { tabId, zoomFactor, scale, offsetX, offsetY } = props;
  const event = useBrowserPointerStore((state) => state.byTabId[tabId] ?? null);

  if (!event) return null;

  return (
    <AgentBrowserCursorEvent
      key={tabId}
      event={event}
      zoomFactor={zoomFactor}
      scale={scale}
      offsetX={offsetX}
      offsetY={offsetY}
    />
  );
}

function AgentBrowserCursorEvent(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly zoomFactor: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}) {
  const { event, zoomFactor, scale, offsetX, offsetY } = props;
  const [active, setActive] = useState(true);

  useEffect(() => {
    setActive(true);
    const timeout = window.setTimeout(() => setActive(false), CURSOR_ACTIVE_MS);
    return () => window.clearTimeout(timeout);
  }, [event.sequence]);

  const glide = agentBrowserCursorGlidePosition(event, zoomFactor, scale);
  const pressed = active && event.phase === "click";

  return (
    <div
      className="pointer-events-none absolute left-0 top-0 z-40"
      style={{ transform: `translate3d(${offsetX}px, ${offsetY}px, 0)` }}
      aria-hidden="true"
      data-agent-browser-cursor
    >
      <div
        className="transition-[transform,opacity] ease-out motion-reduce:transition-none"
        style={{
          opacity: agentBrowserCursorOpacity(active),
          transform: `translate3d(${glide.x}px, ${glide.y}px, 0)`,
          transitionDuration: `${AGENT_CURSOR_GLIDE_MS}ms`,
        }}
      >
        {event.phase === "click" ? (
          <span
            key={event.sequence}
            className="absolute -left-3 -top-3 size-6 animate-status-ping rounded-full border border-primary/60 bg-primary/25 motion-reduce:animate-none"
          />
        ) : null}
        <span className="absolute -left-2 -top-2 size-8 rounded-full bg-primary/15 blur-sm" />
        <div
          className={`relative transition-transform duration-100 ease-out motion-reduce:transition-none ${pressed ? "scale-90" : "scale-100"}`}
        >
          <MousePointer2
            className="size-5 -translate-x-0.5 -translate-y-0.5 fill-primary stroke-background drop-shadow-md"
            strokeWidth={1.5}
          />
          <span className="absolute left-4 top-4 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-primary-foreground shadow-sm">
            AI
          </span>
        </div>
      </div>
    </div>
  );
}
