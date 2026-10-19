import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearWorkspaceProjectRemovalPending,
  markWorkspaceProjectRemovalPending,
  pendingWorkspaceProjectRemovalKeys,
  settleMissingWorkspaceProjectRemovals,
  subscribeToPendingWorkspaceProjectRemovals,
} from "./projectRemovalState";

const PROJECT_KEY = "path:test-project";

afterEach(() => {
  clearWorkspaceProjectRemovalPending(PROJECT_KEY);
  vi.useRealTimers();
});

describe("workspace project removal state", () => {
  it("suppresses a pending removal until the project disappears", () => {
    markWorkspaceProjectRemovalPending(PROJECT_KEY);
    expect(pendingWorkspaceProjectRemovalKeys().has(PROJECT_KEY)).toBe(true);

    settleMissingWorkspaceProjectRemovals(new Set([PROJECT_KEY]));
    expect(pendingWorkspaceProjectRemovalKeys().has(PROJECT_KEY)).toBe(true);

    settleMissingWorkspaceProjectRemovals(new Set());
    expect(pendingWorkspaceProjectRemovalKeys().has(PROJECT_KEY)).toBe(false);
  });

  it("notifies subscribers when removal starts and settles", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToPendingWorkspaceProjectRemovals(listener);

    markWorkspaceProjectRemovalPending(PROJECT_KEY);
    clearWorkspaceProjectRemovalPending(PROJECT_KEY);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("stops suppressing a project when reconciliation does not finish", () => {
    vi.useFakeTimers();
    markWorkspaceProjectRemovalPending(PROJECT_KEY);

    vi.advanceTimersByTime(30_000);

    expect(pendingWorkspaceProjectRemovalKeys().has(PROJECT_KEY)).toBe(false);
  });
});
