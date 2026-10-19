import {
  FocusId,
  FocusProjectKey,
  type Focus,
  type FocusAssignment,
} from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_FOCUS_ID,
  focusIncludesConversations,
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
  it("shows conversations in All by default and in each Focus that opts in", () => {
    const focuses = [focus(WORK, "a"), { ...focus(PERSONAL, "b"), includeConversations: true }];
    expect(focusIncludesConversations(focuses, ALL_FOCUS_ID)).toBe(true);
    expect(focusIncludesConversations(focuses, WORK)).toBe(false);
    expect(focusIncludesConversations(focuses, PERSONAL)).toBe(true);
    expect(focusIncludesConversations([], PERSONAL)).toBe(false);
    expect(
      focusIncludesConversations([{ ...focus(WORK, "a"), includeConversations: true }], WORK),
    ).toBe(true);
  });

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
  it("keeps conversation Focuses visible and selected when their projects are in another company", () => {
    const focuses = [{ ...focus(WORK, "a"), includeConversations: true }];
    const assignments = [assignment(WORK, WORK_PROJECT)];
    const visibleProjectKeys = new Set([PERSONAL_PROJECT]);
    expect(visibleFocuses({ focuses, assignments, visibleProjectKeys })).toEqual(focuses);
    expect(
      resolveActiveFocusId({ preferredId: WORK, focuses, assignments, visibleProjectKeys }),
    ).toBe(WORK);
  });

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
  it.each([ALL_FOCUS_ID, WORK, PERSONAL])(
    "lists a conversation once with %s active despite membership in two Focuses",
    (activeFocusId) => {
      const focuses = [WORK, PERSONAL].map((id) => ({
        ...focus(id, id),
        includeConversations: true,
      }));
      const conversation = { id: "conversation", projectKey: null };
      const projectThread = { id: "attached", projectKey: WORK_PROJECT };
      const groups = groupSearchResultsByFocus({
        results: [conversation, projectThread],
        focuses,
        assignments: [assignment(WORK, WORK_PROJECT)],
        activeFocusId,
        projectKey: (result) => result.projectKey,
      });
      expect(groups.flatMap((group) => group.results)).toHaveLength(2);
      expect(groups.find((group) => group.results.includes(conversation))?.focusId).toBe(
        activeFocusId,
      );
      expect(groups.find((group) => group.results.includes(projectThread))?.focusId).toBe(WORK);
    },
  );

  it("keeps conversations under All when the active Focus does not include them", () => {
    const groups = groupSearchResultsByFocus({
      results: [{ projectKey: "scratch" }],
      focuses: [focus(WORK, "a"), { ...focus(PERSONAL, "b"), includeConversations: true }],
      assignments: [],
      activeFocusId: WORK,
      projectKey: (result) => result.projectKey,
      isConversation: () => true,
    });
    expect(groups.map((group) => group.focusId)).toEqual([ALL_FOCUS_ID]);
  });

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
