import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ComputerSpaceInventory, ComputerWindow } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import type { ComputerOperationError } from "./computerErrors.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { withComputerTask } from "./computerTaskContext.ts";

const window: ComputerWindow = {
  id: "cua:10:20",
  title: "Fixture",
  appName: "Fixture",
  pid: 10,
  focused: false,
  visible: false,
  minimized: false,
  bounds: { x: 20, y: 20, width: 300, height: 200 },
  spaceIds: [2],
  currentSpaceId: 1,
  onCurrentSpace: false,
};
const inventory: ComputerSpaceInventory = {
  source: "macos-managed-spaces",
  complete: true,
  spaces: [1, 2].map((id) => ({
    id,
    uuid: `uuid-${id}`,
    displayId: "display-a",
    kind: "desktop",
    current: id === 1,
  })),
};

const setup = Effect.fn(function* () {
  const spaces = { current: inventory };
  const backend = Object.assign(
    new FakeComputerBackend({ windows: [window], agentDialect: "macos", browser: true }),
    { listSpaces: () => Effect.sync(() => spaces.current) },
  );
  const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
  yield* manager.spaceBroker.reserve({ threadId: "a", turnId: null }, 2, [2], window.id);
  return { manager, backend, spaces };
});

const refusedActions: ReadonlyArray<
  readonly [string, (m: ComputerManager) => Effect.Effect<unknown, ComputerOperationError>]
> = [
  ["activate", (m) => m.activateWindow("a", window.id, { userRequestedVisibleUse: true })],
  [
    "foreground",
    (m) => m.foregroundWithRestore("a", window.id, undefined, { userRequestedVisibleUse: true }),
  ],
  ["launch", (m) => m.launchApp("a", "Fixture")],
  [
    "app menu",
    (m) => m.invokeMenu("a", { pid: 10 }, ["File", "New"], { userRequestedVisibleUse: true }),
  ],
  [
    "window menu",
    (m) =>
      m.invokeMenu("a", { windowId: window.id }, ["File", "New"], {
        userRequestedVisibleUse: true,
      }),
  ],
  ["visibility", (m) => m.setAppVisibility("a", 10, false)],
  ["minimize", (m) => m.setWindowMinimized("a", window.id, true)],
  ["move", (m) => m.setWindowFrame("a", window.id, { x: 0, y: 0, width: 300, height: 200 })],
  ["kill", (m) => m.killApp("a", window.id)],
];

it.layer(NodeServices.layer)("ComputerManager reserved Space boundaries", (it) => {
  it.effect("guards exact target keys and refuses them after the user enters the Space", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, backend, spaces } = yield* setup();
        yield* manager.pressKey("a", "Tab", window.id);
        expect(backend.callsFor("pressKey")).toHaveLength(1);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        spaces.current = {
          ...inventory,
          spaces: inventory.spaces.map((s) => ({ ...s, current: s.id === 2 })),
        };
        expect(yield* Effect.flip(manager.pressKey("a", "Tab", window.id))).toMatchObject({
          code: "computer_space_current",
        });
        expect(backend.callsFor("pressKey")).toHaveLength(1);
      }),
    ),
  );

  for (const [name, action] of refusedActions) {
    it.effect(`refuses ${name} before native dispatch, even with visible-use consent`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { manager, backend } = yield* setup();
          expect(yield* Effect.flip(Effect.asVoid(action(manager)))).toMatchObject({
            code: "computer_space_operation_unsupported",
          });
          for (const method of [
            "raiseWindow",
            "launchApp",
            "invokeMenu",
            "setAppVisibility",
            "setWindowMinimized",
            "setWindowFrame",
            "killApp",
          ])
            expect(backend.callsFor(method)).toHaveLength(0);
        }),
      ),
    );
  }

  it.effect("rejects unbound keys and coordinates before input", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, backend } = yield* setup();
        expect(yield* Effect.flip(manager.pressKey("a", "Tab"))).toMatchObject({
          code: "computer_space_window_not_selected",
        });
        expect(yield* Effect.flip(manager.click("a", { x: 5, y: 5 }))).toMatchObject({
          code: "computer_space_window_not_selected",
        });
        expect(backend.callsFor("pressKey")).toHaveLength(0);
        expect(backend.callsFor("click")).toHaveLength(0);
      }),
    ),
  );

  it.effect("generic foreground excursions refuse before the action or restore can run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, backend } = yield* setup();
        let actionCalls = 0;
        const action = Effect.sync(() => {
          actionCalls += 1;
          return "changed";
        });
        expect(
          yield* Effect.flip(
            manager.withForegroundRestore("a", action, { userRequestedVisibleUse: true }),
          ),
        ).toMatchObject({ code: "computer_space_operation_unsupported" });
        expect(actionCalls).toBe(0);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      }),
    ),
  );

  it.effect(
    "visible browser launch refuses while isolated headless preparation remains separate",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { manager, backend } = yield* setup();
          expect(
            yield* Effect.flip(
              manager.browserCall(
                "a",
                undefined,
                "browser_prepare",
                { allow_launch: true, windowed: true },
                undefined,
                Effect.void,
              ),
            ),
          ).toMatchObject({ code: "computer_space_operation_unsupported" });
          expect(backend.callsFor("browser.call")).toHaveLength(0);
          expect(
            yield* manager.browserCall("a", undefined, "browser_prepare", {
              allow_launch: true,
              windowed: false,
            }),
          ).toBeDefined();
        }),
      ),
  );

  it.effect("matching turn release, removal and disposal clear only task bookkeeping", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { manager, backend } = yield* setup();
        manager.spaceBroker.release("a");
        const owner = { threadId: "a", turnId: "turn-a" };
        yield* withComputerTask(
          { threadId: "a", turnId: "turn-a" },
          manager.spaceBroker.reserve(owner, 2, [2]),
        );
        yield* manager.releaseDesktopControl("a", "old-turn");
        expect(manager.spaceBroker.reservationFor(owner)).not.toBeNull();
        yield* manager.releaseDesktopControl("a", "turn-a");
        expect(manager.spaceBroker.reservationFor(owner)).toBeNull();
        yield* manager.spaceBroker.reserve(owner, 2, [2]);
        yield* manager.handleThreadRemoved("a");
        expect(manager.spaceBroker.reservationFor(owner)).toBeNull();
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
      }),
    ),
  );
});
