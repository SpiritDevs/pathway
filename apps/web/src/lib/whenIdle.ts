/**
 * Runs `task` once the main thread is idle, for boot work that should never
 * compete with first paint. Returns a cancel function, so it drops straight
 * into a `useEffect` cleanup. Safari has no `requestIdleCallback`; a short
 * timeout keeps it off the first frame there.
 */
export function whenIdle(task: () => void, timeoutMs = 2_000): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(() => task(), { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 250);
  return () => window.clearTimeout(handle);
}
