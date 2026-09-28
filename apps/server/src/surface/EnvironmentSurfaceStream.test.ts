import { describe, expect, it, vi } from "vite-plus/test";
import { decodeSurfaceFrame } from "@spiritdevs/shared/environmentSurface";
import { EnvironmentSurfaceStream, SURFACE_SOCKET_BUDGET } from "./EnvironmentSurfaceStream.ts";
const viewport = { width: 1280, height: 800, deviceScale: 2 };
const frame = (sequence: number) => ({
  ...viewport,
  sequence,
  timestampMs: 0,
  jpeg: new Uint8Array([1]),
});
describe("surface fanout", () => {
  it("fans out one envelope, retains only latest for slow viewers, and sends it on drain", () => {
    const stream = new EnvironmentSurfaceStream();
    const a = { send: vi.fn(), close: vi.fn(), bufferedAmount: () => 0 };
    let buffered = 0;
    const b = { ...a, send: vi.fn(), bufferedAmount: () => buffered };
    stream.publish(frame(0));
    const removeA = stream.add(a, viewport);
    const removeB = stream.add(b, viewport);
    expect(a.send).not.toHaveBeenCalled();
    stream.publish(frame(1));
    expect(a.send.mock.calls[0]![0]).toBe(b.send.mock.calls[0]![0]);
    buffered = SURFACE_SOCKET_BUDGET + 1;
    for (let i = 2; i <= 100; i++) stream.publish(frame(i));
    expect(b.send).toHaveBeenCalledTimes(1);
    stream.tick();
    expect(stream.configuration(viewport).quality).toBe(60);
    buffered = 0;
    stream.tick();
    expect(decodeSurfaceFrame(b.send.mock.calls[1]![0]).sequence).toBe(100);
    for (let i = 0; i < 50; i++) stream.tick();
    expect(stream.configuration(viewport).quality).toBe(75);
    const c = { ...a, send: vi.fn() };
    const removeC = stream.add(c, viewport);
    expect(decodeSurfaceFrame(c.send.mock.calls[0]![0]).sequence).toBe(100);
    removeA();
    removeB();
    removeC();
    expect(stream.size).toBe(0);
    const d = { ...a, send: vi.fn() };
    stream.add(d, viewport);
    expect(d.send).not.toHaveBeenCalled();
  });
  it("uses the largest CSS viewport and caps DPR and total pixels", () => {
    const stream = new EnvironmentSurfaceStream();
    const sink = { send() {}, close() {}, bufferedAmount: () => 0 };
    stream.add(sink, viewport);
    const remove = stream.add(sink, { width: 4096, height: 4096, deviceScale: 4 });
    const config = stream.configuration(viewport);
    expect(config.width).toBeLessThanOrEqual(2560);
    expect(config.height).toBeLessThanOrEqual(1600);
    expect(config.width * config.height * config.deviceScale ** 2).toBeLessThanOrEqual(4_000_001);
    remove();
    expect(stream.configuration(viewport).width).toBe(1280);
  });
  it("excludes passive viewers from viewport arbitration and retains frame fanout", () => {
    const stream = new EnvironmentSurfaceStream();
    const passive = { send: vi.fn(), close: vi.fn(), bufferedAmount: () => 0 };
    stream.add(passive, { width: 2400, height: 1500, deviceScale: 2 }, "passive");
    const fallback = { width: 1440, height: 900 };
    expect(stream.configuration(fallback)).toMatchObject({ ...fallback, resizeViewport: false });
    const active = { ...passive, send: vi.fn() };
    const removeActive = stream.add(active, viewport);
    expect(stream.configuration(fallback)).toMatchObject({
      width: viewport.width,
      height: viewport.height,
      resizeViewport: true,
    });
    stream.publish(frame(1));
    expect(active.send.mock.calls[0]![0]).toBe(passive.send.mock.calls[0]![0]);
    removeActive();
    expect(stream.configuration(fallback)).toMatchObject({ ...fallback, resizeViewport: false });
    stream.publish(frame(2));
    expect(decodeSurfaceFrame(passive.send.mock.calls[1]![0]).sequence).toBe(2);
    expect(active.send).toHaveBeenCalledOnce();
  });
});
