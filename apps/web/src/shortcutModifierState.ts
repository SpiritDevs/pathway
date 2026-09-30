import { useSyncExternalStore } from "react";

export interface ShortcutModifierState {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const EMPTY_SHORTCUT_MODIFIER_STATE: ShortcutModifierState = {
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
};

export function areShortcutModifierStatesEqual(
  left: ShortcutModifierState,
  right: ShortcutModifierState,
): boolean {
  return (
    left.metaKey === right.metaKey &&
    left.ctrlKey === right.ctrlKey &&
    left.altKey === right.altKey &&
    left.shiftKey === right.shiftKey
  );
}

type ModifierEventTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

const CAPTURE = { capture: true } as const;

/**
 * Held-modifier state shared by every subscriber. Listeners attach to the
 * target on first subscribe and detach (resetting to empty) on last
 * unsubscribe; subscribers are notified only when a modifier actually flips.
 */
export function createShortcutModifierStore(target: ModifierEventTarget) {
  let state = EMPTY_SHORTCUT_MODIFIER_STATE;
  const listeners = new Set<() => void>();
  const setState = (next: ShortcutModifierState) => {
    if (areShortcutModifierStatesEqual(state, next)) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const onKeyboardEvent = (event: Event) => {
    setState(shortcutModifierStateAfterKeyboardEvent(state, event as KeyboardEvent));
  };
  // Dictation tools (Wispr Flow) paste with a synthetic ⌘V whose Meta keyup
  // never reaches the page, so the tracked state stays "⌘ held" forever and
  // the thread jump hints stick on screen. A paste is never jump intent, so
  // treat it like a blur and reset. A physically held modifier re-registers
  // on the next real key event.
  const onResetEvent = () => setState(EMPTY_SHORTCUT_MODIFIER_STATE);

  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      if (listeners.size === 0) {
        target.addEventListener("keydown", onKeyboardEvent, CAPTURE);
        target.addEventListener("keyup", onKeyboardEvent, CAPTURE);
        target.addEventListener("paste", onResetEvent, CAPTURE);
        target.addEventListener("blur", onResetEvent);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        target.removeEventListener("keydown", onKeyboardEvent, CAPTURE);
        target.removeEventListener("keyup", onKeyboardEvent, CAPTURE);
        target.removeEventListener("paste", onResetEvent, CAPTURE);
        target.removeEventListener("blur", onResetEvent);
        state = EMPTY_SHORTCUT_MODIFIER_STATE;
      };
    },
  };
}

const windowShortcutModifierStore = createShortcutModifierStore(
  typeof window === "undefined" ? new EventTarget() : window,
);

/** Runs `listener` whenever a held modifier flips, without rendering anything. */
export function subscribeShortcutModifierState(
  listener: (state: ShortcutModifierState) => void,
): () => void {
  return windowShortcutModifierStore.subscribe(() =>
    listener(windowShortcutModifierStore.getState()),
  );
}

/**
 * Reads a value derived from the held modifiers. The caller re-renders only
 * when the selected value changes, so Shift+letter while typing never repaints
 * a component that only cares about ⌘/Ctrl. `select` must return a primitive
 * or otherwise stable value.
 */
export function useShortcutModifierState<T>(select: (state: ShortcutModifierState) => T): T {
  return useSyncExternalStore(
    windowShortcutModifierStore.subscribe,
    () => select(windowShortcutModifierStore.getState()),
    () => select(EMPTY_SHORTCUT_MODIFIER_STATE),
  );
}

function normalizeModifierKey(key: string): keyof ShortcutModifierState | null {
  switch (key) {
    case "Meta":
    case "OS":
    case "Command":
      return "metaKey";
    case "Control":
      return "ctrlKey";
    case "Alt":
    case "Option":
      return "altKey";
    case "Shift":
      return "shiftKey";
    default:
      return null;
  }
}

export function shortcutModifierStateAfterKeyboardEvent(
  currentState: ShortcutModifierState,
  event: KeyboardEvent,
): ShortcutModifierState {
  const normalizedModifierKey = normalizeModifierKey(event.key);
  let nextState: ShortcutModifierState;
  if (normalizedModifierKey) {
    nextState = {
      ...currentState,
      [normalizedModifierKey]: event.type === "keydown",
    };
  } else {
    // Flags on non-modifier keys may only clear a bit, never set one. After a
    // dictation tool's synthetic ⌘V (Wispr Flow), the browser can keep
    // reporting metaKey=true on real key events (Enter to submit) until the
    // user physically taps ⌘. Trusting that flag would mark ⌘ as held and
    // stick the thread jump hints. Setting a bit requires a real modifier
    // keydown, handled above.
    nextState = {
      metaKey: currentState.metaKey && event.metaKey,
      ctrlKey: currentState.ctrlKey && event.ctrlKey,
      altKey: currentState.altKey && event.altKey,
      shiftKey: currentState.shiftKey && event.shiftKey,
    };
  }

  return areShortcutModifierStatesEqual(currentState, nextState) ? currentState : nextState;
}
