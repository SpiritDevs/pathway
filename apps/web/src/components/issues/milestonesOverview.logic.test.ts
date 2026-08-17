import {
  IssueMilestoneId,
  ProjectId,
  issueMilestoneStatusOn,
  type IssueDate,
  type IssueMilestone,
  type IssueStatusCategory,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MILESTONE_STATUS_LABELS,
  formatMilestoneDateRange,
  isMilestonesPathname,
  milestoneIdInPathname,
  milestoneIssueCount,
  milestoneProgressRatio,
  milestoneTally,
  milestonesOverviewGroups,
  milestonesOverviewView,
  parseMilestonesOverviewSearch,
} from "./milestonesOverview.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const TODAY = "2026-08-12" as IssueDate;

function milestone(id: string, projectId: string, overrides: Partial<IssueMilestone> = {}) {
  return {
    id: IssueMilestoneId.make(id),
    projectId: ProjectId.make(projectId),
    name: id,
    description: null,
    startDate: null,
    targetDate: null,
    position: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies IssueMilestone;
}

function project(id: string, title: string) {
  return { id: ProjectId.make(id), title };
}

function counts(entries: Partial<Record<IssueStatusCategory, number>>) {
  return new Map(Object.entries(entries) as ReadonlyArray<[IssueStatusCategory, number]>);
}

describe("parseMilestonesOverviewSearch", () => {
  it("keeps the two view modes and drops anything else", () => {
    expect(parseMilestonesOverviewSearch({ view: "timeline" }).view).toBe("timeline");
    expect(parseMilestonesOverviewSearch({ view: "list" }).view).toBe("list");
    expect(parseMilestonesOverviewSearch({ view: "gantt" }).view).toBeUndefined();
    expect(parseMilestonesOverviewSearch({ view: 3 }).view).toBeUndefined();
    expect(parseMilestonesOverviewSearch({}).view).toBeUndefined();
  });

  it("takes any non-blank project string, since the project may not have loaded yet", () => {
    expect(parseMilestonesOverviewSearch({ project: "prj_1" }).project).toBe("prj_1");
    expect(parseMilestonesOverviewSearch({ project: "  " }).project).toBeUndefined();
    expect(parseMilestonesOverviewSearch({ project: ["prj_1"] }).project).toBeUndefined();
  });

  it("reads an absent view as the list, which is what an unwritten default means", () => {
    expect(milestonesOverviewView(parseMilestonesOverviewSearch({}))).toBe("list");
    expect(milestonesOverviewView(parseMilestonesOverviewSearch({ view: "timeline" }))).toBe(
      "timeline",
    );
  });
});

describe("milestone paths", () => {
  it("claims the overview and every milestone under it, and nothing else in the tracker", () => {
    expect(isMilestonesPathname("/issues/milestones")).toBe(true);
    expect(isMilestonesPathname("/issues/milestones/msl_1")).toBe(true);
    expect(isMilestonesPathname("/issues")).toBe(false);
    expect(isMilestonesPathname("/settings/issues-milestones")).toBe(false);
  });

  it("names the open milestone only on its own page", () => {
    expect(milestoneIdInPathname("/issues/milestones/msl_1")).toBe("msl_1");
    expect(milestoneIdInPathname("/issues/milestones")).toBeNull();
    expect(milestoneIdInPathname("/issues/milestones/msl_1/extra")).toBeNull();
  });

  it("decodes the segment, so an id the router escaped still matches the row", () => {
    expect(milestoneIdInPathname("/issues/milestones/msl%2F1")).toBe("msl/1");
  });
});

describe("milestonesOverviewGroups", () => {
  const projects = [project("prj_a", "Alpha"), project("prj_b", "Beta")];

  it("keeps the project order and sorts each project's milestones by position", () => {
    const groups = milestonesOverviewGroups(
      projects,
      [
        milestone("msl_2", "prj_a", { position: 2 }),
        milestone("msl_1", "prj_a", { position: 1 }),
        milestone("msl_3", "prj_b", { position: 1 }),
      ],
      undefined,
    );
    expect(groups.map((group) => group.title)).toEqual(["Alpha", "Beta"]);
    expect(groups[0]?.milestones.map((one) => one.id)).toEqual(["msl_1", "msl_2"]);
    expect(groups[1]?.milestones.map((one) => one.id)).toEqual(["msl_3"]);
  });

  it("keeps a project with no milestones, because that group holds the way to make one", () => {
    const groups = milestonesOverviewGroups(projects, [], undefined);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.milestones).toEqual([]);
  });

  it("narrows to the filtered project", () => {
    const groups = milestonesOverviewGroups(
      projects,
      [milestone("msl_1", "prj_a"), milestone("msl_3", "prj_b")],
      "prj_b",
    );
    expect(groups.map((group) => group.projectId)).toEqual(["prj_b"]);
  });

  it("groups and filters legacy local project ids under their company project", () => {
    const logicalProjects = [
      {
        ...project("prj_company", "Quotecloud"),
        projectIds: ["prj_company", "prj_local"].map((id) => ProjectId.make(id)),
      },
    ];
    const localMilestone = milestone("msl_local", "prj_local");

    expect(
      milestonesOverviewGroups(logicalProjects, [localMilestone], undefined)[0]?.milestones,
    ).toEqual([localMilestone]);
    expect(
      milestonesOverviewGroups(logicalProjects, [localMilestone], "prj_local").map(
        (group) => group.projectId,
      ),
    ).toEqual(["prj_company"]);
  });

  it("drops a milestone whose project the client has not read", () => {
    const groups = milestonesOverviewGroups(projects, [milestone("msl_9", "prj_gone")], undefined);
    expect(groups.flatMap((group) => [...group.milestones])).toEqual([]);
  });
});

describe("milestoneTally", () => {
  it("counts work in review as started, without review being the only category that counts", () => {
    expect(
      milestoneTally({ done: 1, total: 4 }, counts({ backlog: 1, review: 1, started: 1 })),
    ).toEqual({ done: 1, total: 4, started: 2 });
  });

  it("leaves out the categories that are neither begun nor in flight", () => {
    expect(
      milestoneTally({ done: 2, total: 5 }, counts({ backlog: 2, unstarted: 1, completed: 2 })),
    ).toEqual({ done: 2, total: 5, started: 0 });
  });

  it("takes done and total from the rollup, so the row and the sidebar agree about canceled work", () => {
    // `total` excludes the canceled issue the breakdown still counts.
    expect(milestoneTally({ done: 1, total: 1 }, counts({ completed: 1, canceled: 3 }))).toEqual({
      done: 1,
      total: 1,
      started: 0,
    });
  });

  it("moves a milestone off upcoming as soon as anything is in review", () => {
    const tally = milestoneTally({ done: 0, total: 2 }, counts({ review: 1, unstarted: 1 }));
    expect(issueMilestoneStatusOn({ startDate: null, targetDate: null }, tally, TODAY)).toBe(
      "in-progress",
    );
  });

  it("moves a dateless milestone off upcoming on finished work with nothing in flight", () => {
    const tally = milestoneTally({ done: 3, total: 5 }, counts({ completed: 3, backlog: 2 }));
    expect(issueMilestoneStatusOn({ startDate: null, targetDate: null }, tally, TODAY)).toBe(
      "in-progress",
    );
  });
});

describe("milestoneIssueCount", () => {
  it("counts everything a delete would unassign, canceled work included", () => {
    expect(milestoneIssueCount(counts({ completed: 2, canceled: 1, review: 1 }))).toBe(4);
    expect(milestoneIssueCount(counts({}))).toBe(0);
  });
});

describe("milestoneProgressRatio", () => {
  it("reads an empty milestone as zero rather than as finished", () => {
    expect(milestoneProgressRatio({ done: 0, total: 0 })).toBe(0);
    expect(milestoneProgressRatio({ done: 3, total: 4 })).toBe(0.75);
  });
});

describe("formatMilestoneDateRange", () => {
  it("prints a span, one end, or nothing at all", () => {
    expect(formatMilestoneDateRange("2026-08-12", "2026-08-25", TODAY)).toBe("Aug 12 – Aug 25");
    expect(formatMilestoneDateRange(null, "2026-08-25", TODAY)).toBe("Due Aug 25");
    expect(formatMilestoneDateRange("2026-08-12", null, TODAY)).toBe("From Aug 12");
    expect(formatMilestoneDateRange(null, null, TODAY)).toBeNull();
  });

  it("says the year once a date leaves the obvious one", () => {
    expect(formatMilestoneDateRange(null, "2027-01-04", TODAY)).toBe("Due Jan 4, 2027");
  });
});

describe("MILESTONE_STATUS_LABELS", () => {
  it("names every status the contract derives", () => {
    expect(MILESTONE_STATUS_LABELS["in-progress"]).toBe("In progress");
    expect(Object.keys(MILESTONE_STATUS_LABELS).sort()).toEqual([
      "completed",
      "in-progress",
      "overdue",
      "upcoming",
    ]);
  });
});
