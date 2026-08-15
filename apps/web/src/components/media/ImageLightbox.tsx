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
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  clampPanOffset,
  imageDownloadFileName,
  MIN_IMAGE_ZOOM,
  steppedZoom,
  wrapImageIndex,
} from "./imageLightbox.logic";
import { copyImageToClipboard, downloadImageFile } from "./imageTransfer";

export interface LightboxImage {
  readonly src: string;
  readonly name: string;
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
            className="text-white/80 hover:bg-white/10 hover:text-white"
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="ghost"
          >
            <Icon />
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
  const viewportRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);

  const image = images[wrapImageIndex(index, images.length)];
  const multiple = images.length > 1;

  const resetView = useCallback(() => {
    setZoom(MIN_IMAGE_ZOOM);
    setPan(ORIGIN);
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

  const changeZoom = useCallback((direction: -1 | 1) => {
    setZoom((current) => {
      const next = steppedZoom(current, direction);
      if (next === MIN_IMAGE_ZOOM) setPan(ORIGIN);
      return next;
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable === true;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (commentOpen) {
          setCommentOpen(false);
          return;
        }
        onClose();
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
        changeZoom(1);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        changeZoom(-1);
        return;
      }
      if (event.key !== "0") return;
      event.preventDefault();
      resetView();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [changeZoom, commentOpen, images.length, navigate, onClose, resetView]);

  useEffect(() => {
    if (commentOpen) commentRef.current?.focus();
  }, [commentOpen]);

  const onPointerDown = (event: ReactPointerEvent<HTMLImageElement>) => {
    if (zoom === MIN_IMAGE_ZOOM) return;
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
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const runTransfer = (title: string, transfer: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    void transfer()
      .catch((error: unknown) => reportImageFailure(title, error))
      .finally(() => setBusy(false));
  };

  if (image === undefined) return null;

  const submitComment = () => {
    const body = commentBody.trim();
    if (body.length === 0 || comment === undefined) return;
    comment.onSubmit(body, image, index);
    setCommentBody("");
    setCommentOpen(false);
  };

  // Portalled to the body: the viewer opens from panels that clip, scroll, and transform,
  // and a `fixed` overlay inside one of those would be trapped by it.
  return createPortal(
    <div
      aria-label="Image viewer"
      aria-modal="true"
      className="fixed inset-0 z-50 flex flex-col bg-black/85 [-webkit-app-region:no-drag]"
      role="dialog"
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
            disabled={zoom === MIN_IMAGE_ZOOM}
            icon={ZoomOutIcon}
            label="Zoom out"
            onClick={() => changeZoom(-1)}
          />
          <Button
            className="min-w-12 text-white/80 tabular-nums hover:bg-white/10 hover:text-white"
            onClick={resetView}
            size="sm"
            variant="ghost"
          >
            {Math.round(zoom * 100)}%
          </Button>
          <IconAction icon={ZoomInIcon} label="Zoom in" onClick={() => changeZoom(1)} />
          <IconAction
            icon={ExternalLinkIcon}
            label="Open in browser"
            onClick={() => {
              void readLocalApi()
                ?.shell.openExternal(image.src)
                .catch((error: unknown) => reportImageFailure("Could not open the image", error));
            }}
          />
          <IconAction icon={XIcon} label="Close image viewer" onClick={onClose} />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
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
          <img
            alt={image.name}
            className={cn(
              "pointer-events-auto max-h-full max-w-full select-none object-contain",
              zoom === MIN_IMAGE_ZOOM ? "cursor-zoom-in" : "cursor-grab active:cursor-grabbing",
            )}
            draggable={false}
            onDoubleClick={() => (zoom === MIN_IMAGE_ZOOM ? changeZoom(1) : resetView())}
            onError={() => onImageError?.(image, index)}
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
        </div>
        {multiple ? (
          <>
            <Button
              aria-label="Previous image"
              className="-translate-y-1/2 absolute top-1/2 left-2 text-white/90 hover:bg-white/10 hover:text-white sm:left-6"
              onClick={() => navigate(-1)}
              size="icon"
              variant="ghost"
            >
              <ChevronLeftIcon className="size-5" />
            </Button>
            <Button
              aria-label="Next image"
              className="-translate-y-1/2 absolute top-1/2 right-2 text-white/90 hover:bg-white/10 hover:text-white sm:right-6"
              onClick={() => navigate(1)}
              size="icon"
              variant="ghost"
            >
              <ChevronRightIcon className="size-5" />
            </Button>
          </>
        ) : null}
      </div>

      <footer className="flex shrink-0 flex-col gap-2 border-white/10 border-t px-3 py-2">
        {multiple ? (
          <ul className="flex justify-center gap-1.5 overflow-x-auto">
            {images.map((thumbnail, thumbnailIndex) => (
              <li key={`${thumbnail.name}:${thumbnail.src}`}>
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
                >
                  <img
                    alt=""
                    className="size-full object-cover"
                    draggable={false}
                    onError={() => onImageError?.(thumbnail, thumbnailIndex)}
                    src={thumbnail.src}
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-center gap-1.5">
          <Button
            disabled={busy}
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
            disabled={busy}
            onClick={() =>
              runTransfer("Could not copy the image", () => copyImageToClipboard(image.src))
            }
            size="sm"
            variant="outline"
          >
            <CopyIcon />
            Copy
          </Button>
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
    </div>,
    document.body,
  );
});
