import { afterEach, expect, it, vi } from "vite-plus/test";
import { createDeviceStreamClient } from "./stream.ts";

const envelope = (tag: number, data: number[]) =>
  new Uint8Array([0, 0, 0, data.length + 1, tag, ...data]);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup() {
  vi.useFakeTimers();
  const decoders: FakeDecoder[] = [];
  class FakeDecoder {
    static isConfigSupported = async () => ({ supported: true });
    state = "unconfigured";
    decodeQueueSize = 0;
    close = vi.fn(() => {
      this.state = "closed";
    });
    configure = vi.fn(() => {
      this.state = "configured";
    });
    decode = vi.fn();
    constructor(readonly callbacks: VideoDecoderInit) {
      decoders.push(this);
    }
  }
  vi.stubGlobal("VideoDecoder", FakeDecoder);
  vi.stubGlobal(
    "EncodedVideoChunk",
    class {
      constructor(readonly init: EncodedVideoChunkInit) {}
    },
  );
  const responses: ReadableStreamDefaultController<Uint8Array>[] = [];
  const fetch = vi.fn((_url: string, init: RequestInit) =>
    Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            responses.push(controller);
            init.signal?.addEventListener("abort", () => {
              try {
                controller.error(new Error("aborted"));
              } catch {}
            });
            controller.enqueue(envelope(1, [1, 0x64, 0, 0x1f]));
            controller.enqueue(envelope(2, [9]));
          },
        }),
      ),
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const present = vi.fn();
  const client = createDeviceStreamClient(
    {
      platform: "ios",
      deviceId: "test",
      videoOnly: true,
      access: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
    },
    { present },
    {
      onStatus: vi.fn(),
      onScreen: vi.fn(),
      onUnauthorized: vi.fn(),
      onMjpegFallback: vi.fn(),
      onInputConnected: vi.fn(),
    },
  );
  const frame = () =>
    ({ displayWidth: 100, displayHeight: 200, close: vi.fn() }) as unknown as VideoFrame;
  return { client, responses, decoders, fetch, present, frame };
}

it("recreates the decoder after EOF and closes stale output without dropping new frames", async () => {
  const f = setup();
  f.client.start();
  await vi.advanceTimersByTimeAsync(0);
  const first = f.decoders[0]!;
  first.callbacks.output(f.frame());
  expect(f.present).toHaveBeenCalledTimes(1);
  f.responses[0]!.close();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.decoders).toHaveLength(2);
  expect(first.close).toHaveBeenCalledOnce();
  const stale = f.frame();
  first.callbacks.output(stale);
  expect(stale.close).toHaveBeenCalledOnce();
  expect(f.present).toHaveBeenCalledTimes(1);
  f.decoders[1]!.callbacks.output(f.frame());
  expect(f.present).toHaveBeenCalledTimes(2);
  f.client.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["overflow", "error"])(
  "reopens one AVCC response after decoder %s and cancels recovery on stop",
  async (failure) => {
    const f = setup();
    f.client.start();
    await vi.advanceTimersByTimeAsync(0);
    const decoder = f.decoders[0]!;
    if (failure === "overflow") {
      decoder.decodeQueueSize = 100;
      f.responses[0]!.enqueue(envelope(3, [8]));
      await vi.advanceTimersByTimeAsync(0);
    } else {
      decoder.callbacks.error(new DOMException("decoder failed"));
      decoder.callbacks.error(new DOMException("duplicate failure"));
    }
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.decoders).toHaveLength(2);
    f.decoders[1]!.callbacks.output(f.frame());
    expect(f.present).toHaveBeenCalledOnce();
    f.decoders[1]!.callbacks.error(new DOMException("failed again"));
    f.client.stop();
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  },
);
