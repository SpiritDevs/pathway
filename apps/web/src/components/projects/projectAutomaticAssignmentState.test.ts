import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectAutomaticAssignmentPending,
  markProjectAutomaticAssignmentPending,
  pendingProjectAutomaticAssignmentKeys,
  subscribeToProjectAutomaticAssignments,
} from "./projectAutomaticAssignmentState";

const PROJECT_KEY = "environment-1:project-1";

afterEach(() => {
  clearProjectAutomaticAssignmentPending(PROJECT_KEY);
  vi.useRealTimers();
});

describe("automatic project assignment state", () => {
  it("suppresses a checkout only while automatic assignment is pending", () => {
    markProjectAutomaticAssignmentPending(PROJECT_KEY);
    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(true);

    clearProjectAutomaticAssignmentPending(PROJECT_KEY);
    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(false);
  });

  it("notifies the ownership gate when suppression starts and ends", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProjectAutomaticAssignments(listener);

    markProjectAutomaticAssignmentPending(PROJECT_KEY);
    clearProjectAutomaticAssignmentPending(PROJECT_KEY);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("releases the ownership dialog when automatic assignment hangs", () => {
    vi.useFakeTimers();
    markProjectAutomaticAssignmentPending(PROJECT_KEY);

    vi.advanceTimersByTime(30_000);

    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(false);
  });
});
