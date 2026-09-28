/* eslint-disable unicorn/prefer-add-event-listener -- Each socket is exclusively owned by this lifecycle, including native adapters. */
// @effect-diagnostics globalDate:off globalTimers:off globalRandom:off - Browser socket lifecycle and reconnect jitter run outside Effect.
import type { EnvironmentSurfaceSizing, EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import { decodeSurfaceFrame, type SurfaceFrameHeader } from "@spiritdevs/shared/environmentSurface";

export type SurfaceConnectionState = "connecting" | "live" | "stale" | "failed";
export interface DecodedSurfaceFrame extends SurfaceFrameHeader {
  image: ImageBitmap | string;
  dispose(): void;
}
export interface SurfaceQuality {
  fps: number;
  latencyMs: number;
}
export interface SurfaceStreamOptions {
  /** Resolve against the current prepared environment connection on EVERY attempt. */
  resolveUrl(
    viewport: EnvironmentSurfaceViewport,
    sizing: EnvironmentSurfaceSizing,
  ): Promise<{ url: string }>;
  viewport: EnvironmentSurfaceViewport;
  /** Passive viewers receive frames without changing the page viewport. Defaults to active. */
  sizing?: EnvironmentSurfaceSizing;
  onFrame(frame: DecodedSurfaceFrame): void;
  onState?(state: SurfaceConnectionState): void;
  onQuality?(quality: SurfaceQuality): void;
  createSocket?(url: string): WebSocket;
  decode?(bytes: Uint8Array): Promise<DecodedSurfaceFrame>;
}
export async function decodeSurfaceImage(bytes: Uint8Array): Promise<DecodedSurfaceFrame> {
  const { jpeg, ...header } = decodeSurfaceFrame(bytes);
  const blob = new Blob([new Uint8Array(jpeg)], { type: "image/jpeg" });
  if (typeof createImageBitmap === "function") {
    try {
      const image = await createImageBitmap(blob);
      return { ...header, image, dispose: () => image.close() };
    } catch {
      /* Some clients expose createImageBitmap without JPEG support. */
    }
  }
  const image = URL.createObjectURL(blob);
  return { ...header, image, dispose: () => URL.revokeObjectURL(image) };
}

/** Frames are owned by this client and released on replacement, pause or close. */
export function createEnvironmentSurfaceStream(options: SurfaceStreamOptions) {
  let viewport = options.viewport;
  let socket: WebSocket | null = null;
  let paused = false;
  let closed = false;
  let generation = 0;
  let failures = 0;
  let terminalFailure = false;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let state: SurfaceConnectionState = "connecting";
  let lastMessage = Date.now();
  let delivered: DecodedSurfaceFrame | null = null;
  let pending: { bytes: Uint8Array; generation: number } | null = null;
  let decoding = false;
  let frames = 0;
  let latencyMs = 0;
  const setState = (next: SurfaceConnectionState) => {
    state = next;
    options.onState?.(next);
  };
  const release = () => {
    pending = null;
    delivered?.dispose();
    delivered = null;
  };
  const consume = async () => {
    if (decoding) return;
    decoding = true;
    try {
      while (pending) {
        const next = pending;
        pending = null;
        let frame: DecodedSurfaceFrame;
        try {
          frame = await (options.decode ?? decodeSurfaceImage)(next.bytes);
        } catch {
          if (next.generation === generation) setState("stale");
          continue;
        }
        if (closed || paused || next.generation !== generation) {
          frame.dispose();
          continue;
        }
        const previous = delivered;
        delivered = frame;
        frames++;
        latencyMs = Math.max(0, Date.now() - frame.timestampMs);
        failures = 0;
        setState("live");
        try {
          options.onFrame(frame);
        } finally {
          previous?.dispose();
        }
      }
    } finally {
      decoding = false;
    }
  };
  const disconnect = () => {
    generation++;
    clearTimeout(reconnect);
    reconnect = undefined;
    const previous = socket;
    socket = null;
    previous?.close();
    release();
  };
  const connect = async () => {
    if (closed || paused) return;
    const current = ++generation;
    setState(failures ? "stale" : "connecting");
    lastMessage = Date.now();
    const retry = (terminal = false) => {
      if (current !== generation || closed || paused) return;
      terminalFailure = terminal;
      generation++;
      pending = null;
      socket?.close();
      socket = null;
      failures++;
      setState(terminal || failures >= 8 ? "failed" : "stale");
      if (!terminal)
        reconnect = setTimeout(
          () => {
            void connect();
          },
          Math.min(30_000, 500 * 2 ** Math.min(failures - 1, 6)) * (0.8 + Math.random() * 0.4),
        );
    };
    try {
      const { url } = await options.resolveUrl(viewport, options.sizing ?? "active");
      if (current !== generation || closed || paused) return;
      const ws = (options.createSocket ?? ((url) => new WebSocket(url)))(url);
      socket = ws;
      ws.binaryType = "arraybuffer";
      ws.onopen = () => {
        if (current === generation) {
          lastMessage = Date.now();
          ws.send("ready");
        }
      };
      ws.onmessage = (event) => {
        if (current !== generation) return;
        lastMessage = Date.now();
        if (event.data === "ping") {
          ws.send("pong");
          return;
        }
        if (!(event.data instanceof ArrayBuffer)) return;
        pending = { bytes: new Uint8Array(event.data), generation: current };
        void consume();
      };
      ws.onerror = () => retry();
      ws.onclose = (event) => retry(event.code === 1008);
    } catch {
      retry();
    }
  };
  const monitor = setInterval(() => {
    if (closed || paused || terminalFailure) return;
    options.onQuality?.({ fps: frames, latencyMs });
    frames = 0;
    if (Date.now() - lastMessage > 35_000) {
      disconnect();
      failures++;
      setState("stale");
      void connect();
    }
  }, 1000);
  void connect();
  return {
    get state() {
      return state;
    },
    pause() {
      if (closed || paused) return;
      paused = true;
      disconnect();
      setState("stale");
    },
    resume() {
      if (closed) return;
      paused = false;
      terminalFailure = false;
      disconnect();
      failures = 0;
      void connect();
    },
    setViewport(next: EnvironmentSurfaceViewport) {
      viewport = next;
      disconnect();
      if (!paused) void connect();
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(monitor);
      disconnect();
    },
  };
}
