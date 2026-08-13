import {
  IssueEnrichmentRunId,
  IssueId,
  IssueStatusId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type Issue,
  type IssueEnrichmentRun,
  type IssueSlackSource,
  type IssueStatus,
  type IssueStatusCategory,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  firstUnstartedStatusId,
  formatIssueAge,
  formatSlackMrkdwn,
  isCompletedInvestigationRun,
  issueAlreadyInvestigated,
  issueHasCompletedInvestigation,
  sharedTriageProjectId,
  slackSourceChip,
  triageAcceptDefaults,
  triageAcceptInput,
  triageAcceptLabel,
  triageInvestigateBlock,
  triageRowPresentation,
} from "./triage.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function status(id: string, category: IssueStatusCategory, position: number): IssueStatus {
  return {
    id: IssueStatusId.make(id),
    name: id,
    color: "#abcdef",
    category,
    position,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

const BACKLOG = status("backlog", "backlog", 0);
const TODO = status("todo", "unstarted", 1);
const NEXT = status("next", "unstarted", 2);
const DOING = status("doing", "started", 3);

function issue(id: string, overrides: Partial<Omit<Issue, "id">> = {}): Issue {
  return {
    id: IssueId.make(id),
    key: `PAT-${id}`,
    title: `Issue ${id}`,
    description: "",
    statusId: TODO.id,
    priority: "none",
    assignee: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: "m",
    labelIds: [],
    dueDate: null,
    triage: true,
    slackSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function enrichmentRun(
  id: string,
  issueId: string,
  state: IssueEnrichmentRun["state"],
  overrides: Partial<IssueEnrichmentRun> = {},
): IssueEnrichmentRun {
  return {
    id: IssueEnrichmentRunId.make(id),
    issueId: IssueId.make(issueId),
    state,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-codex",
    },
    transcript: "",
    result:
      state === "done"
        ? {
            summary: "Found it.",
            likelyFiles: [],
            relatedIssueKeys: [],
            suggestedLabels: [],
            suggestedPriority: null,
          }
        : null,
    error: state === "failed" ? "refused" : null,
    createdAt: NOW,
    startedAt: state === "queued" ? null : NOW,
    finishedAt: state === "done" || state === "failed" ? NOW : null,
    ...overrides,
  };
}

function slackSource(overrides: Partial<IssueSlackSource> = {}): IssueSlackSource {
  return {
    issueId: IssueId.make("1"),
    channelId: "C0DESIGN",
    messageTs: "1723459200.001900",
    permalink: "https://acme.slack.com/archives/C0DESIGN/p1723459200001900",
    authorName: "Corey",
    ...overrides,
  };
}

const CHANNEL_NAMES = new Map([["C0DESIGN", "design"]]);
const PROJECT_TITLES = new Map([["p1", "Pathway"]]);

describe("formatIssueAge", () => {
  it("counts up through the units and stops at weeks", () => {
    const at = (ms: number) => formatIssueAge(new Date(NOW_MS - ms).toISOString(), NOW_MS);
    expect(at(5_000)).toBe("now");
    expect(at(59_000)).toBe("now");
    expect(at(60_000)).toBe("1m");
    expect(at(59 * 60_000)).toBe("59m");
    expect(at(3 * 3_600_000)).toBe("3h");
    expect(at(26 * 3_600_000)).toBe("1d");
    expect(at(6 * 86_400_000)).toBe("6d");
    expect(at(20 * 86_400_000)).toBe("2w");
  });

  it("reads a future timestamp as now rather than as a negative age", () => {
    expect(formatIssueAge(new Date(NOW_MS + 90_000).toISOString(), NOW_MS)).toBe("now");
  });

  it("is empty for something that is not a timestamp", () => {
    expect(formatIssueAge("not a date", NOW_MS)).toBe("");
  });
});

describe("formatSlackMrkdwn", () => {
  it("names a mention by its label and falls back when there is none", () => {
    expect(formatSlackMrkdwn("<@U024BE7LH|corey> can you look")).toBe("@corey can you look");
    expect(formatSlackMrkdwn("<@U024BE7LH> can you look")).toBe("@someone can you look");
  });

  it("keeps a channel reference reading as a channel", () => {
    expect(formatSlackMrkdwn("moved from <#C024BE7LH|general>")).toBe("moved from #general");
    expect(formatSlackMrkdwn("moved from <#C024BE7LH>")).toBe("moved from #channel");
  });

  it("unwraps a link to its label, or to the target when it has none", () => {
    expect(formatSlackMrkdwn("see <https://example.com/a|the doc>")).toBe("see the doc");
    expect(formatSlackMrkdwn("see <https://example.com/a>")).toBe("see https://example.com/a");
  });

  it("turns a broadcast into the word it broadcasts to", () => {
    expect(formatSlackMrkdwn("<!here> deploy is stuck")).toBe("@here deploy is stuck");
    expect(formatSlackMrkdwn("<!channel|@channel> down")).toBe("@channel down");
  });

  it("undoes the three escapes after the tags, so typed angle brackets survive", () => {
    expect(formatSlackMrkdwn("a &lt;b&gt; &amp; c")).toBe("a <b> & c");
    // The escape is undone last, so `&lt;@U1&gt;` is text somebody typed, not a mention.
    expect(formatSlackMrkdwn("&lt;@U1&gt;")).toBe("<@U1>");
  });

  it("collapses to one line, because a row has one line for it", () => {
    expect(formatSlackMrkdwn("first\n\n  second   third ")).toBe("first second third");
  });
});

describe("slackSourceChip", () => {
  it("names the channel from the watch table and joins the author on", () => {
    const chip = slackSourceChip(slackSource(), CHANNEL_NAMES);
    expect(chip.channelLabel).toBe("#design");
    expect(chip.authorLabel).toBe("Corey");
    expect(chip.label).toBe("#design · Corey");
    expect(chip.permalink).toBe("https://acme.slack.com/archives/C0DESIGN/p1723459200001900");
  });

  it("falls back to the id when nothing watches that channel any more", () => {
    const chip = slackSourceChip(slackSource({ channelId: "C0GONE" }), CHANNEL_NAMES);
    expect(chip.channelLabel).toBe("C0GONE");
    expect(chip.label).toBe("C0GONE · Corey");
  });

  it("is the channel alone when Slack did not say who wrote it", () => {
    const chip = slackSourceChip(slackSource({ authorName: null, permalink: null }), CHANNEL_NAMES);
    expect(chip.label).toBe("#design");
    expect(chip.permalink).toBeNull();
  });
});

describe("triageRowPresentation", () => {
  it("flattens the mrkdwn title and resolves the auto-tagged project", () => {
    const row = triageRowPresentation({
      issue: issue("1", {
        title: "<@U1|corey> the &amp; button",
        projectId: ProjectId.make("p1"),
        slackSource: slackSource(),
        createdAt: new Date(NOW_MS - 2 * 3_600_000).toISOString(),
      }),
      channelNames: CHANNEL_NAMES,
      projectTitles: PROJECT_TITLES,
      nowMs: NOW_MS,
    });
    expect(row.title).toBe("@corey the & button");
    expect(row.source?.label).toBe("#design · Corey");
    expect(row.ageLabel).toBe("2h");
    expect(row.projectTitle).toBe("Pathway");
  });

  it("leaves a non-Slack item's title alone and carries no chip", () => {
    const row = triageRowPresentation({
      issue: issue("2", { title: "Typed <by> hand" }),
      channelNames: CHANNEL_NAMES,
      projectTitles: PROJECT_TITLES,
      nowMs: NOW_MS,
    });
    expect(row.title).toBe("Typed <by> hand");
    expect(row.source).toBeNull();
    expect(row.projectTitle).toBeNull();
  });
});

describe("firstUnstartedStatusId", () => {
  it("takes the first unstarted status in position order, not the first status", () => {
    expect(firstUnstartedStatusId([BACKLOG, TODO, NEXT, DOING])).toBe(TODO.id);
  });

  it("falls back to the first status when the tracker has no unstarted one", () => {
    expect(firstUnstartedStatusId([BACKLOG, DOING])).toBe(BACKLOG.id);
  });

  it("is null on a tracker with no statuses at all", () => {
    expect(firstUnstartedStatusId([])).toBeNull();
  });
});

describe("sharedTriageProjectId", () => {
  const p1 = ProjectId.make("p1");
  const p2 = ProjectId.make("p2");

  it("is the auto-tag when the whole selection agrees", () => {
    expect(
      sharedTriageProjectId([issue("1", { projectId: p1 }), issue("2", { projectId: p1 })]),
    ).toBe(p1);
  });

  it("is null when two channels tagged two projects", () => {
    expect(
      sharedTriageProjectId([issue("1", { projectId: p1 }), issue("2", { projectId: p2 })]),
    ).toBeNull();
  });

  it("is null when one of them has no project", () => {
    expect(sharedTriageProjectId([issue("1", { projectId: p1 }), issue("2")])).toBeNull();
  });

  it("is null for an empty selection", () => {
    expect(sharedTriageProjectId([])).toBeNull();
  });
});

describe("triageInvestigateBlock", () => {
  const roots = new Map<string, string | null>([
    ["rooted", "/src/pathway"],
    ["rootless", null],
  ]);

  it("refuses an item with no project", () => {
    expect(triageInvestigateBlock({ projectId: null, workspaceRoots: roots })).toBe("no-project");
  });

  it("refuses a project with no directory", () => {
    expect(
      triageInvestigateBlock({ projectId: ProjectId.make("rootless"), workspaceRoots: roots }),
    ).toBe("rootless-project");
  });

  it("reads a project this client has never heard of as rootless", () => {
    expect(
      triageInvestigateBlock({ projectId: ProjectId.make("unknown"), workspaceRoots: roots }),
    ).toBe("rootless-project");
  });

  it("allows a project with a directory", () => {
    expect(
      triageInvestigateBlock({ projectId: ProjectId.make("rooted"), workspaceRoots: roots }),
    ).toBeNull();
  });
});

describe("issueHasCompletedInvestigation", () => {
  const plain = issue("1");

  it("reads a completed run rather than the description the block no longer lives in", () => {
    expect(issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "1", "done")])).toBe(true);
    expect(issueHasCompletedInvestigation(plain, [])).toBe(false);
    expect(issueHasCompletedInvestigation(plain)).toBe(false);
  });

  it("does not count a run that has not produced a result", () => {
    expect(issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "1", "queued")])).toBe(false);
    expect(issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "1", "running")])).toBe(
      false,
    );
    expect(issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "1", "failed")])).toBe(false);
    // `done` with no result cannot happen on the wire, but nothing here should assume it.
    expect(
      issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "1", "done", { result: null })]),
    ).toBe(false);
  });

  it("ignores runs belonging to another issue", () => {
    expect(issueHasCompletedInvestigation(plain, [enrichmentRun("r1", "99", "done")])).toBe(false);
  });

  it("still recognises the legacy block appended to an old issue's description", () => {
    const legacy = issue("1", {
      description: "Original report\n\n---\n\n## Investigation (codex, 2026-08-13)\nFound it.",
    });
    expect(issueHasCompletedInvestigation(legacy)).toBe(true);
    // The heading only counts at the start of a line, not quoted inside prose.
    expect(
      issueHasCompletedInvestigation(issue("1", { description: "see ## Investigation (x)" })),
    ).toBe(false);
  });
});

describe("isCompletedInvestigationRun", () => {
  it("is done with a result and nothing else", () => {
    expect(isCompletedInvestigationRun(enrichmentRun("r1", "1", "done"))).toBe(true);
    expect(isCompletedInvestigationRun(enrichmentRun("r1", "1", "running"))).toBe(false);
    expect(isCompletedInvestigationRun(enrichmentRun("r1", "1", "failed"))).toBe(false);
  });
});

describe("issueAlreadyInvestigated", () => {
  const plain = issue("1");

  it("counts a run still in flight, which a completed investigation does not", () => {
    expect(issueAlreadyInvestigated(plain, undefined, [enrichmentRun("r1", "1", "queued")])).toBe(
      true,
    );
    expect(issueAlreadyInvestigated(plain, undefined, [enrichmentRun("r1", "1", "running")])).toBe(
      true,
    );
    expect(issueAlreadyInvestigated(plain, undefined, [enrichmentRun("r1", "1", "done")])).toBe(
      true,
    );
  });

  it("leaves a failed run open to a retry on acceptance", () => {
    expect(issueAlreadyInvestigated(plain, undefined, [enrichmentRun("r1", "1", "failed")])).toBe(
      false,
    );
  });

  it("takes the live id set when no runs have been loaded", () => {
    expect(issueAlreadyInvestigated(plain, new Set([plain.id]))).toBe(true);
    expect(issueAlreadyInvestigated(plain, new Set())).toBe(false);
    expect(issueAlreadyInvestigated(plain)).toBe(false);
  });
});

describe("triageAcceptDefaults", () => {
  const roots = new Map<string, string | null>([
    ["rooted", "/src/pathway"],
    ["rootless", null],
  ]);
  const statuses = [BACKLOG, TODO, NEXT, DOING];

  it("opens on the first unstarted status with investigation on for a rooted project", () => {
    const draft = triageAcceptDefaults({
      issues: [issue("1", { projectId: ProjectId.make("rooted") })],
      statuses,
      workspaceRoots: roots,
    });
    expect(draft.statusId).toBe(TODO.id);
    expect(draft.projectId).toBe("rooted");
    expect(draft.priority).toBe("none");
    expect(draft.runEnrichment).toBe(true);
  });

  it("turns investigation off when the auto-tagged project has no directory", () => {
    const draft = triageAcceptDefaults({
      issues: [issue("1", { projectId: ProjectId.make("rootless") })],
      statuses,
      workspaceRoots: roots,
    });
    expect(draft.runEnrichment).toBe(false);
  });

  it("does not default to a second run after Slack routing already investigated", () => {
    const projectId = ProjectId.make("rooted");

    // The investigation now lands as an agent comment, so the run row is what says it happened.
    const investigated = issue("1", { projectId });
    expect(
      triageAcceptDefaults({
        issues: [investigated],
        statuses,
        workspaceRoots: roots,
        enrichmentRuns: [enrichmentRun("r1", "1", "done")],
      }).runEnrichment,
    ).toBe(false);

    // A legacy issue, investigated back when the block was appended to the description.
    const legacy = issue("2", {
      projectId,
      description: "Original report\n\n---\n\n## Investigation (codex, 2026-08-13)\nFound it.",
    });
    expect(
      triageAcceptDefaults({ issues: [legacy], statuses, workspaceRoots: roots }).runEnrichment,
    ).toBe(false);

    const running = issue("3", { projectId });
    expect(
      triageAcceptDefaults({
        issues: [running],
        statuses,
        workspaceRoots: roots,
        investigatedIssueIds: new Set([running.id]),
      }).runEnrichment,
    ).toBe(false);
  });

  it("still offers a run when the only run for the issue failed", () => {
    expect(
      triageAcceptDefaults({
        issues: [issue("1", { projectId: ProjectId.make("rooted") })],
        statuses,
        workspaceRoots: roots,
        enrichmentRuns: [enrichmentRun("r1", "1", "failed")],
      }).runEnrichment,
    ).toBe(true);
  });

  it("turns investigation off when there is no project to run in", () => {
    expect(triageAcceptDefaults({ issues: [issue("1")], statuses, workspaceRoots: roots })).toEqual(
      {
        statusId: TODO.id,
        projectId: null,
        priority: "none",
        assignee: null,
        runEnrichment: false,
      },
    );
  });

  it("keeps a priority the whole selection already shares and drops one it does not", () => {
    expect(
      triageAcceptDefaults({
        issues: [issue("1", { priority: "high" }), issue("2", { priority: "high" })],
        statuses,
        workspaceRoots: roots,
      }).priority,
    ).toBe("high");
    expect(
      triageAcceptDefaults({
        issues: [issue("1", { priority: "high" }), issue("2", { priority: "low" })],
        statuses,
        workspaceRoots: roots,
      }).priority,
    ).toBe("none");
  });

  it("keeps a shared agent assignment and leaves a mixed selection unassigned", () => {
    const codex = {
      kind: "agent" as const,
      provider: ProviderDriverKind.make("codex"),
    };
    expect(
      triageAcceptDefaults({
        issues: [issue("1", { assignee: codex }), issue("2", { assignee: codex })],
        statuses,
        workspaceRoots: roots,
      }).assignee,
    ).toEqual(codex);
    expect(
      triageAcceptDefaults({
        issues: [issue("1", { assignee: codex }), issue("2", { assignee: { kind: "user" } })],
        statuses,
        workspaceRoots: roots,
      }).assignee,
    ).toBeNull();
  });
});

describe("triageAcceptInput", () => {
  const draft = {
    statusId: TODO.id,
    projectId: ProjectId.make("p1"),
    priority: "high",
    assignee: { kind: "agent", provider: ProviderDriverKind.make("codex") },
    runEnrichment: true,
  } as const;

  it("sends the project explicitly, so clearing it in the dialog clears it on the issue", () => {
    expect(
      triageAcceptInput({
        issue: issue("1", { projectId: ProjectId.make("p9") }),
        draft: { ...draft, projectId: null },
        investigateBlocked: true,
      }),
    ).toEqual({
      issueId: "1",
      statusId: TODO.id,
      projectId: null,
      priority: "high",
      assignee: { kind: "agent", provider: ProviderDriverKind.make("codex") },
      runEnrichment: false,
    });
  });

  it("carries the investigation through when nothing blocks it", () => {
    expect(
      triageAcceptInput({ issue: issue("1"), draft, investigateBlocked: false })?.runEnrichment,
    ).toBe(true);
  });

  it("is null with no status, which is what the confirm button is disabled on", () => {
    expect(
      triageAcceptInput({
        issue: issue("1"),
        draft: { ...draft, statusId: null },
        investigateBlocked: false,
      }),
    ).toBeNull();
  });
});

describe("triageAcceptLabel", () => {
  it("names the one issue and counts the many", () => {
    expect(triageAcceptLabel([issue("1")])).toBe("Accept PAT-1");
    expect(triageAcceptLabel([issue("1"), issue("2")])).toBe("Accept 2 issues");
  });
});
