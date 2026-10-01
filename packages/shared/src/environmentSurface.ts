/** Version 1: 24 little-endian header bytes, then one independent JPEG. */
export const SURFACE_HEADER_BYTES = 24;
export const SURFACE_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export interface SurfaceFrameHeader {
  sequence: number;
  width: number;
  height: number;
  deviceScale: number;
  timestampMs: number;
}
export interface SurfaceFrame extends SurfaceFrameHeader {
  jpeg: Uint8Array;
}
export function encodeSurfaceFrame(frame: SurfaceFrame): Uint8Array {
  const bytes = new Uint8Array(SURFACE_HEADER_BYTES + frame.jpeg.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0x5350, true);
  view.setUint8(2, 1);
  view.setUint8(3, 1); // JPEG
  view.setUint32(4, frame.sequence >>> 0, true);
  view.setUint16(8, frame.width, true);
  view.setUint16(10, frame.height, true);
  view.setFloat32(12, frame.deviceScale, true);
  view.setFloat64(16, frame.timestampMs, true);
  bytes.set(frame.jpeg, SURFACE_HEADER_BYTES);
  return bytes;
}
export function decodeSurfaceFrame(bytes: Uint8Array): SurfaceFrame {
  if (bytes.byteLength <= SURFACE_HEADER_BYTES || bytes.byteLength > SURFACE_MAX_FRAME_BYTES)
    throw new Error("Invalid surface frame length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0x5350 || view.getUint8(2) !== 1 || view.getUint8(3) !== 1)
    throw new Error("Unsupported surface frame");
  const frame = {
    sequence: view.getUint32(4, true),
    width: view.getUint16(8, true),
    height: view.getUint16(10, true),
    deviceScale: view.getFloat32(12, true),
    timestampMs: view.getFloat64(16, true),
    jpeg: bytes.subarray(SURFACE_HEADER_BYTES),
  };
  if (
    !frame.width ||
    !frame.height ||
    !Number.isFinite(frame.deviceScale) ||
    frame.deviceScale <= 0 ||
    !Number.isFinite(frame.timestampMs)
  )
    throw new Error("Invalid surface frame header");
  return frame;
}
/** Read dimensions without decoding the image a second time. */
export function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xda || marker === 0xd9) return null;
    if (marker === 0xff) {
      i++;
      continue;
    }
    const length = bytes[i + 2]! * 256 + bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) return null;
    if ([0xc0, 0xc1, 0xc2].includes(marker))
      return {
        height: bytes[i + 5]! * 256 + bytes[i + 6]!,
        width: bytes[i + 7]! * 256 + bytes[i + 8]!,
      };
    i += 2 + length;
  }
  return null;
}
