import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { ComputerUiNode, ComputerWindow } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";

function semanticTextRoot(windowIds: readonly string[]): ComputerUiNode {
  return {
    role: "desktop",
    label: null,
    value: null,
    description: "Semantic text test desktop",
    frame: { x: 0, y: 0, width: 1_920, height: 1_080 },
    activationPoint: null,
    onScreen: true,
    windowId: null,
    children: windowIds.map((windowId, index) => ({
      role: "AXWindow",
      label: `Window ${index + 1}`,
      value: null,
      description: null,
      frame: { x: index * 400, y: 0, width: 360, height: 300 },
      activationPoint: null,
      onScreen: true,
      windowId,
      children: [
        {
          role: "AXTextArea",
          label: null,
          value: "",
          description: null,
          frame: { x: index * 400 + 20, y: 40, width: 320, height: 220 },
          activationPoint: { x: index * 400 + 180, y: 150 },
          onScreen: true,
          windowId,
          children: [],
        },
      ],
    })),
  };
}

function backgroundTargetBackend() {
  const ids = ["editor-a", "editor-b", "editor-a-other"];
  const windows = ids.map(
    (id, index): ComputerWindow => ({
      id,
      title: id,
      appName: index === 1 ? "Editor B" : "Editor A",
      pid: index === 1 ? 220 : 110,
      bounds: { x: index * 400, y: 0, width: 360, height: 300 },
      focused: false,
      minimized: false,
      visible: true,
    }),
  );
  return Object.assign(
    new FakeComputerBackend({
      windows,
      root: semanticTextRoot(ids),
      apps: [
        { pid: 110, name: "Editor A", bundleId: "app.editor.a", running: true, active: false },
        { pid: 220, name: "Editor B", bundleId: "app.editor.b", running: true, active: false },
      ],
    }),
    {
      exactTargetBackgroundInput: true,
      focusNeutralSemanticText: true,
      agentDialect: "macos" as const,
    },
  );
}

it.layer(NodeServices.layer)("ComputerManager smoke", (it) => {
  it.effect("lets separate apps progress while protecting one app's keyboard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        yield* manager.click("a", { windowId: "editor-a", x: 20, y: 50 });
        yield* manager.click("b", { windowId: "editor-b", x: 420, y: 50 });
        yield* manager.pressKey("a", "enter", "editor-a");
        yield* manager.pressKey("b", "enter", "editor-b");
        expect(backend.callsFor("pressKey")).toHaveLength(2);
        expect(backend.callsFor("raiseWindow")).toHaveLength(0);
        const refused = yield* Effect.flip(manager.pressKey("b", "enter", "editor-a-other"));
        expect(refused).toHaveProperty("code", "computer_controlled_by_other_thread");
        expect((yield* manager.getThreadState("b")).controlledByOtherThread).toBe(false);
        expect((yield* manager.getThreadState("b")).sharedPreviewUnavailable).toBe(true);
        yield* manager.releaseDesktopControl("a");
        expect((yield* manager.getThreadState("b")).sharedPreviewUnavailable).toBeUndefined();
        yield* manager.pressKey("b", "enter", "editor-a-other");
      }),
    ),
  );

  it.effect("types through keyboard focus when the text field cannot be singled out", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const backend = backgroundTargetBackend();
        Object.assign(backend, { currentRoot: semanticTextRoot(["editor-a", "editor-a"]) });
        const manager = yield* ComputerManager.make({ backend, actionSettleMs: 0 });
        expect(yield* manager.typeText("a", "hello world", "editor-a")).toMatchObject({
          action: "computer_type_text",
          windowId: "editor-a",
        });
        const call = backend.callsFor("typeText").at(-1);
        expect(call?.args[0]).toBe("hello world");
        expect(call?.args[2]).toBeUndefined();
        const typeCalls = backend.callsFor("typeText").length;
        expect(yield* Effect.flip(manager.typeText("a", "x", "gone"))).toMatchObject({
          code: "computer_target_not_found",
        });
        expect(backend.callsFor("typeText")).toHaveLength(typeCalls);
      }),
    ),
  );
});
