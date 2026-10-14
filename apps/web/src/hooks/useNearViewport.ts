import { useCallback, useState } from "react";

type NearViewportCallback = (near: boolean, height: number) => void;

// rootMargin only grows the root's own box. A clipping ancestor below the root still clips at its
// edge, so rows inside a nested scroll area must observe against that area, not the page.
const SCROLL_VIEWPORT_SELECTOR = '[data-slot="scroll-area-viewport"]';

const observers = new Map<
  Element | null,
  {
    readonly observer: IntersectionObserver;
    readonly callbacks: Map<Element, NearViewportCallback>;
  }
>();

export function observeNearViewport(element: Element, onChange: NearViewportCallback): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true, 0);
    return () => undefined;
  }
  const root = element.closest(SCROLL_VIEWPORT_SELECTOR);
  let shared = observers.get(root);
  if (!shared) {
    const callbacks = new Map<Element, NearViewportCallback>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          callbacks.get(entry.target)?.(entry.isIntersecting, entry.boundingClientRect.height);
      },
      { root, rootMargin: "200px" },
    );
    shared = { observer, callbacks };
    observers.set(root, shared);
  }
  const { observer, callbacks } = shared;
  callbacks.set(element, onChange);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer.unobserve(element);
    if (callbacks.size === 0) {
      observer.disconnect();
      observers.delete(root);
    }
  };
}

/**
 * One observer per scroll viewport serves all its rows; elements outside a scroll area observe
 * the page. `height` is the element's last observed height, so a row can hold its place with a
 * same-sized placeholder.
 */
export function useNearViewport() {
  const [state, setState] = useState({ near: false, height: 0 });
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    return observeNearViewport(element, (near, height) =>
      setState((previous) =>
        previous.near === near && (height === 0 || previous.height === height)
          ? previous
          : { near, height: height || previous.height },
      ),
    );
  }, []);
  return { ref, near: state.near, height: state.height };
}
