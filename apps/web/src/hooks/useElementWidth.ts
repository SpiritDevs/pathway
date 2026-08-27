import { useLayoutEffect, useState } from "react";

export function useElementWidth<T extends HTMLElement>(closestSelector?: string) {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    if (!element) return;

    const observedElement = closestSelector
      ? element.closest<HTMLElement>(closestSelector)
      : element;
    if (!observedElement) return;

    const update = (nextWidth: number) => {
      setWidth((currentWidth) => (currentWidth === nextWidth ? currentWidth : nextWidth));
    };

    update(observedElement.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(observedElement);
    return () => observer.disconnect();
  }, [closestSelector, element]);

  return [setElement, width] as const;
}
