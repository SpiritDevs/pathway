import { RegistryContext } from "@effect/atom-react";
import {
  createEnvironmentSurfaceStream,
  createSurfaceSocketAtoms,
  type DecodedSurfaceFrame,
  type SurfaceConnectionState,
  type SurfaceQuality,
} from "@spiritdevs/client-runtime/surface";
import { runAtomCommand, squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import type {
  EnvironmentId,
  EnvironmentSurfaceSizing,
  EnvironmentSurfaceViewport,
  PreviewTabId,
  ThreadId,
} from "@spiritdevs/contracts";
import { useContext, useEffect, useRef, useState, type RefObject } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";

import { sameSurfaceViewport, surfaceViewportFor } from "./remoteBrowserSurface";

const surfaceSocket = createSurfaceSocketAtoms(connectionAtomRuntime);

/** Resizing reconnects the stream, so wait for the panel to settle. */
const VIEWPORT_SETTLE_MS = 250;

/** The CSS size of the page in the latest frame, for mapping input. */
export interface SurfacePageSize {
  width: number;
  height: number;
}

/**
 * Streams one environment browser tab into `canvasRef` over the binary surface
 * socket. Frames are drawn straight to the canvas without a React render; only
 * the connection state and a once-a-second quality sample re-render. The
 * stream pauses while the view or the page is hidden.
 */
export function useRemoteBrowserSurface({
  environmentId,
  threadId,
  tabId,
  enabled,
  sizing = "active",
  containerRef,
  canvasRef,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  tabId: PreviewTabId | undefined;
  enabled: boolean;
  /** Passive viewers (thumbnails) watch without resizing the page the agent sees. */
  sizing?: EnvironmentSurfaceSizing;
  containerRef: RefObject<HTMLElement | null>;
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  const registry = useContext(RegistryContext);
  const [state, setState] = useState<SurfaceConnectionState>("connecting");
  const [quality, setQuality] = useState<SurfaceQuality | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [viewport, setViewport] = useState<EnvironmentSurfaceViewport | null>(null);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const pageSize = useRef<SurfacePageSize | null>(null);
  const stream = useRef<ReturnType<typeof createEnvironmentSurfaceStream> | null>(null);
  const streamViewport = useRef<EnvironmentSurfaceViewport | null>(null);

  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const box = container.getBoundingClientRect();
      const next = surfaceViewportFor(box, window.devicePixelRatio);
      setViewport((current) => (sameSurfaceViewport(current, next) ? current : next));
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      // The first measurement connects immediately; later ones wait to settle.
      timer = setTimeout(measure, stream.current ? VIEWPORT_SETTLE_MS : 0);
    });
    observer.observe(container);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [containerRef, enabled]);

  const live = enabled && pageVisible && tabId !== undefined && viewport !== null;
  // The viewport is read at creation and then pushed with setViewport, so a
  // resize reconnects the socket without tearing down the painted canvas.
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;

  useEffect(() => {
    const initial = viewportRef.current;
    if (!live || !tabId || !initial) return;
    const target = { kind: "browser" as const, threadId, tabId };
    pageSize.current = null;
    setHasFrame(false);
    setQuality(null);
    const draw = (frame: DecodedSurfaceFrame) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      pageSize.current = {
        width: frame.width / frame.deviceScale,
        height: frame.height / frame.deviceScale,
      };
      const paint = (image: CanvasImageSource, width: number, height: number) => {
        if (canvas.width !== width) canvas.width = width;
        if (canvas.height !== height) canvas.height = height;
        canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
      };
      if (typeof frame.image !== "string") {
        paint(frame.image, frame.image.width, frame.image.height);
      } else {
        // Clients without JPEG ImageBitmap support get a Blob URL instead.
        const image = new Image();
        image.addEventListener(
          "load",
          () => paint(image, image.naturalWidth, image.naturalHeight),
          {
            once: true,
          },
        );
        image.src = frame.image;
      }
      setHasFrame(true);
    };
    const created = createEnvironmentSurfaceStream({
      viewport: initial,
      sizing,
      resolveUrl: async (next, nextSizing) => {
        const result = await runAtomCommand(
          registry,
          surfaceSocket.resolveUrl,
          { environmentId, input: { target, viewport: next, sizing: nextSizing } },
          { reportFailure: false },
        );
        if (result._tag === "Success") return result.value;
        const failure = squashAtomCommandFailure(result);
        throw failure instanceof Error ? failure : new Error("Could not authorize the stream.");
      },
      onFrame: draw,
      onState: setState,
      onQuality: setQuality,
    });
    stream.current = created;
    streamViewport.current = initial;
    return () => {
      created.close();
      if (stream.current === created) stream.current = null;
    };
  }, [canvasRef, environmentId, live, registry, sizing, tabId, threadId]);

  useEffect(() => {
    if (!viewport || !stream.current || sameSurfaceViewport(streamViewport.current, viewport))
      return;
    streamViewport.current = viewport;
    stream.current.setViewport(viewport);
  }, [viewport]);

  return {
    state,
    quality,
    hasFrame,
    pageSize,
    reconnect: () => stream.current?.resume(),
  };
}
