import { describe, expect, it } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  createShortcutModifierStore,
  shortcutModifierStateAfterKeyboardEvent,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("compares modifier states by value", () => {
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      ),
    ).toBe(true);
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true },
      ),
    ).toBe(false);
  });

  it("preserves the current object when modifier values do not change", () => {
    const initialState = emptyState();
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike("keyup", { key: "Shift" }),
    );
    expect(nextState).toBe(initialState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // A dictation paste (synthetic ⌘V) can leave the browser reporting
    // metaKey=true on later real key events. Enter to submit must not
    // re-mark ⌘ as held.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});

function dispatchKey(target: EventTarget, type: "keydown" | "keyup", init: Partial<KeyboardEvent>) {
  target.dispatchEvent(
    Object.assign(new Event(type), {
      key: "",
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init,
    }),
  );
}

// Types text the way a keyboard does: Shift is pressed and released around
// every uppercase letter.
function typeText(target: EventTarget, text: string) {
  for (const char of text) {
    const shifted = char !== char.toLowerCase();
    if (shifted) dispatchKey(target, "keydown", { key: "Shift", shiftKey: true });
    dispatchKey(target, "keydown", { key: char, shiftKey: shifted });
    dispatchKey(target, "keyup", { key: char, shiftKey: shifted });
    if (shifted) dispatchKey(target, "keyup", { key: "Shift", shiftKey: false });
  }
}

describe("createShortcutModifierStore", () => {
  it("never changes a ⌘/Ctrl selection while typing text", () => {
    const target = new EventTarget();
    const store = createShortcutModifierStore(target);
    const selectHeld = () => store.getState().ctrlKey || store.getState().metaKey;
    let notifications = 0;
    let selectionChanges = 0;
    let selected = selectHeld();
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
      const next = selectHeld();
      if (next !== selected) selectionChanges += 1;
      selected = next;
    });

    typeText(target, "Hello World, Pathway");

    // Every Shift press and release flips the raw state. Subscribing to the
    // whole state (the old hook) re-rendered the sidebar on each of these.
    expect(notifications).toBe(6);
    // A selector subscriber re-renders only when its value changes.
    expect(selectionChanges).toBe(0);
    unsubscribe();
  });

  it("reports ⌘ presses to selectors that care about them", () => {
    const target = new EventTarget();
    const store = createShortcutModifierStore(target);
    const seen: boolean[] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.getState().metaKey));

    dispatchKey(target, "keydown", { key: "Meta", metaKey: true });
    dispatchKey(target, "keydown", { key: "v", metaKey: true });
    dispatchKey(target, "keyup", { key: "Meta", metaKey: false });

    expect(seen).toEqual([true, false]);
    unsubscribe();
  });

  it("detaches from the target and resets once the last subscriber leaves", () => {
    const target = new EventTarget();
    const store = createShortcutModifierStore(target);
    const first = store.subscribe(() => {});
    const second = store.subscribe(() => {});

    dispatchKey(target, "keydown", { key: "Control", ctrlKey: true });
    first();
    expect(store.getState().ctrlKey).toBe(true);
    second();
    expect(store.getState()).toEqual(emptyState());

    dispatchKey(target, "keydown", { key: "Control", ctrlKey: true });
    expect(store.getState()).toEqual(emptyState());
  });

  it("resets held modifiers on paste", () => {
    const target = new EventTarget();
    const store = createShortcutModifierStore(target);
    const unsubscribe = store.subscribe(() => {});

    dispatchKey(target, "keydown", { key: "Meta", metaKey: true });
    target.dispatchEvent(new Event("paste"));

    expect(store.getState()).toEqual(emptyState());
    unsubscribe();
  });
});
