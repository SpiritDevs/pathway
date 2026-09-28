// @effect-diagnostics globalDate:off - Fake browser clock.
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createEnvironmentSurfaceStream,
  decodeSurfaceImage,
  type DecodedSurfaceFrame,
  type SurfaceStreamOptions,
} from "./client.ts";
import { encodeSurfaceFrame } from "@spiritdevs/shared/environmentSurface";
class FakeSocket {
  binaryType = "";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: ArrayBuffer | string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  send = vi.fn();
  close = vi.fn();
}
const viewport = { width: 800, height: 600, deviceScale: 2 };
const frame = (sequence = 1): DecodedSurfaceFrame => ({
  ...viewport,
  sequence,
  timestampMs: Date.now(),
  image: "blob:test",
  dispose: vi.fn(),
});
const clients: Array<ReturnType<typeof createEnvironmentSurfaceStream>> = [];
afterEach(() => {
  clients.forEach((c) => c.close());
  clients.length = 0;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function harness(
  decode = vi.fn(async () => frame()),
  options: Pick<SurfaceStreamOptions, "sizing"> = {},
) {
  const sockets: FakeSocket[] = [];
  const resolveUrl = vi.fn(async () => ({
    url: "wss://environment.example/ws/environment-surface",
  }));
  const onFrame = vi.fn();
  const onQuality = vi.fn();
  const client = createEnvironmentSurfaceStream({
    ...options,
    resolveUrl,
    viewport,
    onFrame,
    onQuality,
    decode,
    createSocket: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s as unknown as WebSocket;
    },
  });
  clients.push(client);
  await Promise.resolve();
  sockets[0]!.onopen?.();
  return { client, sockets, resolveUrl, onFrame, onQuality, decode };
}
describe("surface client", () => {
  it("reconnects with fresh authorization, answers keepalive, and pauses hidden viewers", async () => {
    vi.useFakeTimers();
    const h = await harness();
    expect(h.resolveUrl).toHaveBeenCalledWith(viewport, "active");
    expect(h.sockets[0]!.send).toHaveBeenCalledWith("ready");
    h.sockets[0]!.onmessage?.({ data: "ping" });
    expect(h.sockets[0]!.send).toHaveBeenCalledWith("pong");
    h.sockets[0]!.onclose?.({ code: 1006 });
    expect(h.client.state).toBe("stale");
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.resolveUrl).toHaveBeenCalledTimes(2);
    h.client.pause();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.resolveUrl).toHaveBeenCalledTimes(2);
    h.client.resume();
    await Promise.resolve();
    expect(h.resolveUrl).toHaveBeenCalledTimes(3);
    h.sockets[2]!.onclose?.({ code: 1008 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.client.state).toBe("failed");
    expect(h.resolveUrl).toHaveBeenCalledTimes(3);
  });
  it("preserves passive sizing when reconnecting, resizing and resuming", async () => {
    vi.useFakeTimers();
    const h = await harness(undefined, { sizing: "passive" });
    expect(h.resolveUrl).toHaveBeenLastCalledWith(viewport, "passive");
    h.sockets[0]!.onclose?.({ code: 1006 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.resolveUrl).toHaveBeenCalledTimes(2);
    expect(h.resolveUrl).toHaveBeenLastCalledWith(viewport, "passive");
    const next = { width: 320, height: 200, deviceScale: 1 };
    h.client.setViewport(next);
    await Promise.resolve();
    expect(h.resolveUrl).toHaveBeenCalledTimes(3);
    expect(h.resolveUrl).toHaveBeenLastCalledWith(next, "passive");
    h.client.pause();
    h.client.resume();
    await Promise.resolve();
    expect(h.resolveUrl).toHaveBeenCalledTimes(4);
    expect(h.resolveUrl).toHaveBeenLastCalledWith(next, "passive");
    h.sockets[3]!.onmessage?.({ data: new ArrayBuffer(25) });
    await Promise.resolve();
    expect(h.onFrame).toHaveBeenCalledOnce();
  });
  it("bounds decode backlog, releases replaced frames and rejects late decodes after pause", async () => {
    const held = Promise.withResolvers<DecodedSurfaceFrame>();
    const next = frame(3);
    const decode = vi.fn(async () => next).mockImplementationOnce(() => held.promise);
    const h = await harness(decode);
    for (let i = 0; i < 20; i++) h.sockets[0]!.onmessage?.({ data: new ArrayBuffer(25) });
    expect(decode).toHaveBeenCalledTimes(1);
    const first = frame();
    held.resolve(first);
    await held.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(h.client.state).toBe("live");
    h.client.pause();
    expect(next.dispose).toHaveBeenCalledOnce();
    const late = Promise.withResolvers<DecodedSurfaceFrame>();
    const h2 = await harness(vi.fn(() => late.promise));
    h2.sockets[0]!.onmessage?.({ data: new ArrayBuffer(25) });
    h2.client.pause();
    const stale = frame();
    late.resolve(stale);
    await late.promise;
    await Promise.resolve();
    expect(stale.dispose).toHaveBeenCalledOnce();
    expect(h2.onFrame).not.toHaveBeenCalled();
  });
  it("decodes ImageBitmap and falls back to a revocable Blob URL", async () => {
    const bytes = encodeSurfaceFrame({
      ...viewport,
      sequence: 1,
      timestampMs: 0,
      jpeg: new Uint8Array([1]),
    });
    const bitmap = { close: vi.fn() };
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => bitmap),
    );
    const decoded = await decodeSurfaceImage(bytes);
    expect(decoded.image).toBe(bitmap);
    decoded.dispose();
    expect(bitmap.close).toHaveBeenCalled();
    vi.stubGlobal("createImageBitmap", undefined);
    const fallback = await decodeSurfaceImage(bytes);
    expect(fallback.image).toMatch(/^blob:/);
    fallback.dispose();
  });
});
