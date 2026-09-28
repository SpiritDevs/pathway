import type { ComputerScreenshot, EnvironmentSurfaceViewport } from "@spiritdevs/contracts";
import { Clock, Effect, Fiber, type Scope } from "effect";
import { EnvironmentSurfaceStream, type SurfaceSink } from "../surface/EnvironmentSurfaceStream.ts";
import { StillFrameDedupe } from "./stillFrameDedupe.ts";
import { ComputerBackendError, type ComputerOperationError } from "./computerErrors.ts";

export const COMPUTER_SURFACE_INTERVAL_MS = 1000 / 15;
export const encodeComputerSurface = (
  bytes: Uint8Array,
  config: { maxWidth: number; maxHeight: number; quality: number },
) =>
  Effect.tryPromise({
    try: async () => {
      const { default: sharp } = await import("sharp");
      return sharp(bytes)
        .resize({
          width: config.maxWidth,
          height: config.maxHeight,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: config.quality })
        .toBuffer({ resolveWithObject: true });
    },
    catch: (cause) =>
      new ComputerBackendError({ message: `Computer frame encoding failed: ${String(cause)}` }),
  }).pipe(Effect.map(({ data, info }) => ({ jpeg: data, width: info.width, height: info.height })));

/** One capture and JPEG encoder per primary display, shared by every surface socket. */
export class ComputerSurfaceStream {
  private readonly stream = new EnvironmentSurfaceStream();
  private readonly dedupe = new StillFrameDedupe();
  private fiber: Fiber.Fiber<void> | undefined;
  private epoch = 0;
  private sequence = 0;
  private geometry: string | undefined;

  private readonly capture: () => Effect.Effect<ComputerScreenshot, ComputerOperationError>;
  private readonly runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void>;
  private readonly encode: typeof encodeComputerSurface;

  constructor(
    capture: () => Effect.Effect<ComputerScreenshot, ComputerOperationError>,
    runFork: (effect: Effect.Effect<void>) => Fiber.Fiber<void>,
    encode = encodeComputerSurface,
  ) {
    this.capture = capture;
    this.runFork = runFork;
    this.encode = encode;
  }

  subscribe(
    viewport: EnvironmentSurfaceViewport,
    sink: SurfaceSink,
  ): Effect.Effect<void, never, Scope.Scope> {
    return Effect.acquireRelease(
      Effect.sync(() => {
        const remove = this.stream.add(sink, viewport);
        if (!this.fiber) {
          const epoch = ++this.epoch;
          this.fiber = this.runFork(Effect.yieldNow.pipe(Effect.andThen(this.loop(epoch))));
        }
        return remove;
      }),
      (remove) =>
        Effect.suspend(() => {
          remove();
          if (this.stream.size) return Effect.void;
          return this.stop();
        }),
    ).pipe(Effect.asVoid);
  }

  stop(): Effect.Effect<void> {
    return Effect.suspend(() => {
      this.epoch++;
      const fiber = this.fiber;
      this.fiber = undefined;
      this.stream.close();
      this.dedupe.reset();
      this.geometry = undefined;
      return fiber ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void;
    });
  }

  private loop(epoch: number): Effect.Effect<void> {
    return Effect.gen({ self: this }, function* () {
      while (epoch === this.epoch && this.stream.size) {
        const start = yield* Clock.currentTimeMillis;
        this.stream.tick();
        const frame = yield* this.capture();
        if (epoch !== this.epoch || !this.stream.size) return;
        const region = frame.region;
        if (!region || region.x !== 0 || region.y !== 0 || region.width <= 0 || region.height <= 0)
          return yield* new ComputerBackendError({
            message: "Computer surface requires a primary-display frame with origin (0,0).",
          });
        const bytes = Buffer.from(frame.bytesBase64, "base64");
        const geometry = `${region.width}:${region.height}`;
        if (this.dedupe.shouldPublish(bytes, this.geometry !== geometry)) {
          this.geometry = geometry;
          const config = this.stream.configuration(region);
          const encoded = yield* this.encode(bytes, config);
          if (epoch !== this.epoch || !this.stream.size) return;
          this.stream.publish({
            ...encoded,
            sequence: this.sequence++,
            timestampMs: yield* Clock.currentTimeMillis,
            deviceScale: encoded.width / region.width,
          });
        }
        const elapsed = (yield* Clock.currentTimeMillis) - start;
        yield* Effect.sleep(Math.max(1, COMPUTER_SURFACE_INTERVAL_MS - elapsed));
      }
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("Computer surface capture ended", cause)),
      Effect.ensuring(
        Effect.sync(() => {
          if (epoch !== this.epoch) return;
          this.stream.close();
          this.dedupe.reset();
          this.geometry = undefined;
          this.fiber = undefined;
        }),
      ),
    );
  }
}
