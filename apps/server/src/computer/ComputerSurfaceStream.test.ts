import { expect, it } from "@effect/vitest";
import type { ComputerScreenshot } from "@spiritdevs/contracts";
import { decodeSurfaceFrame } from "@spiritdevs/shared/environmentSurface";
import { Deferred, Effect, Exit, FiberSet, Queue, Scope } from "effect";
import * as TestClock from "effect/testing/TestClock";
import { ComputerSurfaceStream, encodeComputerSurface } from "./ComputerSurfaceStream.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import sharp from "sharp";

const viewport = { width: 1200, height: 800, deviceScale: 2 };
const screenshot = (content = "pixels"): ComputerScreenshot => ({
  mimeType: "image/png",
  width: 2400,
  height: 1600,
  sizeBytes: content.length,
  bytesBase64: Buffer.from(content).toString("base64"),
  capturedAt: "2026-09-29T00:00:00.000Z",
  region: { x: 0, y: 0, width: 1200, height: 800 },
  scale: 2,
});

const fixture = Effect.gen(function* () {
  const captures =
    yield* Queue.unbounded<Deferred.Deferred<ComputerScreenshot, ComputerBackendError>>();
  const runFork = yield* FiberSet.makeRuntime<never, void, never>();
  let captureCount = 0;
  const configurations: Array<{ quality: number; maxWidth: number; maxHeight: number }> = [];
  const encoded = yield* Queue.unbounded<void>();
  const stream = new ComputerSurfaceStream(
    () =>
      Effect.gen(function* () {
        captureCount++;
        const reply = yield* Deferred.make<ComputerScreenshot, ComputerBackendError>();
        yield* Queue.offer(captures, reply);
        return yield* Deferred.await(reply);
      }),
    runFork,
    (_bytes, config) =>
      Effect.gen(function* () {
        configurations.push(config);
        yield* Queue.offer(encoded, undefined);
        return {
          jpeg: Buffer.from([1, 2, 3]),
          width: config.maxWidth,
          height: Math.round((config.maxWidth * 2) / 3),
        };
      }),
  );
  const add = Effect.fn(function* (buffered: () => number = () => 0, viewerViewport = viewport) {
    const scope = yield* Scope.make();
    const frames: Uint8Array[] = [];
    const sent = yield* Queue.unbounded<void>();
    let closed = false;
    yield* stream
      .subscribe(viewerViewport, {
        send: (bytes) => {
          frames.push(bytes);
          Queue.offerUnsafe(sent, undefined);
        },
        bufferedAmount: buffered,
        close: () => {
          closed = true;
        },
      })
      .pipe(Effect.provideService(Scope.Scope, scope));
    return { frames, sent, closed: () => closed, close: Scope.close(scope, Exit.void) };
  });
  yield* Effect.addFinalizer(() => stream.stop());
  return { stream, captures, encoded, add, configurations, count: () => captureCount };
});

it.effect(
  "shares one encoder, dedupes unchanged screens, replays late viewers and stops when unwatched",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        expect(f.count()).toBe(0);
        const a = yield* f.add();
        const b = yield* f.add();
        yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
        yield* Queue.take(a.sent);
        yield* Queue.take(b.sent);
        expect(f.configurations).toHaveLength(1);
        expect(a.frames[0]).toBe(b.frames[0]);
        expect(decodeSurfaceFrame(a.frames[0]!)).toMatchObject({
          width: 2400,
          height: 1600,
          deviceScale: 2,
        });
        const c = yield* f.add();
        yield* Queue.take(c.sent);
        expect(f.configurations).toHaveLength(1);
        yield* TestClock.adjust(67);
        yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
        yield* TestClock.adjust(67);
        // Reaching the next capture proves the unchanged frame completed without an encode or send.
        const next = yield* Queue.take(f.captures);
        expect(f.configurations).toHaveLength(1);
        expect(a.frames).toHaveLength(1);
        yield* Deferred.succeed(next, screenshot("changed"));
        yield* Queue.take(a.sent);
        expect(f.configurations).toHaveLength(2);
        yield* a.close;
        yield* b.close;
        yield* c.close;
        const count = f.count();
        yield* TestClock.adjust(1000);
        expect(f.count()).toBe(count);
        const again = yield* f.add();
        yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot("changed"));
        yield* Queue.take(again.sent);
        expect(f.configurations).toHaveLength(3);
        yield* again.close;
      }),
    ),
);

it.effect.each([
  { width: 1920, height: 1080, deviceScale: 1 },
  { width: 1920, height: 180, deviceScale: 1 },
  { width: 320, height: 1080, deviceScale: 1 },
])("re-encodes unchanged pixels when a $width x $height viewer joins or leaves", (largerViewport) =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add(undefined, { width: 320, height: 180, deviceScale: 1 });
      yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
      yield* Queue.take(a.sent);
      const b = yield* f.add(undefined, largerViewport);
      yield* Queue.take(b.sent);
      expect(decodeSurfaceFrame(b.frames[0]!).width).toBe(320);

      yield* TestClock.adjust(67);
      yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
      yield* TestClock.adjust(67);
      const next = yield* Queue.take(f.captures);
      expect(f.configurations).toMatchObject([
        { maxWidth: 320, maxHeight: 180, quality: 75 },
        { maxWidth: largerViewport.width, maxHeight: largerViewport.height, quality: 75 },
      ]);
      expect(a.frames).toHaveLength(2);
      expect(b.frames).toHaveLength(2);
      expect(a.frames[1]).toBe(b.frames[1]);
      expect(decodeSurfaceFrame(b.frames[1]!).width).toBe(largerViewport.width);

      yield* b.close;
      yield* Deferred.succeed(next, screenshot());
      yield* TestClock.adjust(67);
      yield* Queue.take(f.captures);
      expect(f.configurations).toHaveLength(3);
      expect(f.configurations[2]).toMatchObject({ maxWidth: 320, maxHeight: 180, quality: 75 });
      expect(a.frames).toHaveLength(3);
      expect(decodeSurfaceFrame(a.frames[2]!).width).toBe(320);
      yield* a.close;
    }),
  ),
);

it.effect("adapts a shared encoder under backpressure and drains the last static frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      let buffered = 300000;
      const a = yield* f.add(() => buffered);
      yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
      yield* Queue.take(f.encoded);
      yield* TestClock.adjust(67);
      yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
      yield* TestClock.adjust(67);
      const next = yield* Queue.take(f.captures);
      expect(f.configurations.map((c) => c.quality)).toEqual([60, 45]);
      expect(a.frames).toHaveLength(0);
      buffered = 0;
      yield* Deferred.succeed(next, screenshot());
      yield* TestClock.adjust(67);
      yield* Queue.take(a.sent);
      expect(decodeSurfaceFrame(a.frames[0]!).deviceScale).toBeCloseTo(1.2);
      yield* a.close;
    }),
  ),
);

it.effect.each([viewport, { width: 1, height: 1, deviceScale: 1 }])(
  "restores quality and size on unchanged pixels after backpressure clears for $width x $height",
  (viewerViewport) =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        let buffered = 300000;
        const a = yield* f.add(() => buffered, viewerViewport);
        yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
        yield* Queue.take(f.encoded);
        expect(f.configurations[0]).toMatchObject({
          maxWidth: Math.max(
            1,
            Math.floor(viewerViewport.width * viewerViewport.deviceScale * 0.8),
          ),
          maxHeight: Math.max(
            1,
            Math.floor(viewerViewport.height * viewerViewport.deviceScale * 0.8),
          ),
          quality: 60,
        });
        buffered = 0;
        // Recovery requires 50 healthy ticks; complete an identical capture on every tick.
        for (let tick = 0; tick < 50; tick++) {
          yield* TestClock.adjust(67);
          yield* Deferred.succeed(yield* Queue.take(f.captures), screenshot());
        }
        yield* TestClock.adjust(67);
        yield* Queue.take(f.captures);
        expect(f.configurations).toHaveLength(2);
        expect(f.configurations[1]).toMatchObject({
          maxWidth: viewerViewport.width * viewerViewport.deviceScale,
          maxHeight: viewerViewport.height * viewerViewport.deviceScale,
          quality: 75,
        });
        expect(a.frames).toHaveLength(2);
        expect(decodeSurfaceFrame(a.frames[1]!).width).toBe(
          viewerViewport.width * viewerViewport.deviceScale,
        );
        yield* a.close;
      }),
    ),
);

it.effect("closes viewers on capture failure and cancels in-flight captures on last detach", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture;
      const a = yield* f.add();
      const reply = yield* Queue.take(f.captures);
      yield* a.close;
      yield* Deferred.succeed(reply, screenshot());
      expect(f.configurations).toHaveLength(0);
      const b = yield* f.add();
      yield* Deferred.fail(
        yield* Queue.take(f.captures),
        new ComputerBackendError({ message: "capture unavailable" }),
      );
      // Scope cleanup joins the producer fiber and serves as the completion receipt.
      yield* f.stream.stop();
      expect(b.closed()).toBe(true);
      expect(b.frames).toHaveLength(0);
      yield* b.close;
    }),
  ),
);

it.effect("encodes an actual JPEG within the requested dimensions", () =>
  Effect.gen(function* () {
    const png = yield* Effect.promise(() =>
      sharp({ create: { width: 240, height: 160, channels: 3, background: "red" } })
        .png()
        .toBuffer(),
    );
    const encoded = yield* encodeComputerSurface(png, {
      maxWidth: 120,
      maxHeight: 120,
      quality: 60,
    });
    const metadata = yield* Effect.promise(() => sharp(encoded.jpeg).metadata());
    expect(metadata.format).toBe("jpeg");
    expect(metadata.width).toBe(120);
    expect(metadata.height).toBe(80);
  }),
);
