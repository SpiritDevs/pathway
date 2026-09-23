// FILE: ComputerPreviewPopover.tsx
// Purpose: Ambient in-chat mini preview of the desktop an agent is driving.
// Layer: Chat surface UI
// Depends on: computerPreviewStore session machine, computerStateStore thread
//             state, useComputerImageStream, ComputerPanel.logic helpers.
// Exports: ComputerPreviewPopover, and ComputerPreviewRail, the chat column
//          overlay that hosts it.
//
// View-only: the card follows the driven content, with a compact activity
// label and a visible error if its first frame cannot arrive. Close
// lives in a hover/focus-reveal cluster (the composer's stop stays the
// always-visible safety net). It mounts wherever the owning thread's transcript is on
// screen and self-hides when that thread has no live preview session. Size is
// dynamic: the card fits the space its slot offers while keeping the live
// content's aspect, never a fixed box.

import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import type { ClientSettings, ScopedThreadRef } from "@spiritdevs/contracts";
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  selectThreadComputerPreviewFloating,
  selectThreadComputerPreviewSession,
  useComputerPreviewStore,
} from "../../computerPreviewStore";
import {
  selectThreadComputerState,
  useComputerInputStopped,
  useComputerStateStore,
} from "../../computerStateStore";
import { useClientSettings } from "../../hooks/useSettings";
import { useThreadComputerStateSeed } from "../../hooks/useThreadComputerStateSeed";
import { cn } from "../../lib/utils";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  computerCanvasLabel,
  shouldSubscribeToComputerStream,
} from "../computer/ComputerPanel.logic";
import { useComputerImageStream } from "../computer/useComputerImageStream";
import {
  type ComputerPreviewFloat,
  useComputerPreviewFloat,
} from "../computer/useComputerPreviewFloat";
import { useComputerPreviewTap } from "../computer/useComputerPreviewTap";
import {
  computerPreviewBudgetPx,
  computerPreviewCardCaps,
  computerPreviewCardFitWidth,
  computerPreviewCardOpen,
  computerPreviewFrameSource,
  computerPreviewStatusLabel,
  type ComputerPreviewCardSize,
  type ComputerPreviewSession,
} from "./ComputerPreviewPopover.logic";

const FALLBACK_ASPECT_RATIO = "16 / 10";
// Slot fallbacks for the first paint (and server markup), before the slot is
// measured. The live card always fits its measured slot instead.
const SLOT_FALLBACK_WIDTH_PX = 320;
const SLOT_FALLBACK_HEIGHT_PX = 616;

// The card's open/close pop: a one-shot transition, never a loop.
const POP_MOTION_CLASS =
  "origin-top-right transition-[opacity,transform] duration-280 ease-out motion-reduce:transition-none";
const POP_OPEN_CLASS = "translate-y-0 scale-100 opacity-100";
const POP_CLOSED_CLASS = "translate-y-1.5 scale-[0.97] opacity-0 pointer-events-none duration-160";

function disclosurePopClassName(open: boolean) {
  return cn(POP_MOTION_CLASS, open ? POP_OPEN_CLASS : POP_CLOSED_CLASS);
}

const selectAutoOpenComputerPane = (settings: ClientSettings) => settings.autoOpenComputerPane;
const selectComputerPreviewSize = (settings: ClientSettings): ComputerPreviewCardSize =>
  settings.computerPreviewSize === "large" ? "large" : "compact";

/**
 * The ambient rail: a top-right overlay in the chat column that hosts the
 * owning thread's card. It renders nothing (and observes nothing) until the
 * thread has a preview session. The chat keeps its full width; the card
 * floats over the transcript's right edge, sized from the column's width.
 */
export function ComputerPreviewRail(props: { readonly threadRef: ScopedThreadRef }) {
  const session = useComputerPreviewStore(selectThreadComputerPreviewSession(props.threadRef));
  const autoOpenComputerPane = useClientSettings(selectAutoOpenComputerPane);
  if (!autoOpenComputerPane || session === undefined) {
    return null;
  }
  return <ComputerPreviewRailSlot key={scopedThreadKey(props.threadRef)} {...props} />;
}

function ComputerPreviewRailSlot(props: { readonly threadRef: ScopedThreadRef }) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const size = useClientSettings(selectComputerPreviewSize);
  const column = useObservedSize(railRef, { parent: true });
  const budgetPx = computerPreviewBudgetPx({
    mainContentWidthPx: column.width > 0 ? column.width : Number.MAX_SAFE_INTEGER,
    environmentInsetPx: 0,
    caps: computerPreviewCardCaps(size),
  });
  return (
    <div
      ref={railRef}
      className="pointer-events-none absolute inset-y-0 right-0 z-20 flex flex-col items-end gap-3 overflow-y-auto p-3"
    >
      <ComputerPreviewPopover threadRef={props.threadRef} maxWidthPx={budgetPx} size={size} />
    </div>
  );
}

export function ComputerPreviewPopover(props: {
  readonly threadRef: ScopedThreadRef;
  /**
   * Rail budget: the widest the card may grow, set by the host ChatView from
   * the gutter it freed via content inset. Defaults to the size cap;
   * the card never exceeds it regardless of slot or aspect.
   */
  readonly maxWidthPx?: number | undefined;
  /**
   * Footprint from Settings (compact default). Picks the fit bounds; the
   * host ChatView applies the same cap to the gutter it frees.
   */
  readonly size?: ComputerPreviewCardSize | undefined;
}) {
  const session = useComputerPreviewStore(selectThreadComputerPreviewSession(props.threadRef));
  // The "Open automatically" preference now governs the ambient preview, which
  // is what replaced the pane's auto-open. Manual opens are unaffected.
  const autoOpenComputerPane = useClientSettings(selectAutoOpenComputerPane);
  if (!autoOpenComputerPane || session === undefined) {
    return null;
  }
  return (
    <ComputerPreviewPopoverCard
      threadRef={props.threadRef}
      session={session}
      maxWidthPx={props.maxWidthPx}
      size={props.size ?? "compact"}
    />
  );
}

function ComputerPreviewPopoverCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly session: ComputerPreviewSession;
  readonly maxWidthPx?: number | undefined;
  readonly size?: ComputerPreviewCardSize | undefined;
}) {
  const { threadRef, session } = props;
  const { environmentId, threadId } = threadRef;
  const threadKey = scopedThreadKey(threadRef);
  const caps = computerPreviewCardCaps(props.size ?? "compact");
  const cardMaxWidth = Math.min(props.maxWidthPx ?? caps.maxWidthPx, caps.maxWidthPx);
  const open = computerPreviewCardOpen(session.phase);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const threadState = useComputerStateStore(selectThreadComputerState(threadRef));
  const markPreviewLive = useComputerPreviewStore((store) => store.markPreviewLive);
  const notePreviewLayout = useComputerPreviewStore((store) => store.notePreviewLayout);
  const floating = useComputerPreviewStore(selectThreadComputerPreviewFloating(threadRef));
  // Ownership lasts for the turn, including model thinking between tool calls.
  const agentActive =
    threadState?.controlOwnerThreadId !== undefined || (threadState?.agentActive ?? false);
  const visibleDesktop = threadState?.capabilities.visibleDesktop ?? false;
  const inputStopped = useComputerInputStopped(threadRef.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const statusLabel = computerPreviewStatusLabel({
    agentActive,
    inputStopped: inputStopped || threadState?.inputStopped === true,
    currentActivity: threadState?.activity ?? null,
    lastActionLabel: session.lastActionLabel ?? null,
  });
  // The card fits the space its slot offers: measure the positioned ancestor
  // so window resizes, sidebar toggles, and split leaves all re-fit the card
  // instead of it overflowing or floating in dead space. In the env rail the
  // offset parent is the full-height rail wrapper, so its height is the
  // container height; width comes from the rail budget prop instead, because
  // the shrink-fit wrapper cannot measure what the freed gutter will be.
  const slotSize = useObservedSize(cardRef, { offsetParent: true });

  useThreadComputerStateSeed(threadRef);

  // Mounting means the owning thread is on screen: an armed session goes live
  // here, which is also what animates the card in from its closed state.
  useEffect(() => {
    if (session.phase === "armed") {
      markPreviewLive({ environmentId, threadId });
    }
  }, [environmentId, markPreviewLive, session.phase, threadId]);

  const streamWanted = shouldSubscribeToComputerStream({
    runtimeMode: "live",
    isVisible: open,
    threadState,
  });
  // The desktop app's native tap is the preferred source while it keeps
  // delivering frames; the server's window/tab stills own the canvas only
  // while the tap is quiet or absent, so the two never draw at the same time
  // and neither can paint a desktop-wide image. The tap shows the desktop
  // app's own host, so only the primary (local) environment may use it.
  const tap = useComputerPreviewTap({
    canvasRef,
    threadRef,
    enabled: streamWanted && threadRef.environmentId === primaryEnvironmentId,
  });
  const frameSource = computerPreviewFrameSource({
    streamWanted,
    tapActive: tap.active,
    tapHasFrame: tap.frameSize !== null,
  });
  const { status: streamStatus, dimensions } = useComputerImageStream({
    canvasRef,
    environmentId: threadRef.environmentId,
    computerId: streamWanted && threadState ? threadState.computerId : null,
    enabled: frameSource === "stills",
  });

  const frameSignal = tap.active || tap.frameSize !== null || streamStatus.kind === "streaming";
  // Delayed appearance: the card stays visually closed until the first real
  // frame lands, so it materializes with content instead of an empty box.
  // Crucially the (hidden) canvas stays mounted throughout: both frame
  // sources decode into canvasRef, so unmounting it would starve the very
  // signal the latch waits for. The latch survives quiet fallbacks and stills
  // reconnects within one mount; a remount (new thread) starts over. It seeds
  // from the render-time signal so server markup matches a live frame, and
  // adjusts during render so the flip happens before paint.
  const [hasFrame, setHasFrame] = useState(() => frameSignal);
  if (frameSignal && !hasFrame) {
    setHasFrame(true);
  }
  // A failed first frame must not hide its own recovery message. Connecting
  // stays quiet, while an explicit error or unsupported decoder opens the card.
  const hasVisibleStatus =
    !hasFrame && (streamStatus.kind === "error" || streamStatus.kind === "unsupported");
  const visuallyOpen = open && (hasFrame || hasVisibleStatus);

  // Publish the live footprint for the rail: the chat reserves gutter space
  // for a frame or a visible first-frame error, at the card's fitted width.

  // Aspect follows the live content: the last decoded frame's own size,
  // latched so a source going quiet (tap silence, stills reconnect, a
  // stills-to-tap handoff) never snaps the card back to the display-size
  // placeholder while the held frame is still on the canvas. The display
  // size is only the last-resort placeholder before any frame exists.
  // Compared by value: the sources preserve object identity when unchanged,
  // but a fresh equal pair must not re-render the card either.
  const decodedDims = tap.frameSize ?? dimensions ?? null;
  const [heldFrameDims, setHeldFrameDims] = useState(decodedDims);
  if (
    decodedDims !== null &&
    (heldFrameDims === null ||
      decodedDims.width !== heldFrameDims.width ||
      decodedDims.height !== heldFrameDims.height)
  ) {
    setHeldFrameDims({ width: decodedDims.width, height: decodedDims.height });
  }
  const frameDims = heldFrameDims ?? threadState?.screenSize ?? undefined;
  const frameAspect =
    frameDims && frameDims.height > 0 ? frameDims.width / frameDims.height : 16 / 10;
  const fitWidth = computerPreviewCardFitWidth({
    floating: floating !== undefined,
    caps,
    railBudgetPx: props.maxWidthPx,
    slotWidthPx: slotSize.width > 0 ? slotSize.width : SLOT_FALLBACK_WIDTH_PX,
    slotHeightPx: slotSize.height > 0 ? slotSize.height : SLOT_FALLBACK_HEIGHT_PX,
    frameAspect,
    viewportWidthPx: typeof window === "undefined" ? cardMaxWidth : window.innerWidth,
    viewportHeightPx: typeof window === "undefined" ? SLOT_FALLBACK_HEIGHT_PX : window.innerHeight,
  });
  // Detached-window behavior lives in the hook: stored position (clamped
  // back on screen every render so a shrinking window can never strand the
  // card), the viewport drag, and the pop-out handoff.
  const float = useComputerPreviewFloat({
    threadRef,
    cardRef,
    cardWidthPx: fitWidth,
    cardHeightPx: frameDims ? fitWidth / frameAspect : fitWidth * 0.625,
  });
  const clampedFloating = float.position;
  // The card (and its canvas) stays mounted from arm through task end so both
  // frame sources always have a decode target; visibility alone is gated on
  // content, and hidden/ended keep rendering closed for the exit animation.
  useEffect(() => {
    notePreviewLayout(
      { environmentId, threadId },
      { hasFrame, hasVisibleStatus, width: fitWidth, floating: floating !== undefined },
    );
  }, [notePreviewLayout, environmentId, threadId, hasFrame, hasVisibleStatus, fitWidth, floating]);
  const card = (
    <div
      ref={cardRef}
      role="region"
      aria-label="Computer preview"
      aria-hidden={visuallyOpen ? undefined : true}
      inert={!visuallyOpen}
      data-computer-preview-popover={threadKey}
      className={cn(
        "group pointer-events-auto flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-popover/95 text-foreground shadow-[0_16px_56px_-16px_rgb(0_0_0/0.5),0_2px_12px_-2px_rgb(0_0_0/0.3)] backdrop-blur-xl",
        floating !== undefined && "fixed z-50",
        disclosurePopClassName(visuallyOpen),
      )}
      style={
        clampedFloating !== undefined
          ? { width: fitWidth, left: clampedFloating.x, top: clampedFloating.y }
          : { width: fitWidth, maxWidth: "calc(100vw - 2rem)" }
      }
    >
      <ComputerPreviewViewport
        threadRef={threadRef}
        floating={floating !== undefined}
        frameDims={frameDims}
        hasFrame={hasFrame}
        streamStatus={streamStatus}
        statusLabel={statusLabel}
        float={float}
      >
        <canvas
          ref={canvasRef}
          aria-label={computerCanvasLabel({
            availability: threadState?.availability,
            visibleDesktop,
          })}
          tabIndex={-1}
          className="absolute inset-0 h-full w-full object-contain"
        />
      </ComputerPreviewViewport>
    </div>
  );
  // A detached card escapes the rail through a portal: the rail's own
  // translate transitions would otherwise become its fixed containing block
  // and pin the "floating" card inside the gutter.
  if (floating !== undefined && typeof document !== "undefined") {
    return createPortal(card, document.body);
  }
  return card;
}

/**
 * Element size that re-reads on every resize, starting at 0 until the first
 * observation. `offsetParent` measures the element's positioned ancestor
 * instead — the preview's slot is the ancestor, not the element itself.
 * `parent` measures the direct parent: the rail sizes from the chat column.
 */
function useObservedSize(
  ref: RefObject<HTMLElement | null>,
  options?: { readonly offsetParent?: boolean; readonly parent?: boolean },
) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const measure =
    options?.offsetParent === true ? "offsetParent" : options?.parent === true ? "parent" : "self";
  useEffect(() => {
    const element =
      measure === "offsetParent"
        ? (ref.current?.offsetParent as HTMLElement | null)
        : measure === "parent"
          ? (ref.current?.parentElement ?? null)
          : ref.current;
    if (!element) return;
    const update = () => {
      setSize((previous) => {
        const width = element.clientWidth;
        const height = element.clientHeight;
        return previous.width === width && previous.height === height
          ? previous
          : { width, height };
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, measure]);
  return size;
}

function ComputerPreviewViewport(props: {
  readonly children: ReactNode;
  readonly threadRef: ScopedThreadRef;
  readonly floating: boolean;
  readonly frameDims: { readonly width: number; readonly height: number } | undefined;
  readonly hasFrame: boolean;
  readonly streamStatus: ReturnType<typeof useComputerImageStream>["status"];
  readonly statusLabel: string | null;
  readonly float: ComputerPreviewFloat;
}) {
  const { children, threadRef, floating, frameDims, hasFrame, streamStatus, statusLabel, float } =
    props;
  return (
    <div
      className={cn(
        // A captured window reads as a screen, so the surface under it is the
        // same flat black the device frame uses — dark in every theme, never
        // a white flash before the first frame lands or while one is held.
        "relative w-full overflow-hidden bg-black",
        floating && "cursor-grab touch-none select-none active:cursor-grabbing",
      )}
      onPointerDown={float.onFloatPointerDown}
      onPointerMove={float.onFloatPointerMove}
      onPointerUp={float.onFloatPointerEnd}
      onPointerCancel={float.onFloatPointerEnd}
      style={{
        aspectRatio: frameDims ? `${frameDims.width} / ${frameDims.height}` : FALLBACK_ASPECT_RATIO,
      }}
    >
      {children}
      {/* Masks the captured window's antialiased edge fringe (the pale
          corner specks) with a 1px inner stroke, so the image meets the
          card with a finished edge. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 shadow-[inset_0_0_0_1px_rgb(0_0_0/0.45)]"
      />
      {/* Glass sheen: a faint top-down gloss over the live image. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[45%] bg-gradient-to-b from-white/[0.09] via-white/[0.02] to-transparent"
      />
      {/* The empty-state label belongs to a canvas nothing has ever decoded
          into. Once a frame landed, losing the source just holds that frame —
          no blank flash, and no label pasted over a live picture. */}
      {!hasFrame ? (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center"
          role="status"
        >
          <ComputerPreviewStreamStatus status={streamStatus} />
        </div>
      ) : null}
      {statusLabel ? (
        <div className="pointer-events-none absolute bottom-2 left-2 flex max-w-[calc(100%_-_1rem)] items-center gap-1.5 rounded-full border border-white/15 bg-black/55 px-2.5 py-1 text-xs font-medium text-white shadow-sm backdrop-blur-md">
          <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />
          <span className="truncate">{statusLabel}</span>
        </div>
      ) : null}
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute top-2 right-2 translate-y-1 opacity-0 transition-[opacity,transform] duration-200 ease-out group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100 motion-reduce:translate-y-0 motion-reduce:transition-none pointer-coarse:translate-y-0 pointer-coarse:opacity-100">
          <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-white/20 bg-gradient-to-b from-white/25 via-white/10 to-white/[0.06] p-1 shadow-[inset_0_1px_0_rgb(255_255_255/0.28),0_8px_24px_-8px_rgb(0_0_0/0.45)] backdrop-blur-md backdrop-saturate-150">
            {floating ? (
              <button
                type="button"
                onClick={float.dock}
                title="Dock the preview back into the chat rail"
                aria-label="Dock the computer preview back into the chat rail"
                className="grid size-7 place-items-center rounded-full text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)] transition-colors duration-150 hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              >
                <Minimize2Icon className="size-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={float.popOut}
                title="Float the preview as a draggable window"
                aria-label="Float the computer preview as a draggable window"
                className="grid size-7 place-items-center rounded-full text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)] transition-colors duration-150 hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
              >
                <Maximize2Icon className="size-4" />
              </button>
            )}
            <ComputerPreviewHideButton threadRef={threadRef} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ComputerPreviewHideButton(props: { readonly threadRef: ScopedThreadRef }) {
  const hidePreviewForTask = useComputerPreviewStore((store) => store.hidePreviewForTask);
  return (
    <button
      type="button"
      onClick={() => hidePreviewForTask(props.threadRef)}
      title="Hide the preview for the rest of this task"
      aria-label="Hide the computer preview for the rest of this task"
      className="grid size-7 place-items-center rounded-full text-white drop-shadow-[0_1px_2px_rgb(0_0_0/0.6)] transition-colors duration-150 hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:outline-none"
    >
      <XIcon className="size-4" />
    </button>
  );
}

function ComputerPreviewStreamStatus(props: {
  status: ReturnType<typeof useComputerImageStream>["status"];
}) {
  if (props.status.kind === "connecting") {
    return (
      <span className="text-xs text-muted-foreground" role="status">
        Connecting to the desktop…
      </span>
    );
  }
  if (props.status.kind === "unsupported") {
    return (
      <span className="text-xs text-muted-foreground">
        This browser cannot decode desktop frames.
      </span>
    );
  }
  if (props.status.kind === "error") {
    return <span className="text-xs text-muted-foreground">{props.status.message}</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      Waiting for the window the agent is using…
    </span>
  );
}
