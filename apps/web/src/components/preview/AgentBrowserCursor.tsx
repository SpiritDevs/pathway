"use client";

import type { DesktopPreviewPointerEvent } from "@t3tools/contracts";
import { MousePointer2 } from "lucide-react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import type { ProviderInstanceEntry } from "~/providerInstances";

import { AGENT_CURSOR_GLIDE_MS, agentBrowserCursorGlidePosition } from "./agentBrowserCursorLogic";

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
  readonly provider: ProviderInstanceEntry | null;
  readonly showProviderBadge: boolean;
}) {
  const { tabId, zoomFactor, scale, offsetX, offsetY, provider, showProviderBadge } = props;
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
      provider={provider}
      showProviderBadge={showProviderBadge}
    />
  );
}

function AgentBrowserCursorEvent(props: {
  readonly event: DesktopPreviewPointerEvent;
  readonly zoomFactor: number;
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly provider: ProviderInstanceEntry | null;
  readonly showProviderBadge: boolean;
}) {
  const { event, zoomFactor, scale, offsetX, offsetY, provider, showProviderBadge } = props;
  const glide = agentBrowserCursorGlidePosition(event, zoomFactor, scale);

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
          opacity: 0.8,
          transform: `translate3d(${glide.x}px, ${glide.y}px, 0)`,
          transitionDuration: `${AGENT_CURSOR_GLIDE_MS}ms`,
        }}
      >
        <div className="relative">
          <MousePointer2
            className="size-6 -translate-x-0.5 -translate-y-0.5 fill-primary stroke-background drop-shadow-md"
            strokeWidth={1.5}
          />
          {provider ? (
            <ProviderInstanceIcon
              accentColor={provider.accentColor}
              badgeClassName="h-3 min-w-3 text-[7px]"
              className="absolute left-4 top-4 size-5 rounded-full bg-background p-0.5 shadow-sm"
              displayName={provider.displayName}
              driverKind={provider.driverKind}
              iconClassName="size-4"
              showBadge={showProviderBadge}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
