/**
 * The Preview tab: one sandboxed message at one width.
 *
 * The drag handle writes the width straight to the DOM and only commits to React state on release.
 * A width in state per pointer move would re-render the toolbar, the readout, and the iframe's
 * container sixty times a second for a value that is already on the element — and our users notice
 * a dropped frame.
 *
 * @module components/email/EmailPreviewFrame
 */
import { EyeOffIcon, ImageIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  clampEmailPreviewWidth,
  DEFAULT_EMAIL_PREVIEW_WIDTH,
  EMAIL_DEVICE_PRESETS,
  EMAIL_PREVIEW_SANDBOX,
  emailPresetForWidth,
} from "./emailView.logic";

export function EmailPreviewFrame({
  document: srcDoc,
  remoteContentBlocked,
  onLoadRemoteContent,
  subject,
}: {
  /** The `srcdoc` for the message; changing it reloads the frame, so callers memoize it. */
  document: string;
  /** True only when the message asks for remote assets and they are still off. */
  remoteContentBlocked: boolean;
  onLoadRemoteContent: () => void;
  subject: string;
}) {
  const [width, setWidth] = useState(DEFAULT_EMAIL_PREVIEW_WIDTH);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const readoutRef = useRef<HTMLSpanElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const activePreset = emailPresetForWidth(width);

  const paint = (next: number) => {
    if (frameRef.current !== null) frameRef.current.style.width = `${next}px`;
    if (readoutRef.current !== null) readoutRef.current.textContent = `${next}px`;
  };

  // The width lives on the element, never in JSX. React re-rendering this subtree for an unrelated
  // reason mid-drag would otherwise snap the frame back to the last committed width.
  useLayoutEffect(() => {
    paint(width);
  }, [width]);

  const onHandleDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { startX: event.clientX, startWidth: width };
    setDragging(true);
  };

  const onHandleMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    // Doubled because the frame is centred: the handle is on one edge and both move.
    paint(clampEmailPreviewWidth(drag.startWidth + (event.clientX - drag.startX) * 2));
  };

  const onHandleUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.releasePointerCapture(event.pointerId);
    setWidth(clampEmailPreviewWidth(drag.startWidth + (event.clientX - drag.startX) * 2));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-3 py-1.5 sm:px-5">
        <div
          aria-label="Preview width"
          className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5"
          role="group"
        >
          {EMAIL_DEVICE_PRESETS.map((preset) => {
            const active = activePreset === preset.id;
            return (
              <button
                aria-pressed={active}
                className={cn(
                  "h-6 rounded-md px-2.5 text-xs font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
                key={preset.id}
                onClick={() => setWidth(preset.width)}
                type="button"
              >
                {preset.label}
                <span className="ms-1 tabular-nums text-muted-foreground/70">{preset.width}</span>
              </button>
            );
          })}
        </div>

        <span
          aria-live="off"
          className="rounded-md bg-muted/40 px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground"
          ref={readoutRef}
        >
          {width}px
        </span>
        {activePreset === null ? (
          <span className="text-xs text-muted-foreground/70">Custom</span>
        ) : null}

        {remoteContentBlocked ? (
          <div className="ms-auto flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <EyeOffIcon aria-hidden="true" className="size-3.5" />
              Remote images and styles are blocked
            </span>
            <Button onClick={onLoadRemoteContent} size="xs" variant="outline">
              <ImageIcon aria-hidden="true" />
              Load remote content
            </Button>
          </div>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 justify-center overflow-auto bg-muted/20 p-4">
        <div
          className="relative h-full shrink-0 rounded-lg border border-border/60 bg-white shadow-xs"
          ref={frameRef}
        >
          <iframe
            className="size-full rounded-lg"
            referrerPolicy="no-referrer"
            sandbox={EMAIL_PREVIEW_SANDBOX}
            srcDoc={srcDoc}
            title={`Preview of ${subject}`}
          />
          {/* Sits outside the frame so a drag never lands inside the sandboxed document. */}
          <div
            aria-label="Drag to resize the preview"
            className={cn(
              "absolute inset-y-0 -end-2 w-4 cursor-ew-resize touch-none",
              "after:absolute after:inset-y-0 after:start-1.5 after:w-1 after:rounded-full after:bg-border after:opacity-0 hover:after:opacity-100",
              dragging && "after:opacity-100",
            )}
            onPointerCancel={onHandleUp}
            onPointerDown={onHandleDown}
            onPointerMove={onHandleMove}
            onPointerUp={onHandleUp}
            role="separator"
          />
        </div>
      </div>
    </div>
  );
}
