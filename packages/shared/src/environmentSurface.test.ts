import { describe, expect, it } from "vite-plus/test";
import { decodeSurfaceFrame, encodeSurfaceFrame, jpegDimensions } from "./environmentSurface.ts";
describe("surface wire format", () => {
  it("roundtrips with an offset and rejects malformed headers", () => {
    const frame = {
      sequence: 0xffffffff,
      width: 2560,
      height: 1600,
      deviceScale: 2,
      timestampMs: 1234.5,
      jpeg: new Uint8Array([0xff, 0xd8, 1]),
    };
    const encoded = encodeSurfaceFrame(frame);
    const offset = new Uint8Array(encoded.length + 7);
    offset.set(encoded, 7);
    expect(decodeSurfaceFrame(offset.subarray(7))).toEqual(frame);
    expect(() => decodeSurfaceFrame(encoded.subarray(0, 23))).toThrow();
    encoded[2] = 2;
    expect(() => decodeSurfaceFrame(encoded)).toThrow();
  });
  it("reads JPEG dimensions without a raster decode", () => {
    expect(jpegDimensions(new Uint8Array([255, 216, 255, 192, 0, 8, 8, 3, 32, 5, 0, 0]))).toEqual({
      width: 1280,
      height: 800,
    });
    expect(jpegDimensions(new Uint8Array([255, 216, 255, 192, 0, 8]))).toBeNull();
  });
});
