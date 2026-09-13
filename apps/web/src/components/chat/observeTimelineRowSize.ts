/** Keep the virtual row's measurement in sync with its rendered content. */
export function observeTimelineRowSize(element: HTMLElement, syncLayout: () => void) {
  let previousWidth: number | undefined;
  let previousHeight: number | undefined;
  let active = true;
  const observer = new ResizeObserver((entries) => {
    if (!active) return;
    const entry = entries.find((entry) => entry.target === element);
    if (!entry) return;
    const { width, height } = entry.contentRect;
    if (width === previousWidth && height === previousHeight) return;
    previousWidth = width;
    previousHeight = height;
    syncLayout();
  });
  observer.observe(element);
  return () => {
    active = false;
    observer.disconnect();
  };
}
