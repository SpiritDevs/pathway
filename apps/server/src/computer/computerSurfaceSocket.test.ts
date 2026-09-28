import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Queue, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import { decodeSurfaceFrame } from "@spiritdevs/shared/environmentSurface";
import { serveEnvironmentSurface } from "../surface/environmentSurfaceRoute.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

it.layer(NodeServices.layer)("computer surface on writer-only sockets", (it) => {
  it.effect("streams a primary screen without a turn using the Bun-compatible adapter", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const incoming = yield* Queue.unbounded<string>();
        const outgoing = yield* Queue.unbounded<Uint8Array | string | Socket.CloseEvent>();
        const released = yield* Deferred.make<void>();
        const backend = Object.assign(new FakeComputerBackend(), {
          captureSurface: () =>
            backend.captureScreenshot({
              kind: "region",
              region: { x: 0, y: 0, width: 1920, height: 1080 },
            }),
        });
        const manager = yield* ComputerManager.make({ backend });
        const socket = Socket.make({
          runRaw: (handler) =>
            Stream.fromQueue(incoming).pipe(
              Stream.runForEach((message) => {
                const result = handler(message);
                return Effect.isEffect(result) ? result : Effect.void;
              }),
            ),
          writer: Effect.succeed((message) => Queue.offer(outgoing, message).pipe(Effect.asVoid)),
        });
        const running = yield* serveEnvironmentSurface(
          socket,
          { kind: "computer", computerId: "desktop", width: 800, height: 600, deviceScale: 1 },
          {
            interact: () => Effect.die("browser used"),
            interactions: () => Stream.empty,
            command: () => Effect.die("browser used"),
            frames: () => Stream.empty,
            subscribeSurface: () => Effect.die("browser used"),
          },
          { supported: true, availability: { kind: "available", backend: "fake" }, manager },
        ).pipe(
          Effect.scoped,
          Effect.ensuring(Deferred.succeed(released, undefined)),
          Effect.forkScoped,
        );
        yield* Queue.offer(incoming, "ready");
        const frame = yield* Queue.take(outgoing);
        expect(frame).toBeInstanceOf(Uint8Array);
        if (frame instanceof Uint8Array)
          expect(decodeSurfaceFrame(frame).jpeg.byteLength).toBeGreaterThan(0);
        expect(yield* Queue.take(outgoing)).toBe("ping");
        expect(manager.surfaceControl.snapshot.controller.kind).toBe("idle");
        yield* Queue.offer(incoming, "pong");
        yield* Fiber.interrupt(running);
        yield* Deferred.await(released);
      }),
    ),
  );
});
