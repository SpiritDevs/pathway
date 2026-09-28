import type { EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import {
  encodeSurfaceFrame,
  SURFACE_MAX_FRAME_BYTES,
  type SurfaceFrame,
} from "@spiritdevs/shared/environmentSurface";

export interface SurfaceSink {
  send(bytes: Uint8Array): void;
  bufferedAmount(): number;
  close(): void;
}
interface Viewer {
  sink: SurfaceSink;
  viewport: EnvironmentSurfaceViewport;
  pending: Uint8Array | null;
  level: number;
  healthy: number;
}
const levels = [
  { quality: 75, scale: 1 },
  { quality: 60, scale: 0.8 },
  { quality: 45, scale: 0.6 },
];
export const SURFACE_SOCKET_BUDGET = 256 * 1024;

/** One encoded frame shared by all viewers, one replaceable pending frame per viewer. */
export class EnvironmentSurfaceStream {
  private viewers = new Set<Viewer>();
  private latest: Uint8Array | null = null;
  get size() {
    return this.viewers.size;
  }
  add(sink: SurfaceSink, viewport: EnvironmentSurfaceViewport) {
    const viewer: Viewer = { sink, viewport, pending: this.latest, level: 0, healthy: 0 };
    this.viewers.add(viewer);
    this.flush(viewer);
    return () => {
      this.viewers.delete(viewer);
      if (!this.size) this.latest = null;
    };
  }
  publish(frame: SurfaceFrame) {
    if (!this.size || frame.jpeg.byteLength + 24 > SURFACE_MAX_FRAME_BYTES) return;
    const bytes = encodeSurfaceFrame(frame);
    this.latest = bytes;
    for (const viewer of this.viewers) {
      viewer.pending = bytes;
      this.flush(viewer);
    }
  }
  /** Called every 100ms while watched, including static pages whose last frame is queued. */
  tick() {
    for (const viewer of this.viewers) {
      if (viewer.sink.bufferedAmount() > SURFACE_SOCKET_BUDGET) {
        viewer.level = Math.min(2, viewer.level + 1);
        viewer.healthy = 0;
      } else if (++viewer.healthy >= 50) {
        viewer.level = Math.max(0, viewer.level - 1);
        viewer.healthy = 0;
      }
      this.flush(viewer);
    }
  }
  configuration(fallback: { width: number; height: number }) {
    const selected = [...this.viewers].sort(
      (a, b) => b.viewport.width * b.viewport.height - a.viewport.width * a.viewport.height,
    )[0]?.viewport;
    const viewport = selected ?? { ...fallback, deviceScale: 1 };
    const dimensionScale = Math.min(1, 2560 / viewport.width, 1600 / viewport.height);
    const width = Math.max(1, Math.round(viewport.width * dimensionScale));
    const height = Math.max(1, Math.round(viewport.height * dimensionScale));
    const deviceScale = Math.min(2, viewport.deviceScale, Math.sqrt(4_000_000 / (width * height)));
    const level = Math.max(0, ...[...this.viewers].map((v) => v.level));
    const quality = levels[level]!;
    return {
      width,
      height,
      deviceScale,
      quality: quality.quality,
      maxWidth: Math.max(1, Math.floor(width * deviceScale * quality.scale)),
      maxHeight: Math.max(1, Math.floor(height * deviceScale * quality.scale)),
    };
  }
  close() {
    for (const viewer of this.viewers) viewer.sink.close();
    this.viewers.clear();
    this.latest = null;
  }
  private flush(viewer: Viewer) {
    if (!viewer.pending || viewer.sink.bufferedAmount() > SURFACE_SOCKET_BUDGET) return;
    const bytes = viewer.pending;
    viewer.pending = null;
    try {
      viewer.sink.send(bytes);
    } catch {
      viewer.sink.close();
      this.viewers.delete(viewer);
    }
  }
}
