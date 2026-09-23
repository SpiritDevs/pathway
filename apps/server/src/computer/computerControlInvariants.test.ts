import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import type { ComputerBackend } from "./ComputerBackend.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

// Synara's remaining cases in this suite ("an intervening explicit screenshot
// must prevent unrelated image reuse", "routes every provider's routine
// mutations through the same task gate", "lets Synara approve or deny %s
// actions" and "rechecks original turn authority after waiting for the
// desktop") drive the agent gateway's computer tools, which are not part of
// this port; they belong with the gateway tool suite.

it.layer(NodeServices.layer)("Production audit: desired invariants", (it) => {
  it.effect("hover must not change keyboard focus", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = new FakeComputerBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.moveCursor("audit", { windowId: "fake-calculator", x: 1180, y: 228 });
        expect(backend.calls.filter((c) => c.method === "focusWindow")).toEqual([]);
      }),
    ),
  );

  it.effect("concurrent keyboard calls must preserve each named target", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const backend = new FakeComputerBackend();
      let aim = "";
      const deliveries: { text: string; aim: string }[] = [];
      Object.assign(backend, {
        focusWindow: (id: string) =>
          Effect.gen(function* () {
            aim = id;
            if (id === "fake-calculator") {
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(release);
            }
          }),
        typeText: (text: string) =>
          Effect.sync(() => {
            deliveries.push({ text, aim });
            return { value: text };
          }),
      } satisfies Partial<ComputerBackend>);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.listWindows();
          const first = yield* Effect.forkChild(
            manager.typeText("audit", "calculator text", "fake-calculator"),
          );
          yield* Deferred.await(entered);
          const second = yield* Effect.forkChild(
            manager.typeText("audit", "browser text", "fake-terminal"),
            { startImmediately: true },
          );
          yield* Effect.yieldNow;
          expect(deliveries).toEqual([]);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(first);
          yield* Fiber.join(second);
        }),
      );
      expect(deliveries.find((d) => d.text === "calculator text")?.aim).toBe("fake-calculator");
    }),
  );

  // The gateway tool is a thin wrapper over `manager.click`; an aborted tool
  // call is an interrupted fiber here, so the invariant is proved on the
  // manager call the tool would have made.
  it.effect("aborting a tool during targeting must prevent its later click", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const backend = new FakeComputerBackend();
      const getState = backend.getState.bind(backend);
      Object.assign(backend, {
        getState: (options: Parameters<ComputerBackend["getState"]>[0]) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return yield* getState(options);
          }),
      } satisfies Partial<ComputerBackend>);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          const result = yield* Effect.forkChild(
            manager.click("audit", { label: "Calculate", role: "button" }),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(result);
          yield* Deferred.succeed(release, undefined);
          yield* Effect.yieldNow;
        }),
      );
      expect(backend.calls.filter((c) => c.method === "click")).toEqual([]);
    }),
  );

  it.effect("a moved window must deliver its new screenshot geometry", () =>
    Effect.gen(function* () {
      const backend = new FakeComputerBackend();
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
          yield* manager.captureActionScreenshot("fake-calculator", undefined, "audit");
          backend.emitWindowsChanged(
            (yield* backend.listWindows()).map((w) =>
              w.id === "fake-calculator" ? { ...w, bounds: { ...w.bounds!, x: 800 } } : w,
            ),
          );
          return yield* manager.captureActionScreenshot("fake-calculator", undefined, "audit");
        }),
      );
      expect(result).toHaveProperty("screenshot.region.x", 800);
    }),
  );
});

it.layer(NodeServices.layer)("Provider authority invariants", (it) => {
  it.effect("a fresh invocation re-arms Stop but an older queued invocation cannot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const manager = yield* ComputerManager.make({
          backend: new FakeComputerBackend(),
          actionSettleMs: 0,
        });
        const stopped = yield* manager.setControlEnabled("audit", false);
        expect((yield* manager.getThreadState("audit")).controlGeneration).toBe(stopped.generation);
        expect(yield* manager.admitControl("audit", "request", 0, true)).toBe(false);
        expect(yield* manager.admitControl("audit", "request", stopped.generation, true)).toBe(
          true,
        );
        // Re-arming this explicit request never authorizes later turns or goals.
        expect(manager.canContinueChatControl("audit")).toBe(false);
      }),
    ),
  );
});
