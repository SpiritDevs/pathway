import { describe, expect, it } from "vite-plus/test";

import {
  summarizeProjectContributors,
  summarizeProjectIssues,
  summarizeProjectMilestones,
  type DashboardIssue,
  type DashboardStatus,
} from "./projectDashboard.logic";

const STATUSES: ReadonlyArray<DashboardStatus> = [
  { id: "backlog", category: "backlog" },
  { id: "todo", category: "unstarted" },
  { id: "doing", category: "started" },
  { id: "review", category: "review" },
  { id: "done", category: "completed" },
  { id: "dropped", category: "canceled" },
];

function issue(overrides: Partial<DashboardIssue> & Pick<DashboardIssue, "id">): DashboardIssue {
  return {
    projectId: "project-1",
    statusId: "todo",
    milestoneId: null,
    assignee: null,
    dueDate: null,
    triage: false,
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("project issue rollup", () => {
  it("splits issues into done, in progress, and not started", () => {
    const rollup = summarizeProjectIssues({
      issues: [
        issue({ id: "a", statusId: "backlog" }),
        issue({ id: "b", statusId: "todo" }),
        issue({ id: "c", statusId: "doing" }),
        issue({ id: "d", statusId: "review" }),
        issue({ id: "e", statusId: "done" }),
        issue({ id: "f", statusId: "dropped" }),
      ],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(rollup).toMatchObject({ total: 6, done: 2, inProgress: 2, notStarted: 2, overdue: 0 });
    expect(rollup.byCategory.get("review")).toBe(1);
  });

  it("leaves triage out of every count", () => {
    const rollup = summarizeProjectIssues({
      issues: [issue({ id: "a" }), issue({ id: "b", triage: true })],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(rollup.total).toBe(1);
  });

  it("counts an issue whose status no longer exists as not started rather than losing it", () => {
    const rollup = summarizeProjectIssues({
      issues: [
        issue({ id: "a", statusId: "deleted-elsewhere" }),
        issue({ id: "b", statusId: null }),
      ],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(rollup).toMatchObject({ total: 2, notStarted: 2 });
  });

  it("counts an overdue issue only while it is still open", () => {
    const rollup = summarizeProjectIssues({
      issues: [
        issue({ id: "late", dueDate: "2026-08-01" }),
        issue({ id: "late-but-done", statusId: "done", dueDate: "2026-08-01" }),
        issue({ id: "due-today", dueDate: "2026-08-19" }),
      ],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(rollup.overdue).toBe(1);
  });
});

describe("project milestone progress", () => {
  const milestones = [
    { id: "m1", name: "Beta", projectId: "project-1", targetDate: "2026-08-01" },
    { id: "m2", name: "GA", projectId: "project-1", targetDate: "2026-09-30" },
    { id: "m3", name: "Someday", projectId: "project-1", targetDate: null },
  ];

  it("calls a milestone behind only when its date has passed with work still open", () => {
    const progress = summarizeProjectMilestones({
      milestones,
      issues: [
        issue({ id: "a", milestoneId: "m1", statusId: "todo" }),
        issue({ id: "b", milestoneId: "m2", statusId: "todo" }),
      ],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(progress.map((entry) => [entry.id, entry.behind])).toEqual([
      ["m1", true],
      ["m2", false],
      ["m3", false],
    ]);
  });

  it("does not call a finished milestone behind, however late it was", () => {
    const progress = summarizeProjectMilestones({
      milestones: [milestones[0]!],
      issues: [issue({ id: "a", milestoneId: "m1", statusId: "done" })],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(progress[0]).toMatchObject({ behind: false, done: 1, total: 1 });
  });

  it("reports days remaining, negative once the date has passed", () => {
    const progress = summarizeProjectMilestones({
      milestones,
      issues: [],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(progress[0]?.daysRemaining).toBe(-18);
    expect(progress[1]?.daysRemaining).toBe(42);
    expect(progress[2]?.daysRemaining).toBeNull();
  });

  it("orders by deadline and puts undated milestones last", () => {
    const progress = summarizeProjectMilestones({
      milestones,
      issues: [],
      statuses: STATUSES,
      today: "2026-08-19",
    });
    expect(progress.map((entry) => entry.id)).toEqual(["m1", "m2", "m3"]);
  });
});

describe("project contributors", () => {
  it("ranks by open work and keeps unassigned visible", () => {
    const loads = summarizeProjectContributors({
      issues: [
        issue({ id: "a", assignee: { kind: "member", id: "u1", label: "Ada" } }),
        issue({ id: "b", assignee: { kind: "member", id: "u1", label: "Ada" } }),
        issue({ id: "c", assignee: { kind: "member", id: "u2", label: "Grace" } }),
        issue({ id: "d" }),
        issue({ id: "e", assignee: { kind: "member", id: "u1", label: "Ada" }, statusId: "done" }),
      ],
      statuses: STATUSES,
    });
    expect(loads).toEqual([
      { key: "member:u1", label: "Ada", open: 2, done: 1 },
      { key: "member:u2", label: "Grace", open: 1, done: 0 },
      { key: "unassigned", label: "Unassigned", open: 1, done: 0 },
    ]);
  });
});
