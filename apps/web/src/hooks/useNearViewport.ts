import { useCallback, useState } from "react";

const callbacks = new Map<Element, (near: boolean, height: number) => void>();
let observer: IntersectionObserver | null = null;

export function observeNearViewport(
  element: Element,
  onChange: (near: boolean, height: number) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true, 0);
    return () => undefined;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        callbacks.get(entry.target)?.(entry.isIntersecting, entry.boundingClientRect.height);
    },
    { rootMargin: "200px" },
  );
  callbacks.set(element, onChange);
  observer.observe(element);
  return () => {
    callbacks.delete(element);
    observer?.unobserve(element);
    if (callbacks.size === 0) {
      observer?.disconnect();
      observer = null;
    }
  };
}

/**
 * One observer serves all rows, including nested scroll containers. `height` is the element's
 * last observed height, so a row can hold its place with a same-sized placeholder.
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
