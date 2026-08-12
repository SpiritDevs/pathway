import {
  IssueEnrichmentRunId,
  IssueId,
  IssueLabelId,
  IssueStatusId,
  ProviderInstanceId,
  type Issue,
  type IssueEnrichmentResult,
  type IssueEnrichmentRun,
  type IssueEnrichmentRunState,
  type IssueLabel,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_ENRICHMENT_STATE_LABELS,
  activeIssueEnrichmentRun,
  formatIssueEnrichmentDuration,
  hasIssueEnrichmentSuggestions,
  issueApplyLabelPatch,
  issueApplyPriorityPatch,
  issueEnrichmentRunDurationMs,
  issueEnrichmentRunPresentation,
  issueInvestigateBlock,
  latestIssueEnrichmentRun,
  resolveIssueSuggestedLabels,
  shouldFollowIssueTranscript,
} from "./issueEnrichment.logic";

const NOW = "2026-08-12T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId.make("i1"),
    key: "PAT-1",
    title: "Issue",
    description: "",
    statusId: IssueStatusId.make("todo"),
    priority: "none",
    assignee: null,
    projectId: null,
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: "m",
    labelIds: [],
    dueDate: null,
    triage: false,
    slackSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function label(id: string, name: string): IssueLabel {
  return {
    id: IssueLabelId.make(id),
    name,
    color: "#abcdef",
    createdAt: NOW,
  };
}

function run(
  state: IssueEnrichmentRunState,
  overrides: Partial<IssueEnrichmentRun> = {},
): IssueEnrichmentRun {
  return {
    id: IssueEnrichmentRunId.make("r1"),
    issueId: IssueId.make("i1"),
    state,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    transcript: "",
    result: null,
    error: null,
    createdAt: NOW,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

const RESULT: IssueEnrichmentResult = {
  summary: "It is the login test.",
  likelyFiles: [],
  relatedIssueKeys: [],
  suggestedLabels: [],
  suggestedPriority: null,
};

describe("issueInvestigateBlock", () => {
  const ok = {
    connected: true,
    deleted: false,
    projectId: "p1",
    workspaceRoot: "/repo",
    hasRunInFlight: false,
  };

  it("clears when the issue has a rooted project and nothing is running", () => {
    expect(issueInvestigateBlock(ok)).toBe(null);
  });

  it("names the thing the reader can act on first", () => {
    expect(issueInvestigateBlock({ ...ok, connected: false, projectId: null })).toBe(
      "disconnected",
    );
    expect(issueInvestigateBlock({ ...ok, deleted: true, projectId: null })).toBe("deleted");
    expect(issueInvestigateBlock({ ...ok, projectId: null })).toBe("no-project");
  });

  it("refuses a rootless project, and a project this client has not loaded", () => {
    expect(issueInvestigateBlock({ ...ok, workspaceRoot: null })).toBe("rootless-project");
    expect(issueInvestigateBlock({ ...ok, workspaceRoot: undefined })).toBe("rootless-project");
  });

  it("refuses a second run while one is in flight", () => {
    expect(issueInvestigateBlock({ ...ok, hasRunInFlight: true })).toBe("in-flight");
  });
});

describe("run presentation", () => {
  it("counts up while running and freezes on the finish timestamp", () => {
    const running = run("running", { startedAt: NOW });
    expect(issueEnrichmentRunDurationMs(running, NOW_MS + 90_000)).toBe(90_000);

    const finished = run("done", {
      startedAt: NOW,
      finishedAt: "2026-08-12T00:00:20.000Z",
    });
    expect(issueEnrichmentRunDurationMs(finished, NOW_MS + 90_000)).toBe(20_000);
  });

  it("has no duration before it starts, and never a negative one", () => {
    expect(issueEnrichmentRunDurationMs(run("queued"), NOW_MS)).toBe(null);
    expect(issueEnrichmentRunDurationMs(run("running", { startedAt: NOW }), NOW_MS - 5_000)).toBe(
      0,
    );
  });

  it("formats a duration the way a log reads", () => {
    expect(formatIssueEnrichmentDuration(4_400)).toBe("4s");
    expect(formatIssueEnrichmentDuration(80_000)).toBe("1m 20s");
    expect(formatIssueEnrichmentDuration(60 * 64 * 1000)).toBe("1h 04m");
  });

  it("calls queued pending rather than active, so no cancel button appears on a slot wait", () => {
    expect(issueEnrichmentRunPresentation(run("queued"), NOW_MS)).toMatchObject({
      label: ISSUE_ENRICHMENT_STATE_LABELS.queued,
      tone: "pending",
      isActive: true,
      durationLabel: null,
    });
    expect(issueEnrichmentRunPresentation(run("failed"), NOW_MS).tone).toBe("failed");
  });

  it("opens on the newest run and cancels the one still in flight", () => {
    const newest = run("done", { id: IssueEnrichmentRunId.make("r2") });
    const older = run("running");
    expect(latestIssueEnrichmentRun([newest, older])?.id).toBe("r2");
    expect(activeIssueEnrichmentRun([newest, older])?.id).toBe("r1");
    expect(activeIssueEnrichmentRun([newest])).toBe(null);
    expect(latestIssueEnrichmentRun([])).toBe(null);
  });
});

describe("shouldFollowIssueTranscript", () => {
  it("follows at the bottom and inside the threshold", () => {
    expect(
      shouldFollowIssueTranscript({ scrollTop: 800, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
    expect(
      shouldFollowIssueTranscript({ scrollTop: 780, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(true);
  });

  it("stops following once the reader has scrolled up past it", () => {
    expect(
      shouldFollowIssueTranscript({ scrollTop: 600, scrollHeight: 1000, clientHeight: 200 }),
    ).toBe(false);
  });

  it("takes a threshold, for a caller that wants a tighter latch", () => {
    expect(
      shouldFollowIssueTranscript({
        scrollTop: 780,
        scrollHeight: 1000,
        clientHeight: 200,
        thresholdPx: 4,
      }),
    ).toBe(false);
  });
});

describe("suggestions", () => {
  const labels = [label("l1", "Bug"), label("l2", "Chore")];

  it("matches a suggested name case-insensitively and says which are already on", () => {
    expect(
      resolveIssueSuggestedLabels(["bug", " CHORE ", "Flake"], labels, [labels[0]!.id]),
    ).toEqual([
      { name: "bug", label: labels[0], applied: true },
      { name: " CHORE ", label: labels[1], applied: false },
      { name: "Flake", label: null, applied: false },
    ]);
  });

  it("adds a label rather than toggling it, so a second press is a no-op", () => {
    const target = issue({ labelIds: [IssueLabelId.make("l2")] });
    expect(issueApplyLabelPatch(target, IssueLabelId.make("l1"))).toEqual({
      labelIds: ["l2", "l1"],
    });
    expect(issueApplyLabelPatch(target, IssueLabelId.make("l2"))).toBe(null);
  });

  it("writes a priority only when it moves", () => {
    expect(issueApplyPriorityPatch(issue(), "high")).toEqual({ priority: "high" });
    expect(issueApplyPriorityPatch(issue({ priority: "high" }), "high")).toBe(null);
    expect(issueApplyPriorityPatch(issue(), null)).toBe(null);
  });

  it("renders no suggestion row when everything is already applied or unresolvable", () => {
    const applied = issue({ priority: "high", labelIds: [IssueLabelId.make("l1")] });
    expect(
      hasIssueEnrichmentSuggestions(
        { ...RESULT, suggestedLabels: ["Bug"], suggestedPriority: "high" },
        applied,
        labels,
      ),
    ).toBe(false);
    expect(
      hasIssueEnrichmentSuggestions({ ...RESULT, suggestedLabels: ["Flake"] }, issue(), labels),
    ).toBe(false);
    expect(
      hasIssueEnrichmentSuggestions({ ...RESULT, suggestedLabels: ["Chore"] }, applied, labels),
    ).toBe(true);
  });
});
