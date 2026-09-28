import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  COMPUTER_SURFACE_METHODS as methods,
  ComputerError,
  MessageId,
  ThreadId,
} from "@spiritdevs/contracts";
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect";
import sharp from "sharp";
import * as ServerConfig from "../config.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { makeComputerSurfaceHandlers } from "./wsComputerSurfaceHandlers.ts";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { DesktopDispatchAuthority } from "./DesktopOperationQueue.ts";
import { makeWsComputerHandlers } from "./wsComputerHandlers.ts";

const fixture = Effect.gen(function* () {
  const backend = Object.assign(new FakeComputerBackend(), {
    surfaceKeyboardWindow: () =>
      backend
        .listWindows()
        .pipe(Effect.map((windows) => windows.find((w) => w.visible && !w.minimized))),
    captureSurface: () =>
      backend.captureScreenshot({
        kind: "region",
        region: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
  });
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  let allowed = true;
  const admit = Effect.suspend(() =>
    allowed ? Effect.void : Effect.fail(new ComputerError({ message: "policy denied" })),
  );
  const a = makeComputerSurfaceHandlers(manager, "a", admit);
  const b = makeComputerSurfaceHandlers(manager, "b", admit);
  return {
    backend,
    manager,
    a,
    b,
    deny: () => {
      allowed = false;
    },
  };
});

it.layer(NodeServices.layer)("computer surface RPC behavior", (it) => {
  it.effect("refuses physical pointer phases without held-input cleanup", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = Object.assign(new FakeComputerBackend(), {
          surfacePointer: () => Effect.die("unsafe pointer dispatch"),
        });
        const manager = yield* ComputerManager.make({ backend });
        expect(manager.surfaceControl.snapshot.capabilities.pointerPhases).toBe(false);
        yield* manager.surfaceControl.take("human");
        expect(
          (yield* Effect.flip(
            manager.surfaceInput("human", {
              type: "pointer.down",
              x: 20,
              y: 20,
            }),
          )).message,
        ).toContain("does not support physical pointer phases");
      }),
    ),
  );
  it.effect("routes physical pointer phases only when the backend advertises them", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const phases: string[] = [];
        let stops = 0;
        const backend = Object.assign(new FakeComputerBackend(), {
          stopInput: () =>
            Effect.sync(() => {
              stops++;
            }),
          surfacePointer: (input: { type: string }) =>
            Effect.sync(() => {
              phases.push(input.type);
              return undefined;
            }),
        });
        const manager = yield* ComputerManager.make({ backend });
        expect(manager.surfaceControl.snapshot.capabilities.pointerPhases).toBe(true);
        yield* manager.surfaceControl.take("human");
        for (const type of ["pointer.down", "pointer.move", "pointer.up"] as const)
          yield* manager.surfaceInput("human", { type, x: 20, y: 20 });
        expect(phases).toEqual(["pointer.down", "pointer.move", "pointer.up"]);
        yield* manager.surfaceControl.release("human");
        expect(stops).toBe(1);
      }),
    ),
  );

  it.effect(
    "routes idle click, wheel, type and key input through the manager and returns only acknowledgements",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { a, b, backend } = yield* fixture;
          yield* a[methods.takeControl]();
          yield* Effect.flip(b[methods.input]({ event: { type: "key", key: "A" } }));
          for (const event of [
            { type: "pointer.click", x: 20, y: 20 },
            { type: "wheel", x: 20, y: 20, deltaX: 1.5, deltaY: 2.5 },
            { type: "type", text: "hello" },
            { type: "key", key: "A", modifiers: ["meta"] },
          ] as const)
            expect(yield* a[methods.input]({ event })).toBeUndefined();
          expect(backend.callsFor("click")).toHaveLength(1);
          expect(backend.callsFor("scroll")).toHaveLength(1);
          expect(backend.callsFor("typeText")).toHaveLength(1);
          expect(backend.callsFor("hotkey")).toHaveLength(1);
          const unsupported = yield* Effect.flip(
            a[methods.input]({ event: { type: "pointer.down", x: 20, y: 20 } }),
          );
          expect(unsupported.message).toContain("does not support physical pointer phases");
          yield* Effect.flip(a[methods.input]({ event: { type: "pointer.click", x: -1, y: 20 } }));
          yield* a[methods.releaseControl]();
          yield* Effect.flip(a[methods.input]({ event: { type: "key", key: "A" } }));
        }),
      ),
  );

  it.effect("rechecks policy after queue waits, while release remains available", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.a[methods.takeControl]();
        const held = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const blocking = yield* f.manager.surfaceControl
          .input(
            "a",
            { type: "key", key: "A" },
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held))),
          )
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(entered);
        const waiting = yield* f.a[methods.input]({
          event: { type: "type", text: "must not type" },
        }).pipe(Effect.flip, Effect.forkChild({ startImmediately: true }));
        f.deny();
        yield* Deferred.succeed(held, undefined);
        yield* Fiber.join(blocking);
        expect((yield* Fiber.join(waiting)).message).toBe("policy denied");
        expect(f.backend.callsFor("typeText")).toHaveLength(0);
        yield* f.a[methods.releaseControl]();
        yield* Effect.flip(f.b[methods.takeControl]());
      }),
    ),
  );

  it.effect("legacy pane input cannot bypass a surface controller", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.a[methods.takeControl]();
        const legacy = makeWsComputerHandlers({
          manager: f.manager,
          supported: true,
          availability: { kind: "available", backend: "fake" },
        });
        const result = yield* legacy["computer.input.click"]({ x: 20, y: 20 }).pipe(
          Effect.provideService(
            DesktopDispatchAuthority,
            f.manager.surfaceControl.assertUnclaimed(),
          ),
          Effect.flip,
        );
        expect(result.message).toContain("does not hold");
        expect(f.backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("stores a real chat attachment and bounded handback context before releasing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* fixture;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        yield* f.a[methods.takeControl]();
        yield* f.a[methods.input]({ event: { type: "type", text: "private password" } });
        const handback = yield* f.a[methods.handBack]({
          threadId: ThreadId.make("thread-a"),
          messageId: MessageId.make("message-a"),
        });
        expect(handback.state.state.controller.kind).toBe("idle");
        expect(handback.summary).toContain("Typed 16 characters");
        expect(handback.summary).not.toContain("private password");
        expect(handback.attachment).toMatchObject({
          type: "image",
          name: "computer-screen.jpg",
          mimeType: "image/jpeg",
        });
        const bytes = yield* fs.readFile(
          path.join(config.attachmentsDir, attachmentRelativePath(handback.attachment)),
        );
        expect(bytes.byteLength).toBe(handback.attachment.sizeBytes);
        expect((yield* Effect.promise(() => sharp(bytes).metadata())).format).toBe("jpeg");
      }),
    ).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "pathway-computer-handback-test-" }),
      ),
    ),
  );
});
