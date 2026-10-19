import { describe, expect, it } from "vite-plus/test";
import { advanceDictationShortcut, emptyDictationShortcutState } from "./shortcutState.ts";

describe("dictation shortcut gestures", () => {
  it("finishes a hold immediately on release", () => {
    const down = advanceDictationShortcut(emptyDictationShortcutState(), "down", 100);
    expect(down.action).toBe("start-hold");
    expect(advanceDictationShortcut(down.state, "up", 1100).action).toBe("stop");
  });
  it("discards the first short tap and locks exactly once on the second", () => {
    const down = advanceDictationShortcut(emptyDictationShortcutState(), "down", 100);
    const up = advanceDictationShortcut(down.state, "up", 150);
    expect(up.action).toBe("cancel");
    const second = advanceDictationShortcut(up.state, "down", 250);
    expect(second.action).toBe("start-locked");
    const release = advanceDictationShortcut(second.state, "up", 300);
    expect(release.action).toBeNull();
    expect(advanceDictationShortcut(release.state, "down", 1500).action).toBe("stop");
  });
  it("ignores repeated keydown and resets on cancellation", () => {
    const state = advanceDictationShortcut(emptyDictationShortcutState(), "down", 100).state;
    expect(advanceDictationShortcut(state, "down", 200).action).toBeNull();
    expect(advanceDictationShortcut(state, "cancel", 250).state).toEqual(
      emptyDictationShortcutState(),
    );
  });
});
