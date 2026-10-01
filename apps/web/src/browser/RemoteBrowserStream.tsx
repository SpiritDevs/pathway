import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  PreviewRemoteCommand,
  PreviewRemoteTab,
  PreviewTabId,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { KEYBINDING_CAPTURE_ATTRIBUTE } from "~/keybindings";
import { previewEnvironment } from "~/state/preview";
import { useEnvironmentSurface } from "~/surface/useEnvironmentSurface";

import { RemoteBrowserInteractions } from "./RemoteBrowserInteractions";
import { remoteBrowserPoint } from "./remoteBrowserCoordinates";
import { surfaceIndicator } from "./remoteBrowserSurface";

/** Automatic retries before the stream waits for the user to press Reconnect. */
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type RemoteBrowserInput = (command: PreviewRemoteCommand) => Promise<boolean>;

/**
 * Live view of one remote tab. Pixels arrive over the environment's binary
 * surface socket; tab metadata over a frame-less RPC subscription. With
 * `onInput` it forwards clicks, keys, paste, pointer and wheel input and
 * presents the page's dialogs, pickers and downloads; without it the view is
 * watch-only and `onActivate` handles clicks (the mini-player opens the panel).
 */
export function RemoteBrowserStream({
  threadRef,
  tabId,
  onTabs,
  onInput,
  onActivate,
  emptyState,
  compact = false,
}: {
  threadRef: ScopedThreadRef;
  tabId?: PreviewTabId | undefined;
  onTabs?: (tabs: ReadonlyArray<PreviewRemoteTab>, metadataRevision?: number) => void;
  onInput?: RemoteBrowserInput;
  onActivate?: () => void;
  emptyState?: React.ReactNode;
  compact?: boolean;
}) {
  // Without a tabId the subscription carries tab metadata only and captures nothing.
  const atom = useMemo(
    () =>
      previewEnvironment.remoteFrames({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }),
    [threadRef.environmentId, threadRef.threadId],
  );
  const result = useAtomValue(atom);
  const reconnect = useAtomRefresh(atom);
  const failed = AsyncResult.isFailure(result);
  const [retries, setRetries] = useState(0);
  const incoming = AsyncResult.isSuccess(result) ? result.value : undefined;

  useEffect(() => {
    if (incoming) setRetries(0);
  }, [incoming]);
  useEffect(() => {
    if (!failed || result.waiting) return;
    const delay = AUTO_RECONNECT_DELAYS_MS[retries];
    if (delay === undefined) return;
    const timer = setTimeout(() => {
      setRetries((value) => value + 1);
      reconnect();
    }, delay);
    return () => clearTimeout(timer);
  }, [failed, reconnect, result.waiting, retries]);

  const tabs = incoming?.tabs;
  const metadataRevision = incoming?.metadataRevision;
  useEffect(() => {
    if (tabs) onTabs?.(tabs, metadataRevision);
  }, [tabs, metadataRevision, onTabs]);

  if (AsyncResult.isFailure(result)) {
    const cause = failureMessage(result);
    return (
      <div
        role="alert"
        className="flex h-full w-full flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground"
      >
        <p>
          {result.waiting
            ? "Reconnecting to the remote browser…"
            : "The remote browser disconnected."}
        </p>
        {!compact && cause ? <p className="max-w-sm text-xs">{cause}</p> : null}
        <button
          type="button"
          className="pointer-events-auto rounded border bg-background px-2 py-1 text-xs text-foreground"
          disabled={result.waiting}
          onClick={(event) => {
            event.stopPropagation();
            setRetries(0);
            reconnect();
          }}
        >
          Reconnect
        </button>
      </div>
    );
  }
  if (!tabId) return <>{emptyState ?? null}</>;
  return (
    <RemoteBrowserSurface
      key={tabId}
      threadRef={threadRef}
      tabId={tabId}
      onInput={onInput}
      onActivate={onActivate}
      compact={compact}
    />
  );
}

type TargetlessCommand = PreviewRemoteCommand extends infer C
  ? C extends { readonly tabId: PreviewTabId }
    ? Omit<C, "threadId" | "tabId">
    : never
  : never;

function RemoteBrowserSurface({
  threadRef,
  tabId,
  onInput,
  onActivate,
  compact,
}: {
  threadRef: ScopedThreadRef;
  tabId: PreviewTabId;
  onInput: RemoteBrowserInput | undefined;
  onActivate: (() => void) | undefined;
  compact: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surface = useEnvironmentSurface({
    environmentId: threadRef.environmentId,
    target: { kind: "browser", threadId: threadRef.threadId, tabId },
    enabled: true,
    // The mini-player is a thumbnail; it must not shrink the agent's page.
    sizing: compact ? "passive" : "active",
    containerRef,
    canvasRef,
  });
  const indicator = surfaceIndicator(surface.state, surface.quality);
  const target = { threadId: threadRef.threadId, tabId };
  const send = onInput
    ? (command: TargetlessCommand) =>
        void onInput({ ...command, ...target } as PreviewRemoteCommand)
    : undefined;
  // Maps a pointer position on the letterboxed canvas to page CSS pixels.
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current;
    const page = surface.pageSize.current;
    if (!canvas || !page) return null;
    const box = canvas.getBoundingClientRect();
    return remoteBrowserPoint({
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      boxWidth: box.width,
      boxHeight: box.height,
      width: page.width,
      height: page.height,
    });
  };

  return (
    <div ref={containerRef} className="relative h-full w-full self-stretch overflow-hidden">
      <canvas
        ref={canvasRef}
        aria-label={
          send
            ? "Remote browser page. Click to interact; use your keyboard after clicking."
            : "Live remote browser page"
        }
        role="img"
        tabIndex={send ? 0 : undefined}
        {...(send ? { [KEYBINDING_CAPTURE_ATTRIBUTE]: "" } : {})}
        className={`h-full w-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary ${
          !send && onActivate ? "cursor-pointer" : ""
        } ${surface.hasFrame ? "" : "invisible"}`}
        onClick={
          send
            ? (event) => {
                event.currentTarget.focus();
                const point = pagePoint(event);
                if (point) send({ action: "click", ...point });
              }
            : onActivate
        }
        onKeyDown={
          send
            ? (event) => {
                // Keys belong to the page, not to app shortcuts further up.
                event.stopPropagation();
                if (event.key === "Escape") {
                  event.currentTarget.blur();
                  return;
                }
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") return;
                if (["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
                event.preventDefault();
                const modifiers = [
                  event.metaKey ? "Meta" : "",
                  event.ctrlKey ? "Control" : "",
                  event.altKey ? "Alt" : "",
                  event.shiftKey ? "Shift" : "",
                ].filter(Boolean);
                if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
                  send({ action: "type", text: event.key });
                else
                  send({
                    action: "press",
                    key: [...modifiers, event.key === " " ? "Space" : event.key].join("+"),
                  });
              }
            : undefined
        }
        onPaste={
          send
            ? (event) => {
                event.preventDefault();
                send({ action: "type", text: event.clipboardData.getData("text/plain") });
              }
            : undefined
        }
      />
      {!surface.hasFrame ? (
        <p
          role="status"
          className="absolute inset-0 flex items-center justify-center p-4 text-sm text-muted-foreground"
        >
          {surface.state === "failed"
            ? "The remote browser stream is offline. Retrying…"
            : "Connecting to the remote browser…"}
        </p>
      ) : null}
      {send ? (
        <RemoteBrowserInteractions
          threadRef={threadRef}
          tabId={tabId}
          canvasRef={canvasRef}
          pagePoint={pagePoint}
          pageHeight={() => surface.pageSize.current?.height ?? 0}
        />
      ) : null}
      {!compact ? (
        <button
          type="button"
          className="absolute right-2 bottom-2 flex items-center gap-1.5 rounded-full border bg-background/85 px-2 py-0.5 text-[11px] text-muted-foreground tabular-nums"
          title={
            indicator.tone === "live"
              ? "Streaming from the environment. Latency includes clock differences between machines."
              : "Reconnect the stream"
          }
          onClick={() => {
            if (indicator.tone !== "live") surface.reconnect();
          }}
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              indicator.tone === "live"
                ? "bg-emerald-500"
                : indicator.tone === "degraded"
                  ? "bg-amber-500"
                  : "bg-destructive"
            }`}
          />
          {indicator.label}
        </button>
      ) : null}
    </div>
  );
}

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : null;
}
