import {
  IssueCommentId,
  IssueCycleId,
  IssueEventId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  ProjectId,
  ProviderDriverKind,
  type Issue,
  type IssueComment,
  type IssueEvent,
  type IssueEventKind,
  type IssueTodo,
} from "@spiritdevs/contracts";
import { MembershipId } from "@spiritdevs/contracts/company";
import { describe, expect, it } from "vite-plus/test";

import type { IssueRelationLabel } from "~/state/issues";
import {
  DEFAULT_ISSUE_RELATION_CHOICE,
  ISSUE_ASSIGNEE_NONE_VALUE,
  buildIssueTreeIndex,
  canEditIssueComment,
  canParentIssue,
  describeIssueEvent,
  groupIssueRelationDisplays,
  issueActorLabel,
  issueAssigneeOptionValue,
  issueAssigneeOptions,
  issueAncestorDepth,
  issueAssigneePatch,
  issueCommentCreateBody,
  issueCommentUpdatePatch,
  issueCycleDraftError,
  issueCyclePatch,
  issueDescriptionPatch,
  issueDueDateInputValue,
  issueDueDatePatch,
  isCompleteIssueDate,
  issueLabelCreateName,
  issueLabelTogglePatch,
  issueMilestoneCreateName,
  issueMilestonePatch,
  issueParentCandidates,
  issueParentPatch,
  issuePriorityPatch,
  issueProjectPatch,
  issueRelationChoice,
  issueRelationCreateInput,
  issueStatusPatch,
  issueSheetHistory,
  issueSubtreeHeight,
  issueTitlePatch,
  issueTodoCreateText,
  issueTodoProgress,
  issueTodoTextPatch,
  issueTodoTogglePatch,
  nextIssueLabelColor,
  moveIssueSheetHistory,
  pushIssueSheetHistory,
  reorderedIssueTodoIds,
  resolveIssueDetailState,
  sameIssueAssignee,
  searchIssues,
  sortIssueEvents,
} from "./issueDetail.logic";

const NOW = "2026-08-12T00:00:00.000Z";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: IssueId.make("issue-1"),
    key: "PAT-1",
    title: "Ship the tracker",
    description: "",
    statusId: IssueStatusId.make("status-todo"),
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

function event(overrides: Partial<IssueEvent> & { kind: IssueEventKind }): IssueEvent {
  return {
    id: IssueEventId.make("event-1"),
    issueId: IssueId.make("issue-1"),
    actor: { kind: "user" },
    field: null,
    before: null,
    after: null,
    createdAt: NOW,
    ...overrides,
  };
}

const MEMBER_A = MembershipId.make("membership-a");
const MEMBER_B = MembershipId.make("membership-b");

const PROVIDER_LABELS = new Map([
  ["codex", "Codex"],
  ["claudeAgent", "Claude"],
]);

describe("issue sheet history", () => {
  it("walks backward and forward through in-sheet visits", () => {
    const visited = pushIssueSheetHistory(
      pushIssueSheetHistory(issueSheetHistory("PAT-1"), "PAT-2"),
      "PAT-3",
    );

    const back = moveIssueSheetHistory(visited, -1);
    expect(back.entries[back.index]).toBe("PAT-2");
    const forward = moveIssueSheetHistory(back, 1);
    expect(forward.entries[forward.index]).toBe("PAT-3");
  });

  it("discards the forward path after visiting a different issue", () => {
    const visited = pushIssueSheetHistory(
      pushIssueSheetHistory(issueSheetHistory("PAT-1"), "PAT-2"),
      "PAT-3",
    );
    const back = moveIssueSheetHistory(visited, -1);

    expect(pushIssueSheetHistory(back, "PAT-4")).toEqual({
      entries: ["PAT-1", "PAT-2", "PAT-4"],
      index: 2,
    });
  });
});

describe("resolveIssueDetailState", () => {
  it("is ready whenever the issue resolved, whatever the connection is doing", () => {
    expect(
      resolveIssueDetailState({ storeStatus: "loading", issue: issue(), settled: false }),
    ).toBe("ready");
  });

  // A soft delete leaves the row in the store for the depth cap; the sheet has nothing to show.
  it("reads a soft-deleted issue as not-found rather than rendering a tombstone", () => {
    expect(
      resolveIssueDetailState({
        storeStatus: "ready",
        issue: { ...issue(), deletedAt: NOW },
        settled: true,
      }),
    ).toBe("not-found");
  });

  it("reports the missing environment ahead of the missing issue", () => {
    expect(
      resolveIssueDetailState({ storeStatus: "disconnected", issue: null, settled: true }),
    ).toBe("disconnected");
  });

  it("holds a deep link at loading until the opening replay has settled", () => {
    expect(resolveIssueDetailState({ storeStatus: "ready", issue: null, settled: false })).toBe(
      "loading",
    );
    expect(resolveIssueDetailState({ storeStatus: "ready", issue: null, settled: true })).toBe(
      "not-found",
    );
  });

  it("calls a settled error state not-found rather than leaving a spinner", () => {
    expect(resolveIssueDetailState({ storeStatus: "error", issue: null, settled: true })).toBe(
      "not-found",
    );
  });
});

describe("issueAssigneeOptions", () => {
  const options = issueAssigneeOptions([
    { value: ProviderDriverKind.make("codex"), label: "Codex" },
    { value: ProviderDriverKind.make("claudeAgent"), label: "Claude" },
  ]);

  it("leads with unassigned and the human, then one row per provider", () => {
    expect(options.map((option) => option.label)).toEqual(["Unassigned", "You", "Codex", "Claude"]);
  });

  it("round-trips every option through its value", () => {
    for (const option of options) {
      expect(issueAssigneeOptionValue(option.assignee)).toBe(option.value);
    }
  });

  it("gives unassigned the empty value a radio group can carry", () => {
    expect(options[0]?.value).toBe(ISSUE_ASSIGNEE_NONE_VALUE);
  });

  it("uses the signed-in membership for You and offers active teammates by name", () => {
    const memberOptions = issueAssigneeOptions(
      [],
      [
        { membershipId: MEMBER_A, label: "Ada" },
        { membershipId: MEMBER_B, label: "Grace" },
      ],
      MEMBER_A,
    );
    expect(memberOptions.map((option) => option.label)).toEqual(["Unassigned", "You", "Grace"]);
    expect(memberOptions[1]?.assignee).toEqual({ kind: "member", membershipId: MEMBER_A });
    expect(issueAssigneeOptions([], [], MEMBER_A)[1]?.assignee).toEqual({
      kind: "member",
      membershipId: MEMBER_A,
    });
  });
});

describe("sameIssueAssignee", () => {
  it("compares the actor, not the object", () => {
    const codex = ProviderDriverKind.make("codex");
    expect(
      sameIssueAssignee({ kind: "agent", provider: codex }, { kind: "agent", provider: codex }),
    ).toBe(true);
    expect(sameIssueAssignee({ kind: "user" }, null)).toBe(false);
    expect(sameIssueAssignee(null, null)).toBe(true);
  });

  it("does not read one company member as another", () => {
    expect(
      sameIssueAssignee(
        { kind: "member", membershipId: MEMBER_A },
        { kind: "member", membershipId: MEMBER_A },
      ),
    ).toBe(true);
    // Reassigning from one teammate to another is a real change, so the patch has to survive it.
    expect(
      sameIssueAssignee(
        { kind: "member", membershipId: MEMBER_A },
        { kind: "member", membershipId: MEMBER_B },
      ),
    ).toBe(false);
    expect(
      issueAssigneePatch(issue({ assignee: { kind: "member", membershipId: MEMBER_A } }), {
        kind: "member",
        membershipId: MEMBER_B,
      }),
    ).toEqual({ assignee: { kind: "member", membershipId: MEMBER_B } });
  });
});

describe("patch assembly", () => {
  it("refuses an empty title rather than sending a write the contract rejects", () => {
    expect(issueTitlePatch(issue(), "   ")).toBeNull();
  });

  it("trims a title and skips a no-op", () => {
    expect(issueTitlePatch(issue(), "  Renamed  ")).toEqual({ title: "Renamed" });
    expect(issueTitlePatch(issue(), "  Ship the tracker ")).toBeNull();
  });

  it("keeps description whitespace, which is markdown", () => {
    expect(issueDescriptionPatch(issue(), "  indented\n")).toEqual({
      description: "  indented\n",
    });
    expect(issueDescriptionPatch(issue({ description: "same" }), "same")).toBeNull();
  });

  it("skips a status, priority, project, or assignee that did not move", () => {
    const current = issue({
      statusId: IssueStatusId.make("status-todo"),
      priority: "high",
      projectId: ProjectId.make("project-1"),
      assignee: { kind: "user" },
    });
    expect(issueStatusPatch(current, IssueStatusId.make("status-todo"))).toBeNull();
    expect(issueStatusPatch(current, IssueStatusId.make("status-done"))).toEqual({
      statusId: "status-done",
    });
    expect(issuePriorityPatch(current, "high")).toBeNull();
    expect(issuePriorityPatch(current, "urgent")).toEqual({ priority: "urgent" });
    expect(issueProjectPatch(current, ProjectId.make("project-1"))).toBeNull();
    expect(issueProjectPatch(current, null)).toEqual({ projectId: null });
    expect(issueAssigneePatch(current, { kind: "user" })).toBeNull();
    expect(issueAssigneePatch(current, null)).toEqual({ assignee: null });
  });

  it("toggles a label id in and back out", () => {
    const labelId = IssueLabelId.make("label-bug");
    const added = issueLabelTogglePatch(issue(), labelId);
    expect(added).toEqual({ labelIds: [labelId] });
    expect(issueLabelTogglePatch(issue({ labelIds: [labelId] }), labelId)).toEqual({
      labelIds: [],
    });
  });

  it("clears a due date on an empty field and refuses a half-typed one", () => {
    const dated = issue({ dueDate: "2026-08-20" });
    expect(issueDueDateInputValue(dated)).toBe("2026-08-20");
    expect(issueDueDateInputValue(issue())).toBe("");
    expect(issueDueDatePatch(dated, "")).toEqual({ dueDate: null });
    expect(issueDueDatePatch(issue(), "")).toBeNull();
    expect(issueDueDatePatch(dated, "2026-8-2")).toBeNull();
    expect(issueDueDatePatch(dated, "2026-08-20")).toBeNull();
    expect(issueDueDatePatch(dated, "2026-09-01")).toEqual({ dueDate: "2026-09-01" });
  });

  it("tells a whole calendar day from the empty string a half-typed one reports", () => {
    expect(isCompleteIssueDate("2026-09-01")).toBe(true);
    expect(isCompleteIssueDate("")).toBe(false);
    expect(isCompleteIssueDate("2026-09")).toBe(false);
  });
});

describe("issueActorLabel", () => {
  it("names the human, the provider, and every system source", () => {
    expect(issueActorLabel({ kind: "user" })).toBe("You");
    expect(
      issueActorLabel(
        { kind: "agent", provider: ProviderDriverKind.make("claudeAgent") },
        { providerLabels: PROVIDER_LABELS },
      ),
    ).toBe("Claude");
    expect(issueActorLabel({ kind: "agent", provider: ProviderDriverKind.make("fork") })).toBe(
      "fork",
    );
    expect(issueActorLabel({ kind: "system", source: "import" })).toBe("CSV import");
    expect(issueActorLabel({ kind: "system", source: "slack" })).toBe("Slack");
  });

  it("names each company member apart, by name when it knows one", () => {
    const naming = { memberNames: new Map([["membership-a", "Ada"]]) };
    expect(issueActorLabel({ kind: "member", membershipId: MEMBER_A }, naming)).toBe("Ada");
    // Never a bare "Member": two teammates sharing one line is two people losing their words.
    expect(issueActorLabel({ kind: "member", membershipId: MEMBER_B }, naming)).toBe(
      "Unknown member",
    );
  });

  it("names the cycle carry-over as itself rather than as Slack", () => {
    // `IssueTrackerService.finalizeEndedCycles` signs its writes `{ kind: "system", source:
    // "cycles" }`. A label bag that only knew `import` and `slack` attributed them to Slack.
    expect(issueActorLabel({ kind: "system", source: "cycles" })).toBe("Cycle rollover");
  });
});

describe("describeIssueEvent", () => {
  it("describes the lifecycle kinds without a field", () => {
    expect(describeIssueEvent(event({ kind: "created" })).summary).toBe("created this issue");
    expect(describeIssueEvent(event({ kind: "deleted" })).summary).toBe("deleted this issue");
    expect(describeIssueEvent(event({ kind: "restored" })).summary).toBe("restored this issue");
    expect(
      describeIssueEvent(event({ kind: "imported", actor: { kind: "system", source: "import" } })),
    ).toEqual({ actor: "CSV import", summary: "imported this issue" });
  });

  it("quotes a rename and stays quiet about a body", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "title", before: "Old", after: "New" }),
      ).summary,
    ).toBe("renamed this to “New”");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "description", before: "a", after: "b" }),
      ).summary,
    ).toBe("updated the description");
  });

  it("describes an automatically discovered pull request", () => {
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          field: "pullRequest",
          before: null,
          after: "#42 Show PRs on issues",
          actor: { kind: "system", source: "automation" },
        }),
      ),
    ).toEqual({ actor: "Automation", summary: "linked pull request #42 Show PRs on issues" });
  });

  it("reads a status move as from/to and a first set as to", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "status", before: "Todo", after: "In Progress" }),
      ).summary,
    ).toBe("changed status from Todo to In Progress");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "status", before: null, after: "Todo" }),
      ).summary,
    ).toBe("set the status to Todo");
  });

  it("turns the stored priority literals into their menu labels", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "priority", before: "none", after: "urgent" }),
      ).summary,
    ).toBe("changed priority from No priority to Urgent");
  });

  it("decodes the assignee encoding the log stores", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "assignee", before: null, after: "agent:codex" }),
        { providerLabels: PROVIDER_LABELS },
      ).summary,
    ).toBe("assigned this to Codex");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "assignee", before: "user", after: null }),
      ).summary,
    ).toBe("unassigned this");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "assignee", before: null, after: "user" }),
      ).summary,
    ).toBe("assigned this to you");
    // A teammate reads by name when the directory knows them, and by membership when it does not.
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          field: "assignee",
          before: null,
          after: "member:membership-a",
        }),
        { memberNames: new Map([["membership-a", "Ada"]]) },
      ).summary,
    ).toBe("assigned this to Ada");
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          field: "assignee",
          before: null,
          after: "member:membership-b",
        }),
      ).summary,
    ).toBe("assigned this to Unknown member");
  });

  it("names a project by title and falls back to the raw id", () => {
    const naming = { projectTitles: new Map([["project-1", "Pathway"]]) };
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "project", before: null, after: "project-1" }),
        naming,
      ).summary,
    ).toBe("moved this to Pathway");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "project", before: null, after: "project-9" }),
        naming,
      ).summary,
    ).toBe("moved this to project-9");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "project", before: "project-1", after: null }),
        naming,
      ).summary,
    ).toBe("removed this from its project");
  });

  it("names a parent by key", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "parent", before: null, after: "issue-7" }),
        { issueKeys: new Map([["issue-7", "PAT-7"]]) },
      ).summary,
    ).toBe("made this a sub-issue of PAT-7");
  });

  it("reads the triage flag as the two things it means", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "triage", before: "no", after: "yes" }),
      ).summary,
    ).toBe("moved this into triage");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "triage", before: "yes", after: "no" }),
      ).summary,
    ).toBe("accepted this out of triage");
  });

  it("treats an empty label list as a removal, not as a blank name", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "labels", before: "bug", after: "" }),
      ).summary,
    ).toBe("removed every label");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "labels", before: "", after: "bug" }),
      ).summary,
    ).toBe("added the labels bug");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "labels", before: "bug", after: "bug, ui" }),
      ).summary,
    ).toBe("changed labels to bug, ui");
  });

  it("reads a milestone and a cycle move from the names the log stored", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "milestone", before: null, after: "Beta" }),
      ).summary,
    ).toBe("set the milestone to Beta");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "milestone", before: "Beta", after: null }),
      ).summary,
    ).toBe("cleared the milestone");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "cycle", before: "Cycle 3", after: "Cycle 4" }),
      ).summary,
    ).toBe("changed cycle from Cycle 3 to Cycle 4");
  });

  it("reads a cycle carry-over as the whole sentence the tracker wrote", () => {
    // The exact row `finalizeEndedCycles` appends: the tracker's own actor, and the ended cycle's
    // name on the left with the next one on the right.
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          actor: { kind: "system", source: "cycles" },
          field: "cycle",
          before: "Cycle 3",
          after: "Cycle 4",
        }),
      ),
    ).toEqual({ actor: "Cycle rollover", summary: "changed cycle from Cycle 3 to Cycle 4" });
    // No next cycle: the carry-over drops the issue out of every cycle instead.
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          actor: { kind: "system", source: "cycles" },
          field: "cycle",
          before: "Cycle 3",
          after: null,
        }),
      ).summary,
    ).toBe("cleared the cycle");
  });

  it("keeps the relation phrase, which is the whole content of the row", () => {
    // `logRelation` writes one side's phrase per issue, so the feed already reads from this end.
    expect(
      describeIssueEvent(
        event({
          kind: "field_changed",
          field: "relation",
          before: null,
          after: "blocked by PAT-2",
        }),
      ).summary,
    ).toBe("added the relation “blocked by PAT-2”");
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "relation", before: "blocks PAT-2", after: null }),
      ).summary,
    ).toBe("removed the relation “blocks PAT-2”");
  });

  it("still says something about a field it has never heard of", () => {
    expect(
      describeIssueEvent(
        event({ kind: "field_changed", field: "estimate", before: null, after: "3" }),
      ).summary,
    ).toBe("changed estimate");
  });
});

describe("sortIssueEvents", () => {
  it("puts the oldest first", () => {
    const older = event({ kind: "created", id: IssueEventId.make("b"), createdAt: NOW });
    const newer = event({
      kind: "field_changed",
      id: IssueEventId.make("c"),
      createdAt: "2026-08-13T00:00:00.000Z",
      field: "title",
    });
    expect(sortIssueEvents([newer, older]).map((entry) => entry.id)).toEqual(["b", "c"]);
  });

  // One edit that moves three fields writes three rows on the same millisecond; the repository
  // returns them in write order and the feed has to keep it, not resort them by random uuid.
  it("keeps the server's order for events on the same timestamp", () => {
    const renamed = event({
      kind: "field_changed",
      id: IssueEventId.make("z"),
      createdAt: NOW,
      field: "title",
    });
    const moved = event({
      kind: "field_changed",
      id: IssueEventId.make("a"),
      createdAt: NOW,
      field: "status",
    });
    const prioritized = event({
      kind: "field_changed",
      id: IssueEventId.make("m"),
      createdAt: NOW,
      field: "priority",
    });
    expect(sortIssueEvents([renamed, moved, prioritized]).map((entry) => entry.field)).toEqual([
      "title",
      "status",
      "priority",
    ]);
  });

  it("does not mutate its input", () => {
    const events = [
      event({
        kind: "field_changed",
        id: IssueEventId.make("z"),
        createdAt: "2026-08-13T00:00:00.000Z",
      }),
      event({ kind: "created", id: IssueEventId.make("a") }),
    ];
    sortIssueEvents(events);
    expect(events[0]?.id).toBe("z");
  });
});

describe("inline label creation", () => {
  it("takes the first palette colour nothing is wearing", () => {
    const palette = ["#eb5757", "#f2994a", "#f2c94c"];
    expect(nextIssueLabelColor(palette, [], "#000000")).toBe("#eb5757");
    expect(nextIssueLabelColor(palette, [{ color: "#EB5757" }], "#000000")).toBe("#f2994a");
  });

  it("wraps around once the palette is exhausted", () => {
    const palette = ["#eb5757", "#f2994a"];
    expect(nextIssueLabelColor(palette, [{ color: "#eb5757" }, { color: "#f2994a" }], "#000")).toBe(
      "#eb5757",
    );
    expect(nextIssueLabelColor([], [], "#000")).toBe("#000");
  });

  it("rejects a blank or duplicate name so the button can stay disabled", () => {
    expect(issueLabelCreateName("  ", [])).toBeNull();
    expect(issueLabelCreateName(" Bug ", [{ name: "bug" }])).toBeNull();
    expect(issueLabelCreateName(" Bug ", [{ name: "ui" }])).toBe("Bug");
  });
});

describe("milestone, cycle, and parent patches", () => {
  const milestone = IssueMilestoneId.make("m1");
  const cycle = IssueCycleId.make("c1");

  it("writes nothing when the value has not moved", () => {
    expect(issueMilestonePatch(issue({ milestoneId: milestone }), milestone)).toBeNull();
    expect(issueCyclePatch(issue({ cycleId: cycle }), cycle)).toBeNull();
    expect(issueParentPatch(issue({ parentId: null }), null)).toBeNull();
  });

  it("clears with an explicit null rather than an absent key", () => {
    expect(issueMilestonePatch(issue({ milestoneId: milestone }), null)).toEqual({
      milestoneId: null,
    });
    expect(issueCyclePatch(issue({ cycleId: cycle }), null)).toEqual({ cycleId: null });
  });

  it("refuses to make an issue its own parent", () => {
    const row = issue();
    expect(issueParentPatch(row, row.id)).toBeNull();
  });
});

describe("hierarchy", () => {
  // a → b → c, and d standing alone.
  const a = issue({ id: IssueId.make("a"), key: "PAT-1" });
  const b = issue({ id: IssueId.make("b"), key: "PAT-2", parentId: a.id });
  const c = issue({ id: IssueId.make("c"), key: "PAT-3", parentId: b.id });
  const d = issue({ id: IssueId.make("d"), key: "PAT-4" });
  const tree = buildIssueTreeIndex([a, b, c, d]);

  it("counts ancestors and subtree height", () => {
    expect(issueAncestorDepth(tree, a.id)).toBe(0);
    expect(issueAncestorDepth(tree, c.id)).toBe(2);
    expect(issueSubtreeHeight(tree, a.id)).toBe(2);
    expect(issueSubtreeHeight(tree, c.id)).toBe(0);
  });

  // The server's `buildIssueTree` reads every record, deleted or not, so an index that dropped
  // them would measure a shallower chain than the write is checked against.
  it("keeps soft-deleted rows, so a deleted ancestor still costs a level", () => {
    const withDeleted = buildIssueTreeIndex([{ ...a, deletedAt: NOW }, b, c]);
    expect(withDeleted.byId.has(a.id)).toBe(true);
    expect(issueAncestorDepth(withDeleted, b.id)).toBe(1);
    expect(issueAncestorDepth(withDeleted, c.id)).toBe(2);
    // Counted for depth, never offered: nothing gets filed under a row in the bin.
    expect(canParentIssue(withDeleted, { issueId: c.id, candidateId: a.id })).toBe(false);
    expect(
      issueParentCandidates(withDeleted, { issueId: c.id, query: "" }).map((row) => row.id),
    ).toEqual(["b"]);
  });

  // The chain is what the server measured before the delete, so the same write is still refused.
  // Dropping the deleted root would read `e` as two deep and offer it as a parent for nothing.
  it("still refuses a fifth level when the root of the chain is in the bin", () => {
    const e = issue({ id: IssueId.make("e"), key: "PAT-5", parentId: c.id });
    const deep = buildIssueTreeIndex([{ ...a, deletedAt: NOW }, b, c, e, d]);

    expect(issueAncestorDepth(deep, e.id)).toBe(3);
    expect(canParentIssue(deep, { issueId: d.id, candidateId: e.id })).toBe(false);
    expect(canParentIssue(deep, { issueId: d.id, candidateId: c.id })).toBe(true);
  });

  it("survives a parent loop written before the cap existed", () => {
    const left = issue({ id: IssueId.make("l"), parentId: IssueId.make("r") });
    const right = issue({ id: IssueId.make("r"), parentId: IssueId.make("l") });
    const looped = buildIssueTreeIndex([left, right]);
    expect(issueAncestorDepth(looped, left.id)).toBe(2);
    expect(issueSubtreeHeight(looped, left.id)).toBe(2);
  });

  it("refuses itself, its own descendants, and anything past the depth cap", () => {
    expect(canParentIssue(tree, { issueId: a.id, candidateId: a.id })).toBe(false);
    expect(canParentIssue(tree, { issueId: a.id, candidateId: c.id })).toBe(false);
    // `a` carries a two-deep subtree, so under `d` (depth 0) it would sit 3 deep — the cap.
    expect(canParentIssue(tree, { issueId: a.id, candidateId: d.id })).toBe(true);
    // `b` carries one level, so it fits under `d` too.
    expect(canParentIssue(tree, { issueId: b.id, candidateId: d.id })).toBe(true);
    // `c` is a leaf but `b` is already 1 deep, and `a` under `b` would be 1 + 1 + 2 = 4.
    expect(canParentIssue(tree, { issueId: a.id, candidateId: b.id })).toBe(false);
  });

  it("refuses a candidate the client has never seen", () => {
    expect(canParentIssue(tree, { issueId: a.id, candidateId: IssueId.make("ghost") })).toBe(false);
  });

  // The server counts the edge and then loses the parent, arriving at 1; matching that is the
  // whole point, because undercounting offers a parent the write refuses.
  it("counts an edge into a row it does not hold, the way the server does", () => {
    const orphan = buildIssueTreeIndex([issue({ id: IssueId.make("o"), parentId: a.id })]);
    expect(issueAncestorDepth(orphan, IssueId.make("o"))).toBe(1);
  });

  it("offers only the parents the server would accept", () => {
    expect(issueParentCandidates(tree, { issueId: c.id, query: "" }).map((row) => row.id)).toEqual([
      "a",
      "b",
      "d",
    ]);
    expect(issueParentCandidates(tree, { issueId: a.id, query: "" }).map((row) => row.id)).toEqual([
      "d",
    ]);
  });
});

describe("searchIssues", () => {
  const rows = [
    issue({ id: IssueId.make("1"), key: "PAT-1", title: "Ship the tracker" }),
    issue({ id: IssueId.make("2"), key: "PAT-22", title: "Tracker keyboard nav" }),
    issue({ id: IssueId.make("3"), key: "PAT-3", title: "Slack intake", deletedAt: NOW }),
  ];

  it("lists everything for an empty query so the picker opens usable", () => {
    expect(searchIssues(rows, { query: "" }).map((row) => row.id)).toEqual(["1", "2"]);
  });

  it("matches a bare number inside a key, and ranks a key hit above a title hit", () => {
    expect(searchIssues(rows, { query: "22" }).map((row) => row.id)).toEqual(["2"]);
    expect(searchIssues(rows, { query: "tracker" }).map((row) => row.id)).toEqual(["2", "1"]);
  });

  it("drops soft-deleted rows and anything excluded", () => {
    expect(searchIssues(rows, { query: "slack" })).toEqual([]);
    expect(
      searchIssues(rows, { query: "", exclude: new Set([IssueId.make("1")]) }).map((row) => row.id),
    ).toEqual(["2"]);
  });

  it("honours the limit", () => {
    expect(searchIssues(rows, { query: "", limit: 1 })).toHaveLength(1);
  });
});

describe("todos", () => {
  function todo(overrides: Partial<IssueTodo> = {}): IssueTodo {
    return {
      id: IssueTodoId.make("t1"),
      issueId: IssueId.make("issue-1"),
      text: "Write it down",
      done: false,
      position: 0,
      ...overrides,
    };
  }

  it("counts done against total", () => {
    expect(issueTodoProgress([todo(), todo({ id: IssueTodoId.make("t2"), done: true })])).toEqual({
      done: 1,
      total: 2,
    });
    expect(issueTodoProgress([])).toEqual({ done: 0, total: 0 });
  });

  it("flips done rather than setting it", () => {
    expect(issueTodoTogglePatch(todo({ done: true }))).toEqual({ done: false });
  });

  it("treats an emptied line as a rejected edit, not a delete", () => {
    expect(issueTodoTextPatch(todo(), "   ")).toBeNull();
    expect(issueTodoTextPatch(todo(), " Write it down ")).toBeNull();
    expect(issueTodoTextPatch(todo(), " Rewrite it ")).toEqual({ text: "Rewrite it" });
    expect(issueTodoCreateText("  ")).toBeNull();
    expect(issueTodoCreateText(" a ")).toBe("a");
  });

  it("answers a drop with the whole order, and null when nothing moved", () => {
    const todos = [
      todo({ id: IssueTodoId.make("t1"), position: 0 }),
      todo({ id: IssueTodoId.make("t2"), position: 1 }),
      todo({ id: IssueTodoId.make("todo-3"), position: 2 }),
    ];
    expect(reorderedIssueTodoIds({ todos, activeId: "todo-3", overId: "t1" })).toEqual([
      "todo-3",
      "t1",
      "t2",
    ]);
    expect(reorderedIssueTodoIds({ todos, activeId: "t1", overId: "t1" })).toBeNull();
    expect(reorderedIssueTodoIds({ todos, activeId: "t1", overId: "gone" })).toBeNull();
  });
});

describe("relations", () => {
  const self = IssueId.make("self");
  const other = IssueId.make("other");

  function display(
    label: IssueRelationLabel,
    relationId: string,
  ): {
    readonly relationId: IssueRelationId;
    readonly kind: "blocks";
    readonly direction: "outgoing";
    readonly issueId: IssueId;
    readonly label: IssueRelationLabel;
  } {
    return {
      relationId: IssueRelationId.make(relationId),
      kind: "blocks",
      direction: "outgoing",
      issueId: other,
      label,
    };
  }

  it("leads with blocked-by and drops empty groups", () => {
    const groups = groupIssueRelationDisplays([
      display("Related", "r1"),
      display("Blocking", "r2"),
      display("Blocked by", "r3"),
    ]);
    expect(groups.map((group) => group.label)).toEqual(["Blocked by", "Blocking", "Related"]);
    expect(groups[0]?.displays).toHaveLength(1);
  });

  it("swaps the ends for blocked-by, because there is no such kind", () => {
    expect(
      issueRelationCreateInput({
        issueId: self,
        otherIssueId: other,
        choice: issueRelationChoice("blocked-by"),
      }),
    ).toEqual({ issueId: other, relatedIssueId: self, kind: "blocks" });
    expect(
      issueRelationCreateInput({
        issueId: self,
        otherIssueId: other,
        choice: issueRelationChoice("blocks"),
      }),
    ).toEqual({ issueId: self, relatedIssueId: other, kind: "blocks" });
    expect(
      issueRelationCreateInput({
        issueId: self,
        otherIssueId: other,
        choice: issueRelationChoice("duplicate"),
      }),
    ).toEqual({ issueId: self, relatedIssueId: other, kind: "duplicate" });
  });

  it("refuses a self-relation the server would call invalid", () => {
    expect(
      issueRelationCreateInput({
        issueId: self,
        otherIssueId: self,
        choice: DEFAULT_ISSUE_RELATION_CHOICE,
      }),
    ).toBeNull();
  });

  it("falls back rather than throwing on an unknown choice", () => {
    expect(issueRelationChoice("nonsense" as never)).toBe(DEFAULT_ISSUE_RELATION_CHOICE);
  });
});

describe("comments", () => {
  function comment(overrides: Partial<IssueComment> = {}): IssueComment {
    return {
      id: IssueCommentId.make("c1"),
      issueId: IssueId.make("issue-1"),
      author: { kind: "user" },
      body: "Looks right",
      attachmentIds: [],
      createdAt: NOW,
      editedAt: null,
      ...overrides,
    };
  }

  it("lets the human edit only their own", () => {
    expect(canEditIssueComment(comment())).toBe(true);
    expect(
      canEditIssueComment(
        comment({ author: { kind: "agent", provider: ProviderDriverKind.make("codex") } }),
      ),
    ).toBe(false);
    expect(canEditIssueComment(comment({ author: { kind: "system", source: "slack" } }))).toBe(
      false,
    );
  });

  it("trims the newline a Return before Cmd+Enter left behind", () => {
    expect(issueCommentCreateBody("  hi \n")).toBe("hi");
    expect(issueCommentCreateBody(" \n ")).toBeNull();
  });

  it("writes no patch for an unchanged or emptied edit", () => {
    expect(issueCommentUpdatePatch(comment(), " Looks right ")).toBeNull();
    expect(issueCommentUpdatePatch(comment(), "   ")).toBeNull();
    expect(issueCommentUpdatePatch(comment(), "Looks wrong")).toEqual({ body: "Looks wrong" });
  });
});

describe("inline milestone and cycle creation", () => {
  it("clashes a milestone name only within its project's list", () => {
    expect(issueMilestoneCreateName(" Beta ", [{ name: "beta" }])).toBeNull();
    expect(issueMilestoneCreateName(" Beta ", [{ name: "alpha" }])).toBe("Beta");
  });

  it("names what is wrong with a cycle draft, in the order the form is filled", () => {
    expect(issueCycleDraftError({ name: " ", startDate: "", endDate: "" })).toBe(
      "A cycle needs a name.",
    );
    expect(issueCycleDraftError({ name: "Cycle 4", startDate: "", endDate: "" })).toBe(
      "Pick a start date.",
    );
    expect(issueCycleDraftError({ name: "Cycle 4", startDate: "2026-08-12", endDate: "" })).toBe(
      "Pick an end date.",
    );
    expect(
      issueCycleDraftError({ name: "Cycle 4", startDate: "2026-08-25", endDate: "2026-08-12" }),
    ).toBe("The cycle ends before it starts.");
    expect(
      issueCycleDraftError({ name: "Cycle 4", startDate: "2026-08-12", endDate: "2026-08-12" }),
    ).toBeNull();
  });
});
