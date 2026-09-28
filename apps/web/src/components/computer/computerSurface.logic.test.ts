import {
  ComputerId,
  ThreadId,
  type ComputerSurfaceController,
  type ComputerSurfaceSessionState,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computerControlView,
  computerHandBackThreadId,
  computerKeyInput,
  computerPointerButton,
  computerSurfacePoint,
} from "./computerSurface.logic";

const agentThread = ThreadId.make("thread-agent");
const openedFrom = ThreadId.make("thread-view");

function session(
  controller: ComputerSurfaceController,
  activeTurns: ComputerSurfaceSessionState["state"]["activeTurns"] = [],
): ComputerSurfaceSessionState {
  return {
    clientId: "me",
    state: {
      computerId: ComputerId.make("desktop"),
      revision: 1,
      controller,
      activeTurns,
      capabilities: { capture: true, input: true, pointerPhases: false },
    },
  };
}

const key = (
  key: string,
  modifiers: Partial<Record<"ctrl" | "alt" | "shift" | "meta", boolean>> = {},
) => ({
  key,
  ctrlKey: modifiers.ctrl ?? false,
  altKey: modifiers.alt ?? false,
  shiftKey: modifiers.shift ?? false,
  metaKey: modifiers.meta ?? false,
});

describe("computerControlView", () => {
  it("names who holds the screen from this connection's point of view", () => {
    expect(computerControlView(session({ kind: "agent", threadId: agentThread }))).toEqual({
      tone: "agent",
      label: "Agent is using the computer",
      mine: false,
    });
    expect(computerControlView(session({ kind: "client", clientId: "other" }))).toMatchObject({
      tone: "other",
      mine: false,
    });
    expect(computerControlView(session({ kind: "idle" }))).toMatchObject({
      label: "Agent idle",
      mine: false,
    });
  });

  it("says whether an agent is waiting behind this client's control", () => {
    const turn = [{ threadId: agentThread, runId: "run" }];
    expect(computerControlView(session({ kind: "client", clientId: "me" }, turn))).toMatchObject({
      label: "You have control",
      mine: true,
    });
    expect(computerControlView(session({ kind: "client", clientId: "me" }))).toMatchObject({
      label: "Agent idle — you have control",
      mine: true,
    });
  });
});

describe("computerHandBackThreadId", () => {
  it("prefers the paused agent's thread, then the view's thread", () => {
    expect(
      computerHandBackThreadId(
        session({ kind: "client", clientId: "me" }, [{ threadId: agentThread, runId: "run" }]),
        openedFrom,
      ),
    ).toBe(agentThread);
    expect(computerHandBackThreadId(session({ kind: "client", clientId: "me" }), openedFrom)).toBe(
      openedFrom,
    );
  });
});

describe("computerSurfacePoint", () => {
  // A 2880x1800 retina frame is 1440x900 points.
  const screen = { width: 1440, height: 900 };

  it("maps canvas pixels to display points", () => {
    expect(computerSurfacePoint({ x: 360, y: 225, boxWidth: 720, boxHeight: 450, screen })).toEqual(
      { x: 720, y: 450 },
    );
  });

  it("excludes the letterbox", () => {
    // 720x600 box: the image is 720x450, centred with 75px bars above and below.
    expect(computerSurfacePoint({ x: 0, y: 75, boxWidth: 720, boxHeight: 600, screen })).toEqual({
      x: 0,
      y: 0,
    });
    expect(
      computerSurfacePoint({ x: 100, y: 40, boxWidth: 720, boxHeight: 600, screen }),
    ).toBeNull();
  });
});

describe("computerKeyInput", () => {
  it("types printable text and sends everything else as a key", () => {
    expect(computerKeyInput(key("a"))).toEqual({ type: "type", text: "a" });
    expect(computerKeyInput(key("A", { shift: true }))).toEqual({ type: "type", text: "A" });
    expect(computerKeyInput(key("Enter"))).toEqual({ type: "key", key: "Enter" });
    expect(computerKeyInput(key("Escape"))).toEqual({ type: "key", key: "Escape" });
  });

  it("sends chords whole", () => {
    expect(computerKeyInput(key("c", { meta: true }))).toEqual({
      type: "key",
      key: "C",
      modifiers: ["meta"],
    });
    expect(computerKeyInput(key(" ", { ctrl: true }))).toEqual({
      type: "key",
      key: "Space",
      modifiers: ["ctrl"],
    });
    expect(computerKeyInput(key("ArrowUp", { shift: true }))).toEqual({
      type: "key",
      key: "ArrowUp",
      modifiers: ["shift"],
    });
  });

  it("ignores lone modifiers and composition", () => {
    expect(computerKeyInput(key("Shift", { shift: true }))).toBeNull();
    expect(computerKeyInput(key("Dead"))).toBeNull();
    expect(computerKeyInput({ ...key("a"), isComposing: true })).toBeNull();
  });
});

describe("computerPointerButton", () => {
  it("supports the buttons the host can click", () => {
    expect(computerPointerButton(0)).toBe("left");
    expect(computerPointerButton(2)).toBe("right");
    expect(computerPointerButton(1)).toBeNull();
  });
});
