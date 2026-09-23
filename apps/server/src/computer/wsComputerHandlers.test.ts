import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  COMPUTER_WS_METHODS,
  ComputerError,
  EnvironmentAuthorizationError,
  ThreadId,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ComputerManager } from "./ComputerManager.ts";
import {
  desktopOperationSignal,
  desktopSignal,
  makeDesktopAbort,
  withDesktopOperationSignal,
} from "./DesktopOperationQueue.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import type { ComputerOperationError } from "./computerErrors.ts";
import {
  makeWsComputerHandlers,
  type WsComputerError,
  type WsComputerHandlerOptions,
} from "./wsComputerHandlers.ts";

const setup = (options?: WsComputerHandlerOptions) =>
  Effect.gen(function* () {
    const backend = new FakeComputerBackend();
    const manager = yield* ComputerManager.make({ backend });
    const handlers = makeWsComputerHandlers(
      { supported: true, availability: { kind: "available", backend: "fake" }, manager },
      options,
    );
    return { backend, manager, handlers };
  });

/** Lets forked work reach its next suspension point. */
const settle = Effect.gen(function* () {
  for (let turn = 0; turn < 20; turn += 1) yield* Effect.yieldNow;
});

it.layer(NodeServices.layer)("computer WebSocket handlers", (it) => {
  it.effect(
    "reads history independently of backend availability without dispatching desktop input",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { manager, backend } = yield* setup();
          const handlers = makeWsComputerHandlers({
            supported: false,
            availability: { kind: "backend-unavailable", message: "No native backend" },
            manager,
          });
          expect(yield* handlers[COMPUTER_WS_METHODS.getAuditHistory]({ limit: 30 })).toEqual({
            entries: [],
            nextCursor: null,
            truncated: false,
            status: "disabled",
          });
          expect(backend.callsFor("click")).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "refuses pane targeting inherited from a completed operation before reentering the queue",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager } = yield* setup();
          const scope = yield* Effect.scope;
          const release = yield* Deferred.make<void>();
          let detached: Fiber.Fiber<unknown, ComputerOperationError> | undefined;
          yield* withDesktopOperationSignal(
            desktopSignal(makeDesktopAbort()),
            Effect.gen(function* () {
              detached = yield* Deferred.await(release).pipe(
                Effect.andThen(
                  manager.withUserPointTarget({ x: 10, y: 20 }, (target) =>
                    manager.click(undefined, target),
                  ),
                ),
                Effect.forkIn(scope),
              );
            }),
          );
          yield* Deferred.succeed(release, undefined);
          const refused = yield* Effect.flip(Effect.asVoid(Fiber.join(detached!)));
          expect(refused.message).toContain("operation has ended");
          expect(backend.callsFor("click")).toHaveLength(0);
        }),
      ),
  );

  it.effect.each(["click", "scroll", "key"] as const)(
    "does not dispatch queued pane %s after its RPC is interrupted",
    (kind) =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, manager, handlers } = yield* setup();
          const entered = yield* Deferred.make<void>();
          const held = yield* Deferred.make<void>();
          const blocking = yield* manager
            .withAgentActivity(
              "owner",
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(held))),
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          const request =
            kind === "click"
              ? handlers[COMPUTER_WS_METHODS.inputClick]({ x: 400, y: 250 })
              : kind === "scroll"
                ? handlers[COMPUTER_WS_METHODS.inputScroll]({
                    x: 100,
                    y: 120,
                    deltaX: 0,
                    deltaY: 48,
                  })
                : handlers[COMPUTER_WS_METHODS.inputKey]({ key: "enter" });
          const fiber = yield* Effect.forkChild(request);
          // Let the RPC enter the manager while the first transaction owns the queue.
          yield* settle;
          yield* Fiber.interrupt(fiber);
          yield* Deferred.succeed(held, undefined);
          yield* Fiber.join(blocking);
          // A subsequent admitted operation proves the cancelled queue entry drained.
          yield* manager.withAgentActivity("observer", Effect.void);
          expect(backend.callsFor("click")).toHaveLength(0);
          expect(backend.callsFor("scroll")).toHaveLength(0);
          expect(backend.callsFor("pressKey")).toHaveLength(0);
        }),
      ),
  );

  it.effect(
    "delivers RPC cancellation to active input and holds the queue until native cleanup settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { backend, handlers } = yield* setup();
          const entered = yield* Deferred.make<void>();
          const cancelled = yield* Deferred.make<void>();
          const cleanup = yield* Deferred.make<void>();
          const pressKey = backend.pressKey.bind(backend);
          let sawSignal = false;
          backend.pressKey = (key) => {
            if (key !== "a") return pressKey(key);
            return Effect.gen(function* () {
              sawSignal = (yield* desktopOperationSignal) !== undefined;
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }).pipe(
              // Native cleanup: the interrupted keystroke releases what it holds.
              Effect.onInterrupt(() =>
                Deferred.succeed(cancelled, undefined).pipe(
                  Effect.andThen(Deferred.await(cleanup)),
                ),
              ),
            );
          };
          const fiber = yield* Effect.forkChild(
            handlers[COMPUTER_WS_METHODS.inputKey]({ key: "a" }),
          );
          yield* Deferred.await(entered);
          expect(sawSignal).toBe(true);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(fiber));
          yield* Deferred.await(cancelled);
          const next = yield* Effect.forkChild(
            handlers[COMPUTER_WS_METHODS.inputKey]({ key: "b" }),
          );
          yield* settle;
          expect(backend.callsFor("pressKey")).toHaveLength(0);
          yield* Deferred.succeed(cleanup, undefined);
          yield* Fiber.join(interrupting);
          yield* Fiber.join(next);
          expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([["b"]]);
        }),
      ),
  );

  it.effect("handles every request method in the RPC group", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* setup();
        // The stream method is wired in ws.ts where the connection's interests live.
        // `rearmInput` no longer exists anywhere — input never latches.
        const expected = Object.values(COMPUTER_WS_METHODS).filter(
          (method) => method !== COMPUTER_WS_METHODS.subscribeEvents,
        );
        expect(Object.keys(handlers).toSorted()).toEqual(expected.toSorted());
      }),
    ),
  );

  it.effect("sends a pane click straight to the backend coordinate path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        const result = yield* handlers[COMPUTER_WS_METHODS.inputClick]({ x: 400, y: 250 });
        expect(result.action).toBe("computer_click");
        expect(result.point).toEqual({ x: 400, y: 250 });
        expect(backend.callsFor("click").map((call) => call.args)).toEqual([[{ x: 400, y: 250 }]]);
        // A coordinate click must never pay for an accessibility tree read.
        expect(backend.callsFor("getState")).toHaveLength(0);
      }),
    ),
  );

  it.effect("selects an exact text range on a semantic target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        const result = yield* handlers[COMPUTER_WS_METHODS.selectText]({
          label: "Display",
          start: 0,
          length: 1,
        });
        expect(result.action).toBe("computer_select_text");
        // The fake's read-back is the selected substring of the Display value "0".
        expect(result.value).toBe("0");
        const calls = backend.callsFor("selectText");
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args[1]).toEqual({ start: 0, length: 1 });
        expect(calls[0]?.args[0]).toMatchObject({
          node: expect.objectContaining({ label: "Display" }),
        });
      }),
    ),
  );

  it.effect("scopes a perception read to the requested window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        yield* handlers[COMPUTER_WS_METHODS.getState]({ windowId: "w1", includeText: true });
        expect(backend.callsFor("getState").map((call) => call.args)).toEqual([
          [{ windowId: "w1", includeTree: true }],
        ]);
      }),
    ),
  );

  it.effect("routes the right button and the double click to their own backend actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        yield* handlers[COMPUTER_WS_METHODS.inputClick]({ x: 10, y: 20, button: "right" });
        yield* handlers[COMPUTER_WS_METHODS.inputClick]({ x: 30, y: 40, clickCount: 2 });
        expect(backend.callsFor("rightClick").map((call) => call.args)).toEqual([
          [{ x: 10, y: 20 }],
        ]);
        expect(backend.callsFor("doubleClick").map((call) => call.args)).toEqual([
          [{ x: 30, y: 40 }],
        ]);
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("scrolls at the pointer position", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        const result = yield* handlers[COMPUTER_WS_METHODS.inputScroll]({
          x: 100,
          y: 120,
          deltaX: -12,
          deltaY: 48,
        });
        expect(result.action).toBe("computer_scroll");
        expect(backend.callsFor("scroll").map((call) => call.args)).toEqual([
          [{ x: 100, y: 120 }, -12, 48],
        ]);
      }),
    ),
  );

  it.effect("presses a bare key and turns modifiers into a held chord", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        yield* handlers[COMPUTER_WS_METHODS.inputKey]({ key: "enter" });
        yield* handlers[COMPUTER_WS_METHODS.inputKey]({ key: "c", modifiers: ["ctrl", "shift"] });
        // A duplicated modifier must not be pressed and released twice.
        yield* handlers[COMPUTER_WS_METHODS.inputKey]({ key: "t", modifiers: ["alt", "alt"] });
        expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([["enter"]]);
        expect(backend.callsFor("hotkey").map((call) => call.args)).toEqual([
          [["ctrl", "shift", "c"]],
          [["alt", "t"]],
        ]);
      }),
    ),
  );

  it.effect("reports a backend failure as an RPC error instead of dying", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        backend.failNext("click");
        const error = yield* Effect.flip(handlers[COMPUTER_WS_METHODS.inputClick]({ x: 5, y: 5 }));
        expect(error).toBeInstanceOf(ComputerError);
        expect(error.message).toBe("click failed");
      }),
    ),
  );

  it.effect("rejects a point outside the screen without touching the seat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup();
        const error = yield* Effect.flip(
          handlers[COMPUTER_WS_METHODS.inputClick]({ x: 5_000, y: 5_000 }),
        );
        expect(error).toBeInstanceOf(ComputerError);
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses user input when no computer backend is supported", () =>
    Effect.gen(function* () {
      const handlers = makeWsComputerHandlers(undefined);
      const error = yield* Effect.flip(handlers[COMPUTER_WS_METHODS.inputKey]({ key: "escape" }));
      const selectError = yield* Effect.flip(
        handlers[COMPUTER_WS_METHODS.selectText]({ label: "Display", start: 0, length: 1 }),
      );
      expect(error).toBeInstanceOf(ComputerError);
      expect(selectError).toBeInstanceOf(ComputerError);
    }),
  );

  it.effect("exposes no rearm route and treats a pane Escape as ordinary input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, manager, handlers } = yield* setup();
        // Compile-level removal: the handler map has no rearm entry, so no
        // client can re-arm because there is nothing to re-arm.
        expect(
          (handlers as unknown as Record<string, unknown>)["computer.rearmInput"],
        ).toBeUndefined();

        // The same Escape key through the pane input route is a keystroke, not a
        // stop: it dispatches and leaves input working.
        yield* handlers[COMPUTER_WS_METHODS.inputKey]({ key: "escape" });
        expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([["escape"]]);
        expect(yield* manager.pressKey(undefined, "enter")).toBeDefined();
        expect(backend.callsFor("pressKey").map((call) => call.args)).toEqual([
          ["escape"],
          ["enter"],
        ]);
      }),
    ),
  );
});

it.layer(NodeServices.layer)("computer WebSocket access policy", (it) => {
  const threadId = ThreadId.make("thread-1");
  const denied = new EnvironmentAuthorizationError({
    message: "denied",
    requiredScope: "computer:operate",
  });

  it.effect("refuses every way in when the policy refuses the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { backend, handlers } = yield* setup({ admitComputerUse: Effect.fail(denied) });
        const attempts: ReadonlyArray<Effect.Effect<unknown, WsComputerError>> = [
          handlers[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: true }),
          handlers[COMPUTER_WS_METHODS.provision]({}),
          handlers[COMPUTER_WS_METHODS.launchApp]({ app: "Calculator" }),
          handlers[COMPUTER_WS_METHODS.inputClick]({ x: 400, y: 250 }),
          handlers[COMPUTER_WS_METHODS.inputKey]({ key: "enter" }),
          handlers[COMPUTER_WS_METHODS.typeText]({ text: "hi" }),
        ];
        for (const attempt of attempts) {
          expect(yield* Effect.flip(Effect.asVoid(attempt))).toBe(denied);
        }
        expect(backend.callsFor("click")).toHaveLength(0);
        expect(backend.callsFor("pressKey")).toHaveLength(0);
        expect(backend.callsFor("typeText")).toHaveLength(0);
        expect(backend.callsFor("launchApp")).toHaveLength(0);
      }),
    ),
  );

  it.effect("still lets a refused session watch and press Stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { handlers } = yield* setup({ admitComputerUse: Effect.fail(denied) });
        yield* handlers[COMPUTER_WS_METHODS.getStatus]({});
        yield* handlers[COMPUTER_WS_METHODS.getThreadState]({ threadId });
        yield* handlers[COMPUTER_WS_METHODS.listWindows]({});
        yield* handlers[COMPUTER_WS_METHODS.getScreenSize]({});
        yield* handlers[COMPUTER_WS_METHODS.getAuditHistory]({ limit: 10 });
        expect(
          yield* handlers[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: false }),
        ).toMatchObject({ enabled: false });
      }),
    ),
  );

  it.effect("withdraws the thread's approval cards before Stop disables control", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cancelled: string[] = [];
        const { handlers } = yield* setup({
          approvalGate: {
            cancelThread: (id) => Effect.sync(() => void cancelled.push(id)),
          },
        });
        yield* handlers[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: true });
        expect(cancelled).toEqual([]);
        yield* handlers[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: false });
        expect(cancelled).toEqual([threadId]);
      }),
    ),
  );
});

describe("computer WebSocket handlers without a backend", () => {
  it.effect("reports the boot verdict instead of failing a watcher", () =>
    Effect.gen(function* () {
      const handlers = makeWsComputerHandlers(undefined);
      const threadId = ThreadId.make("thread-1");
      expect(yield* handlers[COMPUTER_WS_METHODS.getStatus]({})).toMatchObject({
        computerId: "desktop",
        availability: { kind: "backend-unavailable" },
      });
      expect(yield* handlers[COMPUTER_WS_METHODS.getThreadState]({ threadId })).toMatchObject({
        threadId,
        agentActive: false,
        lastError: null,
      });
      expect(
        yield* Effect.flip(
          handlers[COMPUTER_WS_METHODS.setControlEnabled]({ threadId, enabled: true }),
        ),
      ).toBeInstanceOf(ComputerError);
    }),
  );
});
