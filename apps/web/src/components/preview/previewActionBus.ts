"use client";

/**
 * Typed window-event bus for preview-panel actions. Lets the global
 * keybinding handler in `routes/_chat.tsx` reach `ChatView`'s URL-aware
 * arbitration without prop drilling or shared refs.
 */
export type PreviewAction =
  | "toggle-panel"
  | "toggle-browser-panel"
  | "refresh"
  | "focus-url"
  | "zoom-in"
  | "zoom-out"
  | "reset-zoom";

const EVENT_NAME = "pathway:preview-action";

export function dispatchPreviewAction(action: PreviewAction): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<PreviewAction>(EVENT_NAME, { detail: action }));
}

export function subscribePreviewAction(listener: (action: PreviewAction) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<PreviewAction>).detail;
    if (typeof detail === "string") listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

const NEW_TAB_ADDRESS_FOCUS_EVENT = "pathway:new-tab-address-focus";
let newTabAddressFocusPending = false;

/**
 * Asks the next blank browser tab to focus its address bar once, so a new tab
 * takes typing straight away. Showing an existing blank tab does not focus it.
 */
export function requestNewTabAddressFocus(): void {
  newTabAddressFocusPending = true;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(NEW_TAB_ADDRESS_FOCUS_EVENT));
}

/** Calls `focus` for a pending request now and for each later one. */
export function subscribeNewTabAddressFocus(focus: () => void): () => void {
  const take = () => {
    if (!newTabAddressFocusPending) return;
    newTabAddressFocusPending = false;
    focus();
  };
  take();
  if (typeof window === "undefined") return () => {};
  window.addEventListener(NEW_TAB_ADDRESS_FOCUS_EVENT, take);
  return () => window.removeEventListener(NEW_TAB_ADDRESS_FOCUS_EVENT, take);
}
