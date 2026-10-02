// @effect-diagnostics nodeBuiltinImport:off -- Load committed codec fixtures for a browser-free test.
import * as NodeFSP from "node:fs/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { prepareConversationFile } from "../components/orchestrator/conversationAttachmentDrafts";
import { compressImageForStash, compressImageToByteLimit } from "./imageCompression";
import { isHeicImage } from "./heicImage";
import { installImageCodecs } from "./test/imageCodecs";

const fixture = async (ext: string, type: string, name = `two-colors.${ext}`) =>
  new File(
    [
      new Uint8Array(
        await NodeFSP.readFile(new URL(`./fixtures/heic/two-colors.${ext}`, import.meta.url)),
      ),
    ],
    name,
    { type },
  );
let cleanup: () => Promise<void>;
beforeAll(() => {
  cleanup = installImageCodecs();
});
afterAll(async () => {
  await cleanup();
});

describe("real HEIC attachment conversion", () => {
  it("converts a source above the upload limit before validating metadata", async () => {
    const source = await fixture("heic", "image/heic");
    const original = new File([source, new Uint8Array(10 * 1024 * 1024)], source.name, {
      type: source.type,
    });
    const { file, attachment } = await prepareConversationFile(original, "large-source");
    expect(original.size).toBeGreaterThan(10 * 1024 * 1024);
    expect(file.size).toBeLessThan(10 * 1024 * 1024);
    expect(attachment.sizeBytes).toBe(file.size);
    expect((await loadImage(Buffer.from(await file.arrayBuffer()))).width).toBe(32);
  });

  it("produces real JPEG bytes when the canvas cannot encode WebP", async () => {
    const Canvas = globalThis.OffscreenCanvas;
    globalThis.OffscreenCanvas = class extends Canvas {
      override convertToBlob(options: ImageEncodeOptions = {}) {
        if (options.type === "image/webp")
          return Promise.resolve(new Blob([], { type: "image/png" }));
        return super.convertToBlob(options);
      }
    };
    try {
      const { file, attachment } = await prepareConversationFile(
        await fixture("heic", "image/heic"),
        "jpeg-fallback",
      );
      expect(attachment).toMatchObject({
        name: "two-colors.jpg",
        mimeType: "image/jpeg",
        sizeBytes: file.size,
      });
      const bytes = Buffer.from(await file.arrayBuffer());
      expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
      expect((await loadImage(bytes)).width).toBe(32);
    } finally {
      globalThis.OffscreenCanvas = Canvas;
    }
  });

  it.each(["image/heic", "image/heif", "application/octet-stream", ""])(
    "converts small %s input and keeps upload metadata consistent",
    async (type) => {
      const original = await fixture("heic", type, "pasted-photo.bin");
      expect(original.size).toBeLessThan(10_000);
      const { file, attachment } = await prepareConversationFile(original, "image-id");
      expect(attachment).toEqual({
        id: "image-id",
        type: "image",
        name: "pasted-photo.webp",
        mimeType: "image/webp",
        sizeBytes: file.size,
      });
      const bytes = Buffer.from(await file.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe("RIFF");
      expect(bytes.subarray(8, 12).toString()).toBe("WEBP");
      expect(await isHeicImage(file)).toBe(false);
      const decoded = await loadImage(bytes);
      expect([decoded.width, decoded.height]).toEqual([32, 64]);
      const canvas = createCanvas(32, 64);
      const context = canvas.getContext("2d");
      context.drawImage(decoded, 0, 0);
      const top = context.getImageData(16, 8, 1, 1).data;
      const bottom = context.getImageData(16, 56, 1, 1).data;
      expect(top[0]).toBeGreaterThan(230);
      expect(top[2]).toBeLessThan(25);
      expect(bottom[2]).toBeGreaterThan(230);
      expect(bottom[0]).toBeLessThan(25);
    },
  );

  it.each([
    ["png", "image/png"],
    ["jpg", "image/jpeg"],
  ])("preserves %s bytes, name, MIME and size", async (ext, mime) => {
    const original = await fixture(ext, mime);
    const prepared = await prepareConversationFile(original, "regression");
    expect(prepared.file).toBe(original);
    expect(prepared.attachment).toMatchObject({
      name: original.name,
      mimeType: mime,
      sizeBytes: original.size,
    });
    expect(await prepared.file.arrayBuffer()).toEqual(await original.arrayBuffer());
    expect(await loadImage(Buffer.from(await prepared.file.arrayBuffer()))).toBeDefined();
  });

  it("converts HEIC before stashing even when within budget", async () => {
    const result = await compressImageForStash(await fixture("heic", "image/heic"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.image.recompressed).toBe(true);
    const bytes = Buffer.from(result.image.dataUrl.split(",")[1]!, "base64");
    expect(result.image.sizeBytes).toBe(bytes.length);
    expect((await loadImage(bytes)).width).toBe(32);
  });

  it("rejects corrupt HEIC visibly instead of passing small bytes through", async () => {
    const file = new File(["not an image"], "broken.HEIC", { type: "image/heic" });
    await expect(prepareConversationFile(file, "broken")).rejects.toThrow("could not be converted");
    expect(await compressImageToByteLimit(file, 10_000)).toEqual({
      ok: false,
      reason: "unreadable",
    });
  });

  it("does not classify AVIF compatible with mif1 as HEIC", async () => {
    const bytes = new Uint8Array(24);
    new DataView(bytes.buffer).setUint32(0, 24);
    bytes.set(new TextEncoder().encode("ftypmif1"), 4);
    bytes.set(new TextEncoder().encode("avif"), 16);
    expect(await isHeicImage(new File([bytes], "image.avif"))).toBe(false);
  });
});
