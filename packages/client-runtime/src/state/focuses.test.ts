import {
  FocusId,
  FocusProjectKey,
  type Focus,
  type FocusAssignment,
} from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_FOCUS_ID,
  focusIsVisible,
  groupSearchResultsByFocus,
  resolveActiveFocusId,
  scopedProjectKeysForFocus,
  visibleFocuses,
} from "./focuses.ts";

const WORK = FocusId.make("focus-work");
const PERSONAL = FocusId.make("focus-personal");
const WORK_PROJECT = FocusProjectKey.make("environment-a:project-work");
const PERSONAL_PROJECT = FocusProjectKey.make("environment-b:project-personal");

const focus = (id: FocusId, orderKey: string): Focus => ({
  id,
  name: id,
  iconName: "Briefcase",
  accentColor: "#3366ff",
  orderKey,
  createdAt: 1,
  updatedAt: 1,
});

const assignment = (focusId: FocusId, projectKey: FocusProjectKey): FocusAssignment => ({
  focusId,
  projectKey,
  createdAt: 1,
  updatedAt: 1,
});

describe("Focus project scoping", () => {
  it("uses null for All and a project-key set for a user Focus", () => {
    const assignments = [assignment(WORK, WORK_PROJECT), assignment(PERSONAL, PERSONAL_PROJECT)];

    expect(scopedProjectKeysForFocus(assignments, ALL_FOCUS_ID)).toBeNull();
    expect([...scopedProjectKeysForFocus(assignments, WORK)!]).toEqual([WORK_PROJECT]);
  });

  it("falls back to All when the Focus is missing or has no company-visible project", () => {
    const assignments = [assignment(WORK, WORK_PROJECT)];
    expect(
      resolveActiveFocusId({
        preferredId: WORK,
        focuses: [focus(WORK, "a")],
        assignments,
        visibleProjectKeys: new Set([WORK_PROJECT]),
      }),
    ).toBe(WORK);
    expect(
      resolveActiveFocusId({
        preferredId: WORK,
        focuses: [focus(WORK, "a")],
        assignments,
        visibleProjectKeys: new Set([PERSONAL_PROJECT]),
      }),
    ).toBe(ALL_FOCUS_ID);
    expect(
      resolveActiveFocusId({
        preferredId: WORK,
        focuses: [],
        assignments,
        visibleProjectKeys: new Set([WORK_PROJECT]),
      }),
    ).toBe(ALL_FOCUS_ID);
  });

  it("keeps an empty Focus selectable — only assigned-but-hidden Focuses fall back", () => {
    expect(
      resolveActiveFocusId({
        preferredId: WORK,
        focuses: [focus(WORK, "a")],
        assignments: [],
        visibleProjectKeys: new Set(),
      }),
    ).toBe(WORK);
  });
});

describe("Focus visibility", () => {
  it("shows an empty Focus and one with a company-visible assignment; hides assigned-but-invisible", () => {
    const assignments = [assignment(WORK, WORK_PROJECT)];
    const visibleProjectKeys: ReadonlySet<string> = new Set([PERSONAL_PROJECT]);

    expect(focusIsVisible({ focusId: PERSONAL, assignments, visibleProjectKeys })).toBe(true);
    expect(focusIsVisible({ focusId: WORK, assignments, visibleProjectKeys })).toBe(false);
    expect(
      focusIsVisible({ focusId: WORK, assignments, visibleProjectKeys: new Set([WORK_PROJECT]) }),
    ).toBe(true);
  });

  it("sorts and filters the strip's Focus list by the same rule", () => {
    const focuses = [focus(PERSONAL, "b"), focus(WORK, "a")];
    const assignments = [assignment(WORK, WORK_PROJECT), assignment(PERSONAL, PERSONAL_PROJECT)];

    expect(
      visibleFocuses({
        focuses,
        assignments,
        visibleProjectKeys: new Set([WORK_PROJECT]),
      }).map((entry) => entry.id),
    ).toEqual([WORK]);
    expect(
      visibleFocuses({ focuses, assignments: [], visibleProjectKeys: new Set() }).map(
        (entry) => entry.id,
      ),
    ).toEqual([WORK, PERSONAL]);
  });
});

describe("Focus search grouping", () => {
  it("puts the active Focus first, preserves result order, and leaves unassigned under All", () => {
    const focuses = [focus(WORK, "a"), focus(PERSONAL, "b")];
    const assignments = [assignment(WORK, WORK_PROJECT), assignment(PERSONAL, PERSONAL_PROJECT)];
    const results = [
      { id: "personal-1", projectKey: PERSONAL_PROJECT },
      { id: "unassigned", projectKey: "environment-c:project-other" },
      { id: "work-1", projectKey: WORK_PROJECT },
      { id: "personal-2", projectKey: PERSONAL_PROJECT },
    ];

    const groups = groupSearchResultsByFocus({
      results,
      focuses,
      assignments,
      activeFocusId: PERSONAL,
      projectKey: (result) => result.projectKey,
    });

    expect(groups.map((group) => group.focusId)).toEqual([PERSONAL, WORK, ALL_FOCUS_ID]);
    expect(groups.map((group) => group.results.map((result) => result.id))).toEqual([
      ["personal-1", "personal-2"],
      ["work-1"],
      ["unassigned"],
    ]);
  });
});
