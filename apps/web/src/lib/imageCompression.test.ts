import type { SnapShotSource } from "@spiritdevs/contracts";
import { hydrateImagesFromPersisted } from "../composerDraftStore";
import { resizeSnapShotSource } from "./snapShotSource";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  compressImageForStash,
  dataUrlToFile,
  compressImageToByteLimit,
  MAX_COMPRESSIBLE_SOURCE_BYTES,
  MAX_STASH_IMAGE_DATA_URL_CHARS,
} from "./imageCompression";

/**
 * jsdom has no real canvas/codec, so the re-encode path is exercised with
 * stubbed `createImageBitmap` + `OffscreenCanvas`. The encoder stub returns a
 * payload whose size scales with quality, mirroring how a real JPEG encoder
 * shrinks as quality drops — enough to verify the ladder logic and budget
 * enforcement without pulling in a native canvas.
 */

const originalCreateImageBitmap = globalThis.createImageBitmap;
const originalOffscreenCanvas = globalThis.OffscreenCanvas;

function makeFile(sizeBytes: number, type = "image/png"): File {
  return new File([new Uint8Array(sizeBytes).fill(7)], "shot.png", { type });
}

/**
 * Installs a fake bitmap + canvas whose encoded size follows `sizeForQuality`.
 * `supportsWebp: false` makes `convertToBlob` hand back a differently-typed
 * blob for WebP requests, which is how a real browser signals it cannot
 * encode that format.
 */
function stubCanvasPipeline(
  sizeForQuality: (quality: number) => number,
  options?: { supportsWebp?: boolean },
) {
  const supportsWebp = options?.supportsWebp ?? true;
  const close = vi.fn();
  const fillRect = vi.fn();
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => ({ width: 4000, height: 3000, close })),
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          fillStyle: "",
          fillRect,
          drawImage: vi.fn(),
        };
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const resolvedType = type === "image/webp" && !supportsWebp ? "image/png" : type;
        return new Blob([new Uint8Array(sizeForQuality(quality))], { type: resolvedType });
      }
    },
  );
  return { close, fillRect };
}

afterEach(() => {
  vi.unstubAllGlobals();
  globalThis.createImageBitmap = originalCreateImageBitmap;
  globalThis.OffscreenCanvas = originalOffscreenCanvas;
});

describe("dataUrlToFile", () => {
  it("decodes a captured image without a fetch request", async () => {
    const file = dataUrlToFile("data:image/png;base64,AAEC/w==", "window.png", "image/png");

    expect(file.name).toBe("window.png");
    expect(file.type).toBe("image/png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 1, 2, 255]);
  });
});

describe("compressImageForStash", () => {
  it("stores a small image verbatim without re-encoding", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const result = await compressImageForStash(makeFile(1024));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.recompressed).toBe(false);
    expect(result.ok && result.image.mimeType).toBe("image/png");
    expect(result.ok && result.image.dataUrl.startsWith("data:image/png")).toBe(true);
    // Untouched payloads must not pay for a decode.
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("re-encodes an oversized image to WebP within the budget", async () => {
    // Comfortably under budget at the very first quality step.
    const { close, fillRect } = stubCanvasPipeline(() => 120_000);

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result.ok).toBe(true);
    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/webp");
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true);
    // sizeBytes should describe the re-encoded payload, not the 4MB original.
    expect(result.ok && result.image.sizeBytes).toBeLessThan(4_000_000);
    // WebP keeps alpha, so no white matte should be painted.
    expect(fillRect).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it("falls back to JPEG with a white matte when WebP encoding is unavailable", async () => {
    const { fillRect } = stubCanvasPipeline(() => 120_000, { supportsWebp: false });

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.mimeType).toBe("image/jpeg");
    // JPEG has no alpha, so transparent regions must be matted white.
    expect(fillRect).toHaveBeenCalled();
  });

  it("steps quality down until the encoded image fits", async () => {
    // Only the lowest quality step (0.68) lands under the budget.
    const { close } = stubCanvasPipeline((quality) => (quality <= 0.68 ? 400_000 : 3_000_000));

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result.ok && result.image.recompressed).toBe(true);
    expect(result.ok && result.image.dataUrl.length <= MAX_STASH_IMAGE_DATA_URL_CHARS).toBe(true);
    expect(close).toHaveBeenCalled();
  });

  it("reports too-large when even the smallest encoding overflows the budget", async () => {
    const { close } = stubCanvasPipeline(() => 8_000_000);

    const result = await compressImageForStash(makeFile(9_000_000));

    expect(result).toEqual({ ok: false, reason: "too-large" });
    // The bitmap must still be released on the give-up path.
    expect(close).toHaveBeenCalled();
  });

  it("reports too-large for an oversized image when the browser cannot re-encode", async () => {
    vi.stubGlobal("createImageBitmap", undefined);
    vi.stubGlobal("OffscreenCanvas", undefined);

    expect(await compressImageForStash(makeFile(4_000_000))).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  it("reports unreadable when the image fails to decode", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new Error("corrupt image");
      }),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        getContext() {
          return null;
        }
      },
    );

    expect(await compressImageForStash(makeFile(4_000_000))).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("compressImageToByteLimit passes small files through byte-for-byte", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const original = makeFile(1024);
    const result = await compressImageToByteLimit(original, 10 * 1024 * 1024);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(false);
    // Pass-through must be the same File object, not a copy.
    expect(result.ok && result.file).toBe(original);
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("compressImageToByteLimit re-encodes an oversized file under the byte cap", async () => {
    stubCanvasPipeline(() => 200_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result.ok).toBe(true);
    expect(result.ok && result.recompressed).toBe(true);
    expect(result.ok && result.file.type).toBe("image/webp");
    // The re-encoded name must match the new container format.
    expect(result.ok && result.file.name).toBe("shot.webp");
    expect(result.ok && result.file.size).toBeLessThanOrEqual(1_000_000);
  });

  it("compressImageToByteLimit refuses sources above the decode-safety ceiling", async () => {
    const bitmapSpy = vi.fn();
    vi.stubGlobal("createImageBitmap", bitmapSpy);

    const result = await compressImageToByteLimit(
      makeFile(MAX_COMPRESSIBLE_SOURCE_BYTES + 1),
      10 * 1024 * 1024,
    );

    expect(result).toEqual({ ok: false, reason: "too-large" });
    // The whole point of the ceiling is to never decode such a file.
    expect(bitmapSpy).not.toHaveBeenCalled();
  });

  it("compressImageToByteLimit reports too-large when no encoding fits", async () => {
    const { close } = stubCanvasPipeline(() => 3_000_000);

    const result = await compressImageToByteLimit(makeFile(2_000_000), 1_000_000);

    expect(result).toEqual({ ok: false, reason: "too-large" });
    expect(close).toHaveBeenCalled();
  });

  it("shrinks below the source size when the image is already under MAX_DIMENSION", async () => {
    // A small-but-heavy source (e.g. a dense PNG): only a real downscale can
    // get it under budget, since quality alone is stubbed to never suffice.
    let smallestRequested = Number.POSITIVE_INFINITY;
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 800, height: 600, close })),
    );
    vi.stubGlobal(
      "OffscreenCanvas",
      class {
        constructor(
          public width: number,
          public height: number,
        ) {
          smallestRequested = Math.min(smallestRequested, width);
        }
        getContext() {
          return { fillStyle: "", fillRect: vi.fn(), drawImage: vi.fn() };
        }
        async convertToBlob({ type }: { type: string; quality: number }) {
          // Only a genuinely downscaled pass fits the budget.
          const size = smallestRequested < 800 ? 100_000 : 5_000_000;
          return new Blob([new Uint8Array(size)], { type });
        }
      },
    );

    const result = await compressImageForStash(makeFile(4_000_000));

    expect(result.ok).toBe(true);
    // Fallback passes must scale off the bitmap, not a fixed 2048 ceiling
    // that would never go below an 800px source.
    expect(smallestRequested).toBeLessThan(800);
  });
});

describe("snapshot coordinates after compression", () => {
  const source: SnapShotSource = {
    kind: "snap-shot",
    capturedAt: "2026-09-01T00:00:00.000Z",
    appName: "Editor",
    windowTitle: "main.ts",
    accessibility: {
      format: "element-tree",
      coordinateSpace: "captured-image",
      imageSize: { width: 2560, height: 1600 },
      truncated: false,
      root: {
        role: "window",
        bounds: { x: 0, y: 0, width: 2560, height: 1600 },
        children: [
          {
            role: "button",
            name: "Save",
            bounds: { x: 2400, y: 1400, width: 100, height: 100 },
            children: [],
          },
          { role: "static_text", name: "Untitled", bounds: null, children: [] },
        ],
      },
    },
  };

  it.each(["stash", "delivery"])(
    "rescales the source and restores it with the compressed %s image",
    async (path) => {
      stubCanvasPipeline(() => 100);
      vi.stubGlobal(
        "createImageBitmap",
        vi.fn(async () => ({ width: 2560, height: 1600, close: vi.fn() })),
      );
      const original = makeFile(2000);
      const compressed =
        path === "stash"
          ? await compressImageForStash(original, 1000)
          : await compressImageToByteLimit(original, 1000);
      expect(compressed.ok).toBe(true);
      if (!compressed.ok) throw new Error("Compression failed");
      const image =
        "image" in compressed
          ? compressed.image
          : {
              ...compressed,
              mimeType: compressed.file.type,
              sizeBytes: compressed.file.size,
              dataUrl: `data:${compressed.file.type};base64,${Buffer.from(await compressed.file.arrayBuffer()).toString("base64")}`,
            };
      expect(image.imageSize).toEqual({ width: 2048, height: 1280 });
      const resized = resizeSnapShotSource(source, image.imageSize);
      const [restored] = hydrateImagesFromPersisted([
        {
          id: "capture",
          name: "window.webp",
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: image.dataUrl,
          source: resized,
        },
      ]);
      expect(restored?.type === "image" ? restored.source?.accessibility : undefined).toMatchObject(
        {
          imageSize: { width: 2048, height: 1280 },
          root: {
            bounds: { x: 0, y: 0, width: 2048, height: 1280 },
            children: [{ bounds: { x: 1920, y: 1120, width: 80, height: 80 } }, { bounds: null }],
          },
        },
      );
      expect(source.accessibility).toMatchObject({ imageSize: { width: 2560, height: 1600 } });
    },
  );

  it("keeps uncompressed sources unchanged", () => {
    expect(resizeSnapShotSource(source)).toBe(source);
  });
});
