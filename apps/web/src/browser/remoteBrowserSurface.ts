import type { EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import type { SurfaceConnectionState, SurfaceQuality } from "@spiritdevs/client-runtime/surface";

/** The environment caps DPR at 2; asking for more only costs bandwidth. */
const MAX_DEVICE_SCALE = 2;

/**
 * The viewport this client asks the environment to render: the panel's CSS box
 * at the display's pixel density, so text stays sharp on HiDPI screens. The
 * largest viewer of a tab wins, so frames may arrive at another size.
 */
export function surfaceViewportFor(
  box: { width: number; height: number },
  devicePixelRatio: number,
): EnvironmentSurfaceViewport | null {
  const width = Math.min(4096, Math.round(box.width));
  const height = Math.min(4096, Math.round(box.height));
  if (width < 1 || height < 1) return null;
  const deviceScale = Math.min(MAX_DEVICE_SCALE, Math.max(1, devicePixelRatio || 1));
  return { width, height, deviceScale: Math.round(deviceScale * 100) / 100 };
}

export function sameSurfaceViewport(
  a: EnvironmentSurfaceViewport | null,
  b: EnvironmentSurfaceViewport | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.width === b.width &&
      a.height === b.height &&
      a.deviceScale === b.deviceScale)
  );
}

/** CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8. */
export function cdpModifiers(event: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (
    (event.altKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.metaKey ? 4 : 0) |
    (event.shiftKey ? 8 : 0)
  );
}

/** Wheel deltas in CSS pixels, whatever unit the browser reported them in. */
export function wheelPixels(
  event: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeight: number,
): { deltaX: number; deltaY: number } {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1;
  return { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit };
}

export type SurfaceIndicator = {
  tone: "live" | "degraded" | "offline";
  label: string;
};

/**
 * One short label for the connection: what a user needs to judge whether
 * lag is theirs. Latency includes clock skew between machines, so it is
 * rounded and only called out once it is clearly noticeable.
 */
export function surfaceIndicator(
  state: SurfaceConnectionState,
  quality: SurfaceQuality | null,
): SurfaceIndicator {
  if (state === "failed") return { tone: "offline", label: "Offline · retrying" };
  if (state === "stale") return { tone: "degraded", label: "Reconnecting…" };
  if (state === "connecting" || !quality) return { tone: "degraded", label: "Connecting…" };
  // A still page sends no frames, and its last latency is history.
  if (quality.fps === 0) return { tone: "live", label: "Live" };
  const latency = Math.round(quality.latencyMs / 10) * 10;
  return {
    tone: quality.latencyMs >= 400 ? "degraded" : "live",
    label: `${quality.fps} fps${latency > 0 ? ` · ${latency} ms` : ""}`,
  };
}
