import { CompanyId } from "@spiritdevs/contracts/company";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearProjectAutomaticAssignmentPending,
  projectAutomaticAssignmentTarget,
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
  it("keeps explicit creation ownership after pending work settles or times out", () => {
    vi.useFakeTimers();
    const target = {
      companyId: CompanyId.make("company-choice"),
      cloudProjectId: "existing-project",
    };
    markProjectAutomaticAssignmentPending(PROJECT_KEY, target);
    vi.advanceTimersByTime(30_000);
    expect(projectAutomaticAssignmentTarget(PROJECT_KEY)).toEqual(target);
    clearProjectAutomaticAssignmentPending(PROJECT_KEY);
    expect(projectAutomaticAssignmentTarget(PROJECT_KEY)).toEqual(target);
  });
  it("suppresses a checkout only while automatic assignment is pending", () => {
    markProjectAutomaticAssignmentPending(PROJECT_KEY);
    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(true);

    clearProjectAutomaticAssignmentPending(PROJECT_KEY);
    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(false);
  });

  it("notifies background assignment when suppression starts and ends", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProjectAutomaticAssignments(listener);

    markProjectAutomaticAssignmentPending(PROJECT_KEY);
    clearProjectAutomaticAssignmentPending(PROJECT_KEY);

    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("releases background assignment when automatic assignment hangs", () => {
    vi.useFakeTimers();
    markProjectAutomaticAssignmentPending(PROJECT_KEY);

    vi.advanceTimersByTime(30_000);

    expect(pendingProjectAutomaticAssignmentKeys().has(PROJECT_KEY)).toBe(false);
  });
});
