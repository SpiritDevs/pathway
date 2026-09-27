import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type {
  PreviewRemoteCommand,
  PreviewRemoteFrame,
  PreviewRemoteTab,
  PreviewTabId,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { previewEnvironment } from "~/state/preview";

import { remoteBrowserPoint } from "./remoteBrowserCoordinates";

/** Automatic retries before the stream waits for the user to press Reconnect. */
const AUTO_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type RemoteBrowserInput = (command: PreviewRemoteCommand) => Promise<boolean>;

/**
 * Live view of one remote tab. With `onInput` it forwards clicks, keys, paste and
 * scrolling to the environment; without it the view is watch-only and `onActivate`
 * handles clicks (the mini-player uses this to open the panel).
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
  const atom = useMemo(
    () =>
      previewEnvironment.remoteFrames({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, ...(tabId ? { tabId } : {}) },
      }),
    [tabId, threadRef.environmentId, threadRef.threadId],
  );
  const result = useAtomValue(atom);
  const reconnect = useAtomRefresh(atom);
  const failed = AsyncResult.isFailure(result);
  const [retries, setRetries] = useState(0);
  const incoming = AsyncResult.isSuccess(result) ? result.value : undefined;
  // Keep the last painted frame across metadata-only updates without a second render per frame.
  const lastFrame = useRef<PreviewRemoteFrame | undefined>(undefined);
  if (incoming?.data && incoming.tabId === tabId) lastFrame.current = incoming;
  const frame = lastFrame.current?.tabId === tabId ? lastFrame.current : undefined;

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
  if (!frame)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Connecting to the remote browser…
      </p>
    );

  const target = { threadId: threadRef.threadId, tabId };
  const imageClassName =
    "h-full w-full object-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary";
  const src = `data:${frame.mimeType};base64,${frame.data}`;
  if (!onInput)
    return (
      <img
        alt="Live remote browser page"
        src={src}
        className={`${imageClassName} ${onActivate ? "cursor-pointer" : ""}`}
        draggable={false}
        onClick={onActivate}
      />
    );
  return (
    <InteractiveFrame
      frame={frame}
      src={src}
      className={imageClassName}
      send={(command) => void onInput({ ...command, ...target } as PreviewRemoteCommand)}
    />
  );
}

type TargetlessCommand = PreviewRemoteCommand extends infer C
  ? C extends { readonly tabId: PreviewTabId }
    ? Omit<C, "threadId" | "tabId">
    : never
  : never;

function InteractiveFrame({
  frame,
  src,
  className,
  send,
}: {
  frame: PreviewRemoteFrame;
  src: string;
  className: string;
  send: (command: TargetlessCommand) => void;
}) {
  const scroll = useRef({
    x: 0,
    y: 0,
    timer: undefined as ReturnType<typeof setTimeout> | undefined,
  });
  useEffect(
    () => () => {
      clearTimeout(scroll.current.timer);
    },
    [],
  );
  return (
    <img
      alt="Remote browser page. Click to interact; use your keyboard after clicking."
      src={src}
      className={className}
      draggable={false}
      tabIndex={0}
      onClick={(event) => {
        event.currentTarget.focus();
        const box = event.currentTarget.getBoundingClientRect();
        const point = remoteBrowserPoint({
          x: event.clientX - box.left,
          y: event.clientY - box.top,
          boxWidth: box.width,
          boxHeight: box.height,
          width: frame.width,
          height: frame.height,
        });
        if (point) send({ action: "click", ...point });
      }}
      onKeyDown={(event) => {
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
      }}
      onPaste={(event) => {
        event.preventDefault();
        send({ action: "type", text: event.clipboardData.getData("text/plain") });
      }}
      onWheel={(event) => {
        const pending = scroll.current;
        const multiplier = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? frame.height : 1;
        pending.x += event.deltaX * multiplier;
        pending.y += event.deltaY * multiplier;
        if (pending.timer !== undefined) return;
        pending.timer = setTimeout(() => {
          const deltaX = pending.x;
          const deltaY = pending.y;
          pending.x = 0;
          pending.y = 0;
          pending.timer = undefined;
          send({ action: "scroll", deltaX, deltaY });
        }, 100);
      }}
    />
  );
}

function failureMessage(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : null;
}
