export interface DictationShortcutState {
  downAt: number | null;
  lastTapAt: number | null;
  locked: boolean;
}
export const emptyDictationShortcutState = (): DictationShortcutState => ({
  downAt: null,
  lastTapAt: null,
  locked: false,
});
export type DictationShortcutAction = "start-hold" | "start-locked" | "stop" | "cancel" | null;

/** Short first taps are discarded; a held recording has no double-tap release delay. */
export function advanceDictationShortcut(
  state: DictationShortcutState,
  edge: "down" | "up" | "cancel",
  now: number,
): { state: DictationShortcutState; action: DictationShortcutAction } {
  if (edge === "cancel") return { state: emptyDictationShortcutState(), action: "cancel" };
  if (edge === "down") {
    if (state.downAt !== null) return { state, action: null };
    if (state.locked)
      return { state: { ...emptyDictationShortcutState(), downAt: now }, action: "stop" };
    if (state.lastTapAt !== null && now - state.lastTapAt <= 350)
      return { state: { downAt: now, lastTapAt: null, locked: true }, action: "start-locked" };
    return { state: { downAt: now, lastTapAt: null, locked: false }, action: "start-hold" };
  }
  if (state.downAt === null) return { state, action: null };
  if (state.locked) return { state: { ...state, downAt: null }, action: null };
  const tapped = now - state.downAt < 250;
  return {
    state: { downAt: null, lastTapAt: tapped ? now : null, locked: false },
    action: tapped ? "cancel" : "stop",
  };
}
