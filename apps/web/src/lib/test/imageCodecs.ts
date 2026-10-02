import * as NodeBuffer from "node:buffer";
import * as NodeModule from "node:module";
import * as NodeWorkerThreads from "node:worker_threads";
import { createCanvas, ImageData, loadImage } from "@napi-rs/canvas";
import { vi } from "vite-plus/test";

/** Real HEIF worker + native raster codecs, without launching a browser. */
export function installImageCodecs() {
  const workers: Promise<NodeWorkerThreads.Worker>[] = [];
  const canvasModule = NodeModule.createRequire(import.meta.url).resolve("@napi-rs/canvas");
  vi.stubGlobal(
    "Worker",
    class extends EventTarget {
      worker: Promise<NodeWorkerThreads.Worker>;
      constructor(url: string) {
        super();
        this.worker = NodeBuffer.resolveObjectURL(url)!
          .text()
          .then((script) => {
            const worker = new NodeWorkerThreads.Worker(
              `
          const { parentPort } = require('node:worker_threads');
          globalThis.self = globalThis;
          globalThis.ImageData = require(${JSON.stringify(canvasModule)}).ImageData;
          globalThis.postMessage = message => {
            const image = message.imageData;
            parentPort.postMessage({ ...message, imageData: image ? { width: image.width, height: image.height, data: image.data } : null });
          };
          globalThis.onmessage = null;
          parentPort.on('message', data => globalThis.onmessage({ data }));
          ${script}
        `,
              { eval: true },
            );
            worker.on("message", (data) =>
              this.dispatchEvent(new MessageEvent("message", { data })),
            );
            worker.on("error", (error) =>
              this.dispatchEvent(new MessageEvent("error", { data: error })),
            );
            return worker;
          });
        workers.push(this.worker);
      }
      postMessage(data: unknown) {
        // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker, not a window.
        void this.worker.then((worker) => worker.postMessage(data));
      }
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    async (source: Blob | { width: number; height: number; data: Uint8ClampedArray }) => {
      if (source instanceof Blob) {
        const image = await loadImage(Buffer.from(await source.arrayBuffer()));
        return Object.assign(image, { close() {} });
      }
      const canvas = createCanvas(source.width, source.height);
      canvas
        .getContext("2d")
        .putImageData(
          new ImageData(new Uint8ClampedArray(source.data), source.width, source.height),
          0,
          0,
        );
      return Object.assign(canvas, { close() {} });
    },
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      canvas;
      constructor(width: number, height: number) {
        this.canvas = createCanvas(width, height);
      }
      getContext() {
        return this.canvas.getContext("2d");
      }
      async convertToBlob({ type, quality }: { type: string; quality: number }) {
        const bytes = await this.canvas.encode(
          type === "image/webp" ? "webp" : "jpeg",
          Math.round(quality * 100),
        );
        return new Blob([new Uint8Array(bytes)], { type });
      }
    },
  );
  return async () => {
    await Promise.all(workers.map(async (worker) => (await worker).terminate()));
    vi.unstubAllGlobals();
  };
}
