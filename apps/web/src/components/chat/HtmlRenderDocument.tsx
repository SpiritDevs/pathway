import {
  type HtmlRenderTheme,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@spiritdevs/shared/htmlRender";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";

import { stackedThreadToast, toastManager } from "../ui/toast";

/** Opens a render's link, or the render itself, in the browser. */
export function openHtmlRenderUrl(url: string) {
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) return;
  } catch {
    return;
  }
  // Desktop hands the URL to the system browser; web opens a noopener tab
  // synchronously, while the reader's activation still counts.
  void readLocalApi()
    ?.shell.openExternal(url)
    .catch((error: unknown) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not open the link",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
    );
}

function withBackground(theme: HtmlRenderTheme, background: string | undefined): HtmlRenderTheme {
  if (background === undefined || background === theme.variables["--background"]) return theme;
  return { ...theme, variables: { ...theme.variables, "--background": background } };
}

/**
 * A sandboxed agent HTML render in the app theme. The page reads the theme from
 * its URL fragment before first paint, then follows changes posted to its
 * bootstrap. The first URL is kept for the frame's lifetime: signed asset URLs
 * re-mint while it stays mounted, and a new src would reload the page.
 */
export function HtmlRenderDocument(props: {
  readonly src: string;
  readonly title: string;
  readonly className?: string;
  /** Receives the page's content height whenever it changes, so an inline frame can fit it. */
  readonly onContentHeight?: (height: number) => void;
  readonly onLoad?: () => void;
}) {
  const paletteTheme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [baseSrc] = useState(() => props.src.split("#", 1)[0]);
  const [src, setSrc] = useState(() => `${baseSrc}${htmlRenderThemeFragment(paletteTheme)}`);
  const [hostBackground, setHostBackground] = useState<string>();
  const theme = useMemo(
    () => withBackground(paletteTheme, hostBackground),
    [paletteTheme, hostBackground],
  );
  // The page should sit on the surface that hosts it, and app CSS repaints
  // some surfaces past the palette's canvas (dark threads, for one). Theme
  // changes apply to the DOM before they reach React, so this reads the new
  // surface. The first read also corrects the URL before the page loads.
  const checkedFirstSrc = useRef(false);
  useLayoutEffect(() => {
    const frame = frameRef.current;
    const background =
      frame === null || typeof getComputedStyle !== "function"
        ? ""
        : getComputedStyle(frame).getPropertyValue("--background").trim();
    setHostBackground(background || undefined);
    if (checkedFirstSrc.current) return;
    checkedFirstSrc.current = true;
    if (background) {
      setSrc(`${baseSrc}${htmlRenderThemeFragment(withBackground(paletteTheme, background))}`);
    }
  }, [paletteTheme, baseSrc]);
  const [loaded, setLoaded] = useState(false);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  useEffect(postTheme, [theme]);
  // The page cannot open windows itself. It asks the client, which opens the
  // link only while this frame has focus and the reader has just used the app.
  // A page can take focus by script, so this stops opens on load, not a page
  // that waits for the reader's next click or key.
  useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        request === undefined ||
        frame === null ||
        event.source !== frame.contentWindow ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive !== true
      ) {
        return;
      }
      openHtmlRenderUrl(request.url);
      frame.contentWindow?.postMessage(htmlRenderResult(request.id), "*");
    };
    window.addEventListener("message", openLink);
    return () => window.removeEventListener("message", openLink);
  }, []);
  const { onContentHeight } = props;
  // A page posts its height once per change, so listen from the commit that
  // inserts the frame; a passive effect could run after a fast page's first post.
  useLayoutEffect(() => {
    if (onContentHeight === undefined) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) {
        onContentHeight(height);
      }
    };
    window.addEventListener("message", resize);
    return () => window.removeEventListener("message", resize);
  }, [onContentHeight]);
  return (
    <iframe
      ref={frameRef}
      src={src}
      title={props.title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      loading="lazy"
      onLoad={() => {
        setLoaded(true);
        // Covers a theme change that landed while the page was loading.
        postTheme();
        props.onLoad?.();
      }}
      // A frame whose color scheme differs from its document's paints an opaque
      // canvas, so the blank document a frame starts with would flash white in
      // dark mode. Once the page is in, its prefers-color-scheme follows the app.
      className={cn("border-0 scheme-light", props.className)}
      style={loaded ? { colorScheme: theme.appearance } : undefined}
    />
  );
}
