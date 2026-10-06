import { Dialog } from "@base-ui/react/dialog";
import type { EnvironmentId } from "@spiritdevs/contracts";
import {
  HTML_RENDER_COLUMN_WIDTH,
  clampHtmlRenderHeight,
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  type HtmlRenderReference,
} from "@spiritdevs/shared/htmlRender";
import { ExternalLinkIcon, Maximize2Icon, RotateCwIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { HtmlRenderDocument, openHtmlRenderUrl } from "./HtmlRenderDocument";

/**
 * The signed inline URL for a render, from the environment that owns the
 * thread. The first URL is kept for the caller's lifetime, because a new src
 * would reload the page; a remount or explicit reload reads a fresh one.
 */
function useHtmlRenderUrl(environmentId: EnvironmentId, htmlRender: HtmlRenderReference) {
  const { attachmentId } = htmlRender;
  const fileName = htmlRenderFileName(htmlRender.title);
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId,
      fileName,
      mimeType: "text/html",
      disposition: "inline" as const,
    }),
    [attachmentId, fileName],
  );
  const asset = useAssetUrlState(environmentId, resource);
  const current = asset._tag === "Success" ? asset.url : null;
  const [first, setFirst] = useState<string | null>(null);
  const [reloadCount, setReloadCount] = useState(0);
  if (first === null && current !== null) setFirst(current);
  return {
    src: first ?? current,
    current,
    reloadCount,
    reload: () => {
      setFirst(current);
      setReloadCount((count) => count + 1);
      if (current === null) asset.refresh?.();
    },
    // A page can reload itself after its frozen token expires. Only rotate the
    // URL on a load, keeping query refreshes from resetting a live document.
    onLoad: () => {
      if (current !== null && current !== first) setFirst(current);
    },
    retry: asset._tag === "Failure" ? (asset.refresh ?? null) : null,
    failed: asset._tag === "Failure",
  };
}

function HtmlRenderUnavailable(props: {
  readonly title: string;
  readonly retry: (() => void) | null;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 text-muted-foreground text-xs">
      <p>Unable to load {props.title}</p>
      {props.retry !== null ? (
        <Button size="xs" variant="outline" onClick={props.retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at the server's measured height for this width until the
 * page reports its own. Loading and failure hold the same box so nothing below
 * it moves.
 */
export function HtmlRenderFrame(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly onExpand: (htmlRender: HtmlRenderReference) => void;
}) {
  const { title } = props.htmlRender;
  // The frame takes the page's measured height at its own width, read before
  // first paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Client fonts can wrap a page taller than the server measured it; a frame
  // left short would scroll inside the thread and take the reader's scroll.
  const [contentHeight, setContentHeight] = useState<number>();
  const onContentHeight = useCallback(
    (height: number) => setContentHeight(clampHtmlRenderHeight(height)),
    [],
  );
  const height = htmlRenderFrameHeight(props.htmlRender, width, contentHeight);
  const { src, retry, failed, reload, reloadCount, onLoad } = useHtmlRenderUrl(
    props.environmentId,
    props.htmlRender,
  );

  return (
    <div ref={boxRef} className="group/html-render relative" style={{ height }}>
      {src !== null ? (
        <>
          <HtmlRenderDocument
            key={`${src}:${reloadCount}`}
            src={src}
            title={title}
            className="block size-full"
            onContentHeight={onContentHeight}
            onLoad={onLoad}
          />
          <div className="absolute end-2 top-2 flex gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            <Button
              aria-label="Reload page"
              title="Reload page"
              size="icon-xs"
              variant="outline"
              onClick={reload}
            >
              <RotateCwIcon className="size-3.5" />
            </Button>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open full size"
                    size="icon-xs"
                    variant="outline"
                    onClick={() => props.onExpand(props.htmlRender)}
                  />
                }
              >
                <Maximize2Icon className="size-3.5" />
              </TooltipTrigger>
              <TooltipPopup side="left">Open full size</TooltipPopup>
            </Tooltip>
          </div>
        </>
      ) : failed ? (
        <HtmlRenderUnavailable title={title} retry={retry} />
      ) : null}
    </div>
  );
}

/**
 * A render at full window size. The page scrolls inside the dialog rather than
 * fitting its height. Close with the button or Esc while the app has focus.
 */
export function HtmlRenderDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly htmlRender: HtmlRenderReference;
  readonly onClose: () => void;
}) {
  const { title } = props.htmlRender;
  const theme = useHtmlRenderTheme();
  const { src, current, retry, failed, reload, reloadCount, onLoad } = useHtmlRenderUrl(
    props.environmentId,
    props.htmlRender,
  );

  // The dialog covers the title bar, where the native window buttons sit.
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge?.setWindowButtonsVisible) return;
    const setVisible = (visible: boolean) => {
      void bridge.setWindowButtonsVisible?.(visible).catch((error: unknown) => {
        console.error("Could not update native window buttons", error);
      });
    };
    setVisible(false);
    return () => setVisible(true);
  }, []);

  const browserUrl = current;
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-[140] flex flex-col bg-background outline-none [-webkit-app-region:no-drag]">
          <header className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
            <Dialog.Title className="min-w-0 truncate font-medium text-sm">{title}</Dialog.Title>
            <div className="ms-auto flex items-center gap-1">
              <Button
                aria-label="Reload page"
                title="Reload page"
                size="icon-sm"
                variant="ghost"
                onClick={reload}
              >
                <RotateCwIcon />
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label="Open in browser"
                      disabled={browserUrl === null}
                      size="icon-sm"
                      variant="ghost"
                      onClick={() => {
                        if (browserUrl === null) return;
                        // The page reads the theme from its fragment, as it does in the thread.
                        openHtmlRenderUrl(
                          `${browserUrl.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`,
                        );
                      }}
                    />
                  }
                >
                  <ExternalLinkIcon />
                </TooltipTrigger>
                <TooltipPopup side="bottom">Open in browser</TooltipPopup>
              </Tooltip>
              <Dialog.Close
                render={
                  <Button aria-label="Close" title="Close" size="icon-sm" variant="ghost">
                    <XIcon />
                  </Button>
                }
              />
            </div>
          </header>
          {src !== null ? (
            <HtmlRenderDocument
              key={`${src}:${reloadCount}`}
              src={src}
              title={title}
              className="min-h-0 w-full flex-1"
              onLoad={onLoad}
            />
          ) : failed ? (
            <div className="min-h-0 flex-1">
              <HtmlRenderUnavailable title={title} retry={retry} />
            </div>
          ) : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
