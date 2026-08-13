import { describe, expect, it } from "vite-plus/test";

import { alternateActiveTurnSendAction, resolveComposerDispatchMode } from "./composerDispatch";

describe("alternateActiveTurnSendAction", () => {
  it("returns the opposite action for the composer hint", () => {
    expect(alternateActiveTurnSendAction("queue")).toBe("steer");
    expect(alternateActiveTurnSendAction("steer")).toBe("queue");
  });
});

describe("resolveComposerDispatchMode", () => {
  it("starts an ordinary turn while idle", () => {
    expect(resolveComposerDispatchMode({ phase: "ready", alternateModifier: false })).toBe("auto");
  });

  it("steers by default and reserves Mod+Enter for the alternate action while running", () => {
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: false })).toBe(
      "steer",
    );
    expect(resolveComposerDispatchMode({ phase: "running", alternateModifier: true })).toBe(
      "queue",
    );
  });

  it("inverts queue and steer when the alternate modifier is pressed", () => {
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: false,
        activeTurnDefault: "queue",
      }),
    ).toBe("queue");
    expect(
      resolveComposerDispatchMode({
        phase: "running",
        alternateModifier: true,
        activeTurnDefault: "queue",
      }),
    ).toBe("steer");
  });
});
