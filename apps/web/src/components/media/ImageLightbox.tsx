import type { SnapShotSource } from "@spiritdevs/contracts";
import { Dialog } from "@base-ui/react/dialog";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "../chat/SnapShotAttachmentDetails";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  XIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  clampPanOffset,
  imageDownloadFileName,
  MIN_IMAGE_ZOOM,
  MAX_IMAGE_ZOOM,
  steppedZoom,
  wrapImageIndex,
} from "./imageLightbox.logic";
import { copyImageToClipboard, downloadImageFile } from "./imageTransfer";

export interface LightboxImage {
  readonly src: string;
  readonly name: string;
  readonly loading?: boolean;
  readonly source?: SnapShotSource | undefined;
}

/** A call-site action, rendered in the footer beside the built-in ones. */
export interface ImageLightboxAction {
  readonly id: string;
  readonly label: string;
  readonly icon: LucideIcon;
  readonly disabled?: boolean;
  readonly onSelect: (image: LightboxImage, index: number) => void;
}

export interface ImageLightboxCommentSupport {
  readonly placeholder?: string;
  readonly pending?: boolean;
  readonly onSubmit: (body: string, image: LightboxImage, index: number) => void;
}

export interface ImageLightboxProps {
  readonly images: ReadonlyArray<LightboxImage>;
  readonly initialIndex?: number;
  readonly actions?: ReadonlyArray<ImageLightboxAction>;
  /** When supplied, the footer grows a comment box that posts against the shown image. */
  readonly comment?: ImageLightboxCommentSupport;
  readonly onClose: () => void;
  readonly onImageError?: (image: LightboxImage, index: number) => void;
}

const NO_ACTIONS: ReadonlyArray<ImageLightboxAction> = [];
const ORIGIN = { x: 0, y: 0 } as const;

function reportImageFailure(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

function IconAction({
  icon: Icon,
  label,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="text-white/80 [:hover,[data-pressed]]:bg-white/10 hover:text-white"
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          >
            <Icon className="text-current" />
          </Button>
        }
      />
      <TooltipPopup side="bottom">{label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Full-window image viewer: a slideshow over one gallery with zoom, save, and
 * whatever contextual actions the call site provides. Nothing here leaves the app.
 */
export const ImageLightbox = memo(function ImageLightbox({
  images,
  initialIndex = 0,
  actions = NO_ACTIONS,
  comment,
  onClose,
  onImageError,
}: ImageLightboxProps) {
  const [index, setIndex] = useState(() => wrapImageIndex(initialIndex, images.length));
  const [zoom, setZoom] = useState<number>(MIN_IMAGE_ZOOM);
  const [pan, setPan] = useState<{ x: number; y: number }>(ORIGIN);
  const [commentOpen, setCommentOpen] = useState(false);
  const [commentBody, setCommentBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [showContents, setShowContents] = useState(false);
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const swipeRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const wheelRef = useRef({ total: 0, lastTime: 0, navigated: false });
  const selectedThumbnailRef = useRef<HTMLButtonElement>(null);

  const image = images[wrapImageIndex(index, images.length)];
  const multiple = images.length > 1;
  const imageUnavailable = !image?.src || failedSource === image.src;

  const resetView = useCallback(() => {
    setShowContents(false);
    setZoom(MIN_IMAGE_ZOOM);
    setPan(ORIGIN);
    dragRef.current = null;
    swipeRef.current = null;
  }, []);

  const navigate = useCallback(
    (direction: -1 | 1) => {
      setIndex((current) => wrapImageIndex(current + direction, images.length));
      resetView();
    },
    [images.length, resetView],
  );

  const showImage = useCallback(
    (next: number) => {
      setIndex(wrapImageIndex(next, images.length));
      resetView();
    },
    [images.length, resetView],
  );

  const changeZoom = useCallback(
    (direction: -1 | 1) => {
      const next = steppedZoom(zoom, direction);
      setZoom(next);
      const viewport = viewportRef.current;
      const element = imageRef.current;
      if (next === MIN_IMAGE_ZOOM) setPan(ORIGIN);
      else if (viewport && element) {
        setPan((current) => ({
          x: clampPanOffset(current.x, element.offsetWidth * next - viewport.clientWidth),
          y: clampPanOffset(current.y, element.offsetHeight * next - viewport.clientHeight),
        }));
      }
    },
    [zoom],
  );

  const onKeyDown = (event: ReactKeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    const typing =
      target?.tagName === "TEXTAREA" ||
      target?.tagName === "INPUT" ||
      target?.isContentEditable === true;

    if (event.key === "Escape" && commentOpen) {
      event.preventDefault();
      event.stopPropagation();
      setCommentOpen(false);
      return;
    }
    if (typing) return;
    if (event.key === "ArrowLeft" && images.length > 1) {
      event.preventDefault();
      event.stopPropagation();
      navigate(-1);
      return;
    }
    if (event.key === "ArrowRight" && images.length > 1) {
      event.preventDefault();
      event.stopPropagation();
      navigate(1);
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      event.stopPropagation();
      changeZoom(1);
      return;
    }
    if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      event.stopPropagation();
      changeZoom(-1);
      return;
    }
    if (event.key !== "0") return;
    event.preventDefault();
    event.stopPropagation();
    resetView();
  };

  useEffect(() => {
    selectedThumbnailRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [index]);

  useEffect(() => {
    if (commentOpen) commentRef.current?.focus();
  }, [commentOpen]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (event.button !== 0) return;
    if (zoom === MIN_IMAGE_ZOOM) {
      if (event.pointerType !== "mouse" && multiple) {
        swipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      return;
    }
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    const viewport = viewportRef.current;
    const element = imageRef.current;
    if (drag === null || drag.pointerId !== event.pointerId || !viewport || !element) return;
    const deltaX = event.clientX - drag.x;
    const deltaY = event.clientY - drag.y;
    dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    setPan((current) => ({
      x: clampPanOffset(current.x + deltaX, element.offsetWidth * zoom - viewport.clientWidth),
      y: clampPanOffset(current.y + deltaY, element.offsetHeight * zoom - viewport.clientHeight),
    }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLImageElement>) => {
    const swipe = swipeRef.current;
    if (swipe?.pointerId === event.pointerId && event.type !== "pointercancel") {
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) navigate(dx < 0 ? 1 : -1);
    }
    swipeRef.current = null;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const runTransfer = (title: string, transfer: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void transfer()
      .catch((error: unknown) => reportImageFailure(title, error))
      .finally(() => setBusy(false));
  };

  if (image === undefined) return null;
  const contents =
    showContents && image.source ? snapShotAccessibilityDetails(image.source) : undefined;
  const hasContents = Boolean(
    image.source && (image.source.accessibility || image.source.accessibleText?.trim()),
  );

  const submitComment = () => {
    const body = commentBody.trim();
    if (body.length === 0 || comment === undefined) return;
    comment.onSubmit(body, image, index);
    setCommentBody("");
    setCommentOpen(false);
  };

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup
          aria-label="Image viewer"
          className="fixed inset-0 z-[140] flex flex-col bg-black/85 outline-none [-webkit-app-region:no-drag]"
          onKeyDown={onKeyDown}
        >
          <header className="flex shrink-0 items-center gap-2 border-white/10 border-b px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm text-white/90">{image.name}</span>
              {multiple ? (
                <span className="text-[11px] text-white/50 tabular-nums">
                  {index + 1} of {images.length}
                </span>
              ) : null}
            </div>
            <div className="ms-auto flex items-center gap-1">
              <IconAction
                disabled={imageUnavailable || zoom === MIN_IMAGE_ZOOM}
                icon={ZoomOutIcon}
                label="Zoom out"
                onClick={() => changeZoom(-1)}
              />
              <Button
                aria-label="Fit image to window"
                className="min-w-12 text-white/80 tabular-nums [:hover,[data-pressed]]:bg-white/10 hover:text-white"
                onClick={resetView}
                size="sm"
                variant="ghost"
              >
                {Math.round(zoom * 100)}%
              </Button>
              <IconAction
                disabled={imageUnavailable || zoom === MAX_IMAGE_ZOOM}
                icon={ZoomInIcon}
                label="Zoom in"
                onClick={() => changeZoom(1)}
              />
              <IconAction
                icon={ExternalLinkIcon}
                disabled={imageUnavailable}
                label="Open in browser"
                onClick={() => {
                  void readLocalApi()
                    ?.shell.openExternal(image.src)
                    .catch((error: unknown) =>
                      reportImageFailure("Could not open the image", error),
                    );
                }}
              />
              <Dialog.Close
                render={
                  <Button
                    aria-label="Close image viewer"
                    title="Close image viewer"
                    className="text-white/80 [:hover,[data-pressed]]:bg-white/10 hover:text-white"
                    size="icon-sm"
                    variant="ghost"
                  >
                    <XIcon className="text-current" />
                  </Button>
                }
              />
            </div>
          </header>

          <div
            className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
            onWheel={(event) => {
              if (!multiple || zoom !== MIN_IMAGE_ZOOM || event.ctrlKey || showContents) return;
              const delta = event.shiftKey ? event.deltaY : event.deltaX;
              if (!delta || (!event.shiftKey && Math.abs(delta) <= Math.abs(event.deltaY))) return;
              const wheel = wheelRef.current;
              if (event.timeStamp - wheel.lastTime > 180) {
                wheel.total = 0;
                wheel.navigated = false;
              }
              wheel.lastTime = event.timeStamp;
              if (wheel.navigated) return;
              wheel.total += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
              if (Math.abs(wheel.total) < 60) return;
              wheel.navigated = true;
              navigate(wheel.total > 0 ? 1 : -1);
            }}
          >
            <button
              aria-label="Close image viewer"
              className="absolute inset-0 cursor-zoom-out"
              onClick={onClose}
              type="button"
            />
            <div
              className="pointer-events-none relative flex size-full items-center justify-center p-4"
              ref={viewportRef}
            >
              {showContents && contents ? (
                <SnapShotAccessibilityData
                  details={contents}
                  className="pointer-events-auto h-full w-full max-w-3xl rounded-lg bg-background p-4 text-xs leading-5 text-foreground"
                />
              ) : image.loading || imageUnavailable ? (
                <p role="status" className="text-sm text-white/70">
                  {image.loading ? "Loading image…" : "This image could not be loaded."}
                </p>
              ) : (
                <img
                  key={image.src}
                  alt={image.name}
                  className={cn(
                    "pointer-events-auto max-h-full max-w-full touch-none select-none object-contain",
                    zoom === MIN_IMAGE_ZOOM
                      ? "cursor-zoom-in"
                      : "cursor-grab active:cursor-grabbing",
                  )}
                  draggable={false}
                  onDoubleClick={() => (zoom === MIN_IMAGE_ZOOM ? changeZoom(1) : resetView())}
                  onError={() => {
                    setFailedSource(image.src);
                    onImageError?.(image, index);
                  }}
                  onPointerCancel={endDrag}
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={endDrag}
                  ref={imageRef}
                  src={image.src}
                  style={{
                    transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
                  }}
                />
              )}
            </div>
            {multiple ? (
              <>
                <Button
                  aria-label="Previous image"
                  className="-translate-y-1/2 absolute top-1/2 left-2 border border-white/15 bg-black/60 text-white [:hover,[data-pressed]]:bg-black/80 hover:text-white sm:left-6"
                  onClick={() => navigate(-1)}
                  size="icon"
                  variant="ghost"
                >
                  <ChevronLeftIcon className="size-5 text-current" />
                </Button>
                <Button
                  aria-label="Next image"
                  className="-translate-y-1/2 absolute top-1/2 right-2 border border-white/15 bg-black/60 text-white [:hover,[data-pressed]]:bg-black/80 hover:text-white sm:right-6"
                  onClick={() => navigate(1)}
                  size="icon"
                  variant="ghost"
                >
                  <ChevronRightIcon className="size-5 text-current" />
                </Button>
              </>
            ) : null}
          </div>

          <footer className="flex shrink-0 flex-col gap-2 border-white/10 border-t px-3 py-2">
            {multiple ? (
              <ul className="flex gap-1.5 overflow-x-auto overscroll-x-contain py-1">
                {images.map((thumbnail, thumbnailIndex) => (
                  <li
                    className="shrink-0 first:ms-auto last:me-auto"
                    key={`${thumbnail.name}:${thumbnail.src}`}
                  >
                    <button
                      aria-current={thumbnailIndex === index}
                      aria-label={`Show ${thumbnail.name}`}
                      className={cn(
                        "block size-12 shrink-0 overflow-hidden rounded-md border transition-opacity",
                        thumbnailIndex === index
                          ? "border-white/80"
                          : "border-white/20 opacity-60 hover:opacity-100",
                      )}
                      onClick={() => showImage(thumbnailIndex)}
                      type="button"
                      ref={thumbnailIndex === index ? selectedThumbnailRef : undefined}
                    >
                      {thumbnail.src ? (
                        <img
                          alt=""
                          className="size-full object-cover"
                          draggable={false}
                          loading="lazy"
                          onError={() => onImageError?.(thumbnail, thumbnailIndex)}
                          src={thumbnail.src}
                        />
                      ) : (
                        <span className="text-xs text-white/60">{thumbnailIndex + 1}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            <div className="flex flex-wrap items-center justify-center gap-1.5">
              <Button
                disabled={busy || imageUnavailable}
                onClick={() =>
                  runTransfer("Could not download the image", () =>
                    downloadImageFile(image.src, imageDownloadFileName(image.name, image.src)),
                  )
                }
                size="sm"
                variant="outline"
              >
                <DownloadIcon />
                Download
              </Button>
              <Button
                disabled={busy || imageUnavailable}
                onClick={() =>
                  runTransfer("Could not copy the image", () => copyImageToClipboard(image.src))
                }
                size="sm"
                variant="outline"
              >
                <CopyIcon />
                Copy
              </Button>
              {hasContents ? (
                <Button
                  aria-pressed={showContents}
                  onClick={() => setShowContents((current) => !current)}
                  size="sm"
                  variant="outline"
                >
                  {showContents
                    ? "Show screenshot"
                    : image.source?.accessibility?.format === "element-tree"
                      ? "Show accessibility JSON"
                      : "Show extracted text"}
                </Button>
              ) : image.source ? (
                <SnapShotContentsButton source={image.source} side="top" />
              ) : null}
              {actions.map((action) => (
                <Button
                  disabled={action.disabled === true}
                  key={action.id}
                  onClick={() => action.onSelect(image, index)}
                  size="sm"
                  variant="outline"
                >
                  <action.icon />
                  {action.label}
                </Button>
              ))}
              {comment === undefined ? null : (
                <Button
                  onClick={() => setCommentOpen((open) => !open)}
                  size="sm"
                  variant={commentOpen ? "secondary" : "outline"}
                >
                  <MessageSquarePlusIcon />
                  Comment
                </Button>
              )}
            </div>

            {comment !== undefined && commentOpen ? (
              <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
                <textarea
                  aria-label="Comment on this image"
                  className="min-h-16 flex-1 resize-y rounded-md border border-white/20 bg-black/40 px-2 py-1.5 text-sm text-white outline-none placeholder:text-white/40 focus-visible:ring-2 focus-visible:ring-ring"
                  onChange={(event) => setCommentBody(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
                    event.preventDefault();
                    submitComment();
                  }}
                  placeholder={comment.placeholder ?? "Add a comment about this image…"}
                  ref={commentRef}
                  value={commentBody}
                />
                <Button
                  disabled={commentBody.trim().length === 0 || comment.pending === true}
                  onClick={submitComment}
                  size="sm"
                >
                  Comment
                </Button>
              </div>
            ) : null}
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
});
