import { RegistryContext } from "@effect/atom-react";
import type { ComputerId, EnvironmentId } from "@spiritdevs/contracts";
import type { ComputerFrame } from "@spiritdevs/shared/computerFrame";
import { useContext, useEffect, useRef, useState } from "react";

import {
  createComputerFrameGateState,
  stepComputerFrameGate,
  type ComputerFrameGateState,
} from "./ComputerPanel.logic";
import {
  createComputerFrameSource,
  type ComputerFrameSource,
  type ComputerFrameSourceClose,
  type ComputerFrameSourceResetReason,
} from "~/lib/computerFrameSource";
import { useConnectedGeneration } from "~/hooks/useComputerEventBridge";
import type { ComputerFrameSocketUrl } from "@spiritdevs/client-runtime/state/computer-frame-socket";
import { resolveComputerFrameSocketUrl } from "./computerFrameSocketUrl";

const FRAME_RECONNECT_MAX_DELAY_MS = 5_000;
/**
 * Consecutive closes without a frame before the stream gives up. A browser
 * cannot read a refused upgrade's status, so a missing route, a computer
 * that went away and a refused ticket all look like this; the preview says
 * so instead of spinning on "connecting".
 */
const FRAME_RECONNECT_MAX_ATTEMPTS = 5;
/** A ticket this close to its expiry is replaced before the next connect. */
const FRAME_TICKET_REFRESH_MARGIN_MS = 30_000;
/** A policy close is a refusal a retry cannot change. */
const POLICY_VIOLATION_CLOSE_CODE = 1008;
export const COMPUTER_LIVE_VIEW_UNAVAILABLE = "Live view unavailable";

export interface ComputerImageDimensions {
  readonly width: number;
  readonly height: number;
}

export type ComputerImageStreamStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "unsupported" }
  | { readonly kind: "connecting" }
  | { readonly kind: "streaming" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Keeps the previous status object when nothing about it actually changed. A
 * decoded frame reports "streaming" at stream rate, and a fresh object every
 * time would re-render the whole pane once per frame for no visible difference.
 */
export function mergeComputerImageStreamStatus(
  previous: ComputerImageStreamStatus,
  next: ComputerImageStreamStatus,
): ComputerImageStreamStatus {
  if (previous.kind !== next.kind) return next;
  if (previous.kind === "error" && next.kind === "error" && previous.message !== next.message) {
    return next;
  }
  return previous;
}

function isImageBitmapAvailable(): boolean {
  return typeof Blob === "function" && typeof globalThis.createImageBitmap === "function";
}

export function useComputerImageStream(input: {
  readonly canvasRef: React.RefObject<HTMLCanvasElement | null>;
  readonly environmentId: EnvironmentId | null;
  readonly computerId: ComputerId | null;
  readonly enabled: boolean;
}): {
  readonly status: ComputerImageStreamStatus;
  readonly dimensions: ComputerImageDimensions | null;
} {
  const { canvasRef, environmentId, computerId, enabled } = input;
  const registry = useContext(RegistryContext);
  // Frames flow only while the environment is connected; a new connection
  // generation starts a fresh stream against it.
  const connectedGeneration = useConnectedGeneration(environmentId);
  const [status, setStatus] = useState<ComputerImageStreamStatus>({ kind: "idle" });
  const [dimensions, setDimensions] = useState<ComputerImageDimensions | null>(null);
  const generationRef = useRef(0);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    update();
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    if (
      !enabled ||
      !pageVisible ||
      environmentId === null ||
      computerId === null ||
      connectedGeneration === null
    ) {
      setStatus({ kind: "idle" });
      setDimensions(null);
      // The canvas keeps its last decoded frame: the tap (or this stream when
      // it re-subscribes) paints over it, so wiping here would flash a blank
      // viewport during every stills-to-tap handoff and page-hide cycle.
      return;
    }
    if (!isImageBitmapAvailable()) {
      setStatus({ kind: "unsupported" });
      return;
    }

    const generation = ++generationRef.current;
    const isCurrent = () => generationRef.current === generation;
    let disposed = false;
    let gate: ComputerFrameGateState = createComputerFrameGateState();
    let source: ComputerFrameSource | null = null;
    let reconnectAttempts = 0;
    // The resolved URL is reused until its ticket nears expiry: a ticket stays
    // valid for minutes, and minting one is an HTTP round trip (with a DPoP
    // proof on relay). A close cannot tell a refused ticket from a dropped
    // connection, so no close replaces it.
    let resolvedUrl: ComputerFrameSocketUrl | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let decoding = false;
    let pendingFrame: ComputerFrame | null = null;

    const setCurrentStatus = (next: ComputerImageStreamStatus) => {
      if (!isCurrent() || disposed) return;
      setStatus((previous) => mergeComputerImageStreamStatus(previous, next));
    };

    const decodeFrame = async (frame: ComputerFrame): Promise<void> => {
      if (!isCurrent() || disposed) return;
      decoding = true;
      let bitmap: ImageBitmap | null = null;
      try {
        // The payload is a view over that message's own buffer, and the Blob
        // constructor copies the bytes it is given, so this is the only copy a
        // multi-megabyte frame needs. The cast narrows the decoder's
        // `ArrayBufferLike` to what `Blob` accepts: this buffer came from a
        // WebSocket message, which is never shared memory.
        const payload = frame.payload as Uint8Array<ArrayBuffer>;
        bitmap = await globalThis.createImageBitmap(new Blob([payload], { type: "image/png" }));
        if (!isCurrent() || disposed) return;
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        const { width, height } = bitmap;
        setDimensions((previous) =>
          previous?.width === width && previous.height === height ? previous : { width, height },
        );
        context.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height);
        setCurrentStatus({ kind: "streaming" });
      } catch (error) {
        setCurrentStatus({
          kind: "error",
          message:
            error instanceof Error ? error.message : "The computer frame could not be decoded.",
        });
        source?.requestResync();
      } finally {
        bitmap?.close();
        decoding = false;
        if (pendingFrame !== null && isCurrent() && !disposed) {
          const next = pendingFrame;
          pendingFrame = null;
          void decodeFrame(next);
        }
      }
    };

    const handleFrame = (frame: ComputerFrame) => {
      reconnectAttempts = 0;
      if (!isCurrent() || disposed) return;
      const step = stepComputerFrameGate(gate, frame.header, computerId);
      gate = step.state;
      if (step.requestResync) source?.requestResync();
      if (step.action !== "decode") return;
      if (decoding) {
        pendingFrame = frame;
        return;
      }
      void decodeFrame(frame);
    };

    const connect = (resolved: string) => {
      source = createComputerFrameSource({
        url: resolved,
        handlers: { onFrame: handleFrame, onReset: handleReset },
      });
    };

    const openFrameSource = () => {
      if (
        resolvedUrl !== null &&
        (resolvedUrl.expiresAt === null ||
          resolvedUrl.expiresAt - Date.now() > FRAME_TICKET_REFRESH_MARGIN_MS)
      ) {
        connect(resolvedUrl.url);
        return;
      }
      void resolveComputerFrameSocketUrl(registry, environmentId, computerId).then((resolved) => {
        if (disposed || !isCurrent()) return;
        resolvedUrl = resolved;
        if (resolved === null) {
          handleReset("closed");
          return;
        }
        connect(resolved.url);
      });
    };

    const giveUp = () => {
      source?.close();
      source = null;
      setCurrentStatus({ kind: "error", message: COMPUTER_LIVE_VIEW_UNAVAILABLE });
    };

    const handleReset = (
      reason: ComputerFrameSourceResetReason,
      close?: ComputerFrameSourceClose,
    ) => {
      if (!isCurrent() || disposed) return;
      gate = createComputerFrameGateState();
      pendingFrame = null;
      if (reason === "closed") {
        if (close?.code === POLICY_VIOLATION_CLOSE_CODE) {
          giveUp();
          return;
        }
        reconnectAttempts += 1;
        if (reconnectAttempts > FRAME_RECONNECT_MAX_ATTEMPTS) {
          giveUp();
          return;
        }
        setCurrentStatus({ kind: "connecting" });
        const delay = Math.min(500 * 2 ** (reconnectAttempts - 1), FRAME_RECONNECT_MAX_DELAY_MS);
        reconnectTimer = setTimeout(() => {
          if (disposed || !isCurrent()) return;
          source?.close();
          source = null;
          openFrameSource();
        }, delay);
        return;
      }
      setCurrentStatus({
        kind: "error",
        message:
          reason === "decode-failed"
            ? "The computer stream sent a frame Pathway could not read."
            : "The computer stream disconnected.",
      });
    };

    setStatus({ kind: "connecting" });
    openFrameSource();

    return () => {
      disposed = true;
      generationRef.current += 1;
      pendingFrame = null;
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
    };
  }, [canvasRef, computerId, connectedGeneration, enabled, environmentId, pageVisible, registry]);

  return { status, dimensions };
}
