import { useCallback, useState } from "react";

const callbacks = new Map<Element, (near: boolean) => void>();
let observer: IntersectionObserver | null = null;

export function observeNearViewport(
  element: Element,
  onChange: (near: boolean) => void,
): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onChange(true);
    return () => undefined;
  }
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) callbacks.get(entry.target)?.(entry.isIntersecting);
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

/** One observer serves all rows, including nested scroll containers. */
export function useNearViewport() {
  const [near, setNear] = useState(false);
  const ref = useCallback((element: HTMLElement | null) => {
    if (element === null) return;
    return observeNearViewport(element, setNear);
  }, []);
  return { ref, near };
}
