import {
  IssueCommentId,
  IssueCycleId,
  IssueEnrichmentRunId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  IssueViewId,
  ProjectId,
  ProviderInstanceId,
  SlackChannelWatchId,
  ThreadId,
  type Issue,
  type IssueComment,
  type IssueCycle,
  type IssueDetail,
  type IssueEnrichmentRun,
  type IssueEnrichmentRunState,
  type IssueMilestone,
  type IssueRelationEdge,
  type IssueRelationKind,
  type IssueStatus,
  type IssueStatusCategory,
  type IssueThreadLink,
  type IssueTodo,
  type IssueTrackerConfig,
  type IssueView,
  type IssueViewConfig,
  type IssuesStreamEvent,
  type SlackChannelWatch,
  type SlackIntakeStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ISSUES_STORE,
  EMPTY_ISSUES_STREAM_STATE,
  EMPTY_ISSUE_AGENT_STATE,
  activeIssueCycle,
  applyIssueAgentStreamEvent,
  applyIssueDetailStreamEvent,
  applyIssuesStreamEvent,
  applyIssuesStreamEvents,
  applyIssuesStreamStateEvents,
  countTriageIssues,
  findIssue,
  groupIssuesForTab,
  issueChildRollup,
  issueCyclesByStatus,
  issueIdsNamedByCommandInput,
  issueMilestoneProgress,
  issueMilestonesForProject,
  issueRelationDisplays,
  issueSortOrderForDrop,
  listTriageIssues,
  mergeIssueDetail,
  mergeIssueEnrichmentRuns,
  mergeIssueLinksForThread,
  slackChannelNames,
  startWorkIssuesByThread,
  todayIssueDate,
  upcomingIssueCycles,
  type IssueAgentState,
  type IssueDetailOverlays,
  type IssuesStore,
} from "./issues";

const NOW = "2026-08-12T00:00:00.000Z";

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
const DOING = status("doing", "started", 2);
const REVIEW = status("review", "review", 3);
const DONE = status("done", "completed", 4);
const CANCELED = status("canceled", "canceled", 5);
const ALL_STATUSES = [BACKLOG, TODO, DOING, REVIEW, DONE, CANCELED];

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
    triage: false,
    slackSource: null,
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  };
}

function storeOf(issues: ReadonlyArray<Issue>, statuses = ALL_STATUSES): IssuesStore {
  return {
    ...EMPTY_ISSUES_STORE,
    issuesById: new Map(issues.map((value) => [value.id, value])),
    statuses,
  };
}

const CONFIG: IssueTrackerConfig = { keyPrefix: "PAT", nextNumber: 2 };

const VIEW_CONFIG: IssueViewConfig = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
};

function view(id: string, position: number): IssueView {
  return {
    id: IssueViewId.make(id),
    name: `View ${id}`,
    position,
    config: VIEW_CONFIG,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function milestone(
  id: string,
  projectId: string,
  position: number,
  overrides: Partial<IssueMilestone> = {},
): IssueMilestone {
  return {
    id: IssueMilestoneId.make(id),
    projectId: ProjectId.make(projectId),
    name: `Milestone ${id}`,
    description: null,
    targetDate: null,
    position,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function cycle(id: string, startDate: string, endDate: string): IssueCycle {
  return {
    id: IssueCycleId.make(id),
    name: `Cycle ${id}`,
    startDate,
    endDate,
    completedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function todo(id: string, issueId: string, position: number, done = false): IssueTodo {
  return {
    id: IssueTodoId.make(id),
    issueId: IssueId.make(issueId),
    text: `Todo ${id}`,
    done,
    position,
  };
}

function comment(
  id: string,
  issueId: string,
  createdAt: string,
  body = `Body ${id}`,
): IssueComment {
  return {
    id: IssueCommentId.make(id),
    issueId: IssueId.make(issueId),
    author: { kind: "user" },
    body,
    attachmentIds: [],
    createdAt,
    editedAt: null,
  };
}

function edge(
  id: string,
  issueId: string,
  relatedIssueId: string,
  kind: IssueRelationKind,
  direction: "outgoing" | "incoming",
): IssueRelationEdge {
  return {
    relation: {
      id: IssueRelationId.make(id),
      issueId: IssueId.make(issueId),
      relatedIssueId: IssueId.make(relatedIssueId),
      kind,
    },
    direction,
  };
}

describe("applyIssuesStreamEvent", () => {
  it("rebuilds the tracker from the diffs the stream opens with", () => {
    const events: ReadonlyArray<IssuesStreamEvent> = [
      { _tag: "StatusesChanged", statuses: [DOING, TODO] },
      { _tag: "LabelsChanged", labels: [] },
      { _tag: "ConfigChanged", config: CONFIG },
      { _tag: "IssueUpserted", issue: issue("1") },
    ];

    const store = applyIssuesStreamEvents(EMPTY_ISSUES_STORE, events);

    expect(store.statuses.map((value) => value.id)).toEqual([TODO.id, DOING.id]);
    expect(store.config).toEqual(CONFIG);
    expect(store.issuesById.get(IssueId.make("1"))?.title).toBe("Issue 1");
  });

  it("replaces an issue rather than appending it when the same id comes back", () => {
    const store = applyIssuesStreamEvents(EMPTY_ISSUES_STORE, [
      { _tag: "IssueUpserted", issue: issue("1", { title: "before" }) },
      { _tag: "IssueUpserted", issue: issue("1", { title: "after" }) },
    ]);

    expect(store.issuesById.size).toBe(1);
    expect(store.issuesById.get(IssueId.make("1"))?.title).toBe("after");
  });

  // A soft delete arrives as an upsert now, not as `IssueDeleted`: the depth cap counts a
  // soft-deleted row as an ancestor, so the store has to keep it.
  it("keeps a row that came back carrying deletedAt", () => {
    const store = applyIssuesStreamEvents(EMPTY_ISSUES_STORE, [
      { _tag: "IssueUpserted", issue: issue("1") },
      { _tag: "IssueUpserted", issue: issue("1", { deletedAt: NOW }) },
    ]);

    expect(store.issuesById.size).toBe(1);
    expect(store.issuesById.get(IssueId.make("1"))?.deletedAt).toBe(NOW);
  });

  it("orders views by position with the id breaking ties, like statuses", () => {
    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "ViewsChanged",
      views: [view("b", 1), view("a", 1), view("first", 0)],
    });

    expect(store.views.map((value) => value.id)).toEqual(["first", "a", "b"]);
  });

  // `IssueDeleted` is the hard purge. Nothing publishes it yet, but the fold has to answer for it.
  it("drops a purged issue and leaves the store alone when it never held it", () => {
    const before = storeOf([issue("1")]);

    const after = applyIssuesStreamEvent(before, {
      _tag: "IssueDeleted",
      issueId: IssueId.make("1"),
    });
    expect(after.issuesById.size).toBe(0);

    const missing = applyIssuesStreamEvent(before, {
      _tag: "IssueDeleted",
      issueId: IssueId.make("nope"),
    });
    expect(missing).toBe(before);
  });

  it("orders statuses by position with the id breaking ties", () => {
    const tied = [status("b", "started", 1), status("a", "started", 1), BACKLOG];

    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "StatusesChanged",
      statuses: tied,
    });

    expect(store.statuses.map((value) => value.id)).toEqual(["backlog", "a", "b"]);
  });

  it("orders labels by name so a rename does not reshuffle the picker", () => {
    const label = (id: string, name: string) => ({
      id: IssueLabelId.make(id),
      name,
      color: "#abcdef",
      createdAt: NOW,
    });

    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "LabelsChanged",
      labels: [label("2", "zeta"), label("1", "alpha")],
    });

    expect(store.labels.map((value) => value.name)).toEqual(["alpha", "zeta"]);
  });
});

describe("groupIssuesForTab", () => {
  const issues = [
    issue("1", { statusId: BACKLOG.id }),
    issue("2", { statusId: TODO.id }),
    issue("3", { statusId: DOING.id }),
    issue("4", { statusId: REVIEW.id }),
    issue("5", { statusId: DONE.id }),
    issue("6", { statusId: CANCELED.id }),
  ];

  it("puts unstarted, started, and review in Active", () => {
    const grouping = groupIssuesForTab(storeOf(issues), "active");

    expect(grouping.groups.map((group) => group.status.id)).toEqual([TODO.id, DOING.id, REVIEW.id]);
    expect(grouping.total).toBe(3);
  });

  it("puts only the backlog category in Backlog", () => {
    const grouping = groupIssuesForTab(storeOf(issues), "backlog");

    expect(grouping.groups.map((group) => group.status.id)).toEqual([BACKLOG.id]);
    expect(grouping.total).toBe(1);
  });

  it("keeps completed and canceled out of Active but shows them in All", () => {
    expect(groupIssuesForTab(storeOf(issues), "all").total).toBe(6);
    expect(
      groupIssuesForTab(storeOf(issues), "all").groups.map((group) => group.status.id),
    ).toEqual([BACKLOG.id, TODO.id, DOING.id, REVIEW.id, DONE.id, CANCELED.id]);
  });

  it("excludes triage items from every tab", () => {
    const withTriage = [...issues, issue("7", { statusId: TODO.id, triage: true })];

    for (const tab of ["active", "backlog", "all"] as const) {
      const grouping = groupIssuesForTab(storeOf(withTriage), tab);
      const ids = grouping.groups.flatMap((group) => group.issues.map((value) => value.id));
      expect(ids).not.toContain(IssueId.make("7"));
    }
    expect(groupIssuesForTab(storeOf(withTriage), "all").total).toBe(6);
  });

  it("excludes soft-deleted rows the snapshot still carries", () => {
    const withDeleted = [...issues, issue("8", { statusId: TODO.id, deletedAt: NOW })];

    expect(groupIssuesForTab(storeOf(withDeleted), "all").total).toBe(6);
  });

  it("emits an empty group for a status with nothing in it", () => {
    const grouping = groupIssuesForTab(storeOf([issue("1", { statusId: TODO.id })]), "active");

    expect(grouping.groups.map((group) => group.issues.length)).toEqual([1, 0, 0]);
  });

  it("orders a group by sortOrder with the id breaking ties", () => {
    const grouping = groupIssuesForTab(
      storeOf([
        issue("c", { statusId: TODO.id, sortOrder: "n" }),
        issue("b", { statusId: TODO.id, sortOrder: "m" }),
        issue("a", { statusId: TODO.id, sortOrder: "m" }),
      ]),
      "active",
    );

    expect(grouping.groups[0]?.issues.map((value) => value.id)).toEqual(["a", "b", "c"]);
  });

  it("skips an issue whose status is not in the tracker rather than inventing a group", () => {
    const orphan = issue("1", { statusId: IssueStatusId.make("gone") });

    const grouping = groupIssuesForTab(storeOf([orphan]), "all");

    expect(grouping.total).toBe(0);
    expect(grouping.groups).toHaveLength(ALL_STATUSES.length);
  });

  it("returns nothing before the statuses arrive", () => {
    const grouping = groupIssuesForTab(storeOf([issue("1")], []), "all");

    expect(grouping.groups).toHaveLength(0);
    expect(grouping.total).toBe(0);
  });
});

describe("Slack intake in the store", () => {
  function watch(id: string, channelId: string, channelName: string): SlackChannelWatch {
    return {
      id: SlackChannelWatchId.make(id),
      channelId,
      channelName,
      projectId: null,
      autoInvestigate: false,
      trigger: {
        reactionRoutes: [{ emoji: "ticket", projectId: null, autoInvestigate: null }],
        everyMessage: false,
        botMention: false,
      },
      createdAt: NOW,
      updatedAt: NOW,
    };
  }

  const CONNECTED: SlackIntakeStatus = {
    configured: true,
    lastPollAt: NOW,
    lastError: null,
    workspaceName: "Acme",
  };

  it("starts unconfigured, which is the truth on a server with no token", () => {
    expect(EMPTY_ISSUES_STORE.slackStatus.configured).toBe(false);
    expect(EMPTY_ISSUES_STORE.slackWatches).toHaveLength(0);
  });

  it("holds the watches by channel name, not in the order they were added", () => {
    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "SlackWatchesChanged",
      watches: [watch("w2", "C2", "support"), watch("w1", "C1", "design")],
    });

    expect(store.slackWatches.map((value) => value.channelName)).toEqual(["design", "support"]);
  });

  it("replaces the status outright, since the server publishes the whole thing", () => {
    const store = applyIssuesStreamEvents(EMPTY_ISSUES_STORE, [
      { _tag: "SlackStatusChanged", status: CONNECTED },
      { _tag: "SlackStatusChanged", status: { ...CONNECTED, lastError: "invalid_auth" } },
    ]);

    expect(store.slackStatus.lastError).toBe("invalid_auth");
    expect(store.slackStatus.workspaceName).toBe("Acme");
  });

  it("names a channel from the watch table, which is all a source chip has to go on", () => {
    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "SlackWatchesChanged",
      watches: [watch("w1", "C1", "design")],
    });

    expect(slackChannelNames(store).get("C1")).toBe("design");
    expect(slackChannelNames(store).get("C-gone")).toBeUndefined();
  });
});

describe("listTriageIssues", () => {
  it("is newest first, and excludes rejected items", () => {
    const store = storeOf([
      issue("1", { triage: true, createdAt: "2026-08-10T00:00:00.000Z" }),
      issue("2", { triage: true, createdAt: "2026-08-12T00:00:00.000Z" }),
      issue("3", { triage: true, deletedAt: NOW }),
      issue("4"),
    ]);

    expect(listTriageIssues(store).map((value) => value.id)).toEqual(["2", "1"]);
  });

  it("breaks a same-instant tie on the id, so the order is total", () => {
    const store = storeOf([issue("a", { triage: true }), issue("b", { triage: true })]);

    expect(listTriageIssues(store).map((value) => value.id)).toEqual(["b", "a"]);
  });
});

describe("countTriageIssues", () => {
  it("counts pending triage items and ignores deleted ones", () => {
    const store = storeOf([
      issue("1", { triage: true }),
      issue("2", { triage: true }),
      issue("3", { triage: true, deletedAt: NOW }),
      issue("4"),
    ]);

    expect(countTriageIssues(store)).toBe(2);
  });
});

describe("findIssue", () => {
  const store = storeOf([issue("abc", { key: "PAT-221" })]);

  it("resolves by row id and by the key the URL carries", () => {
    expect(findIssue(store, "abc")?.key).toBe("PAT-221");
    expect(findIssue(store, "PAT-221")?.id).toBe("abc");
    expect(findIssue(store, "PAT-999")).toBeNull();
  });
});

describe("issueSortOrderForDrop", () => {
  const siblings = [{ sortOrder: "b" }, { sortOrder: "n" }, { sortOrder: "y" }];

  it("places a drop between its neighbours", () => {
    const key = issueSortOrderForDrop({ siblings, index: 1 });

    expect(key).not.toBeNull();
    expect(key! > "b" && key! < "n").toBe(true);
  });

  it("places a drop at the top before everything", () => {
    const key = issueSortOrderForDrop({ siblings, index: 0 });

    expect(key! < "b").toBe(true);
  });

  it("places a drop at the bottom after everything", () => {
    const key = issueSortOrderForDrop({ siblings, index: siblings.length });

    expect(key! > "y").toBe(true);
  });

  it("appends into an empty group", () => {
    expect(issueSortOrderForDrop({ siblings: [], index: 0 })).not.toBeNull();
  });

  it("clamps an index past either end instead of reading undefined neighbours", () => {
    expect(issueSortOrderForDrop({ siblings, index: 99 })).toBe(
      issueSortOrderForDrop({ siblings, index: siblings.length }),
    );
    expect(issueSortOrderForDrop({ siblings, index: -3 })).toBe(
      issueSortOrderForDrop({ siblings, index: 0 }),
    );
  });

  it("refuses a hand-edited neighbour key rather than breaking the order", () => {
    expect(issueSortOrderForDrop({ siblings: [{ sortOrder: "Z9" }], index: 1 })).toBeNull();
  });
});

describe("milestones and cycles in the store", () => {
  it("groups milestones by project and orders them by position with the id breaking ties", () => {
    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "MilestonesChanged",
      milestones: [
        milestone("b", "beta", 0),
        milestone("a2", "alpha", 1),
        milestone("a1", "alpha", 0),
        milestone("a0", "alpha", 0),
      ],
    });

    expect(store.milestones.map((value) => value.id)).toEqual(["a0", "a1", "a2", "b"]);
    expect(
      issueMilestonesForProject(store, ProjectId.make("alpha")).map((value) => value.id),
    ).toEqual(["a0", "a1", "a2"]);
    expect(issueMilestonesForProject(store, ProjectId.make("gone"))).toEqual([]);
  });

  it("orders cycles by start date so the sidebar reads forwards", () => {
    const store = applyIssuesStreamEvent(EMPTY_ISSUES_STORE, {
      _tag: "CyclesChanged",
      cycles: [
        cycle("late", "2026-09-01", "2026-09-14"),
        cycle("early", "2026-08-01", "2026-08-14"),
      ],
    });

    expect(store.cycles.map((value) => value.id)).toEqual(["early", "late"]);
  });
});

describe("applyIssueDetailStreamEvent", () => {
  const ISSUE = IssueId.make("1");

  it("replaces the whole todo list and sorts it by position", () => {
    const overlays = applyIssueDetailStreamEvent(EMPTY_ISSUES_STREAM_STATE.details, {
      _tag: "IssueTodosChanged",
      issueId: ISSUE,
      todos: [todo("b", "1", 1), todo("a", "1", 0)],
    });

    expect(overlays.get(ISSUE)?.todos?.map((value) => value.id)).toEqual(["a", "b"]);
  });

  it("keeps a comment upsert, an edit, and a tombstone for a delete", () => {
    const upserted = applyIssueDetailStreamEvent(EMPTY_ISSUES_STREAM_STATE.details, {
      _tag: "IssueCommentUpserted",
      comment: comment("c1", "1", NOW, "first"),
    });
    const edited = applyIssueDetailStreamEvent(upserted, {
      _tag: "IssueCommentUpserted",
      comment: comment("c1", "1", NOW, "second"),
    });
    const deleted = applyIssueDetailStreamEvent(edited, {
      _tag: "IssueCommentDeleted",
      issueId: ISSUE,
      commentId: IssueCommentId.make("c2"),
    });

    expect(edited.get(ISSUE)?.comments.get(IssueCommentId.make("c1"))?.body).toBe("second");
    expect(deleted.get(ISSUE)?.comments.get(IssueCommentId.make("c2"))).toBeNull();
  });

  it("drops an issue's overlay when the issue goes and ignores one it never held", () => {
    const before = applyIssueDetailStreamEvent(EMPTY_ISSUES_STREAM_STATE.details, {
      _tag: "IssueRelationsChanged",
      issueId: ISSUE,
      relations: [edge("r1", "1", "2", "blocks", "outgoing")],
    });

    expect(applyIssueDetailStreamEvent(before, { _tag: "IssueDeleted", issueId: ISSUE }).size).toBe(
      0,
    );
    expect(
      applyIssueDetailStreamEvent(before, { _tag: "IssueDeleted", issueId: IssueId.make("9") }),
    ).toBe(before);
  });

  it("leaves the overlays alone for a store event", () => {
    const before: IssueDetailOverlays = EMPTY_ISSUES_STREAM_STATE.details;

    expect(applyIssueDetailStreamEvent(before, { _tag: "ConfigChanged", config: CONFIG })).toBe(
      before,
    );
  });
});

describe("applyIssuesStreamStateEvents", () => {
  it("keeps the store identity when only a tail changed, so the list does not re-render", () => {
    const opened = applyIssuesStreamStateEvents(EMPTY_ISSUES_STREAM_STATE, [
      { _tag: "StatusesChanged", statuses: ALL_STATUSES },
      { _tag: "IssueUpserted", issue: issue("1") },
    ]);

    const commented = applyIssuesStreamStateEvents(opened, [
      { _tag: "IssueCommentUpserted", comment: comment("c1", "1", NOW) },
    ]);

    expect(commented.store).toBe(opened.store);
    expect(commented.details).not.toBe(opened.details);
  });

  it("returns the same state for a chunk that changed nothing", () => {
    const opened = applyIssuesStreamStateEvents(EMPTY_ISSUES_STREAM_STATE, [
      { _tag: "IssueUpserted", issue: issue("1") },
    ]);

    expect(
      applyIssuesStreamStateEvents(opened, [{ _tag: "IssueDeleted", issueId: IssueId.make("9") }]),
    ).toBe(opened);
  });
});

describe("mergeIssueDetail", () => {
  const detail: IssueDetail = {
    todos: [todo("b", "1", 1), todo("a", "1", 0)],
    relations: [edge("r1", "1", "2", "blocks", "outgoing")],
    comments: [comment("c2", "1", "2026-08-12T00:00:02.000Z"), comment("c1", "1", NOW)],
  };

  it("sorts a read that has no overlay yet", () => {
    const merged = mergeIssueDetail(detail, undefined);

    expect(merged.todos.map((value) => value.id)).toEqual(["a", "b"]);
    expect(merged.comments.map((value) => value.id)).toEqual(["c1", "c2"]);
  });

  it("lets the live list replace the read for todos and relations", () => {
    const merged = mergeIssueDetail(detail, {
      todos: [todo("c", "1", 0)],
      relations: [],
      comments: new Map(),
    });

    expect(merged.todos.map((value) => value.id)).toEqual(["c"]);
    expect(merged.relations).toEqual([]);
  });

  it("adds, replaces, and removes comments the stream has spoken about", () => {
    const merged = mergeIssueDetail(detail, {
      todos: null,
      relations: null,
      comments: new Map([
        [IssueCommentId.make("c1"), comment("c1", "1", NOW, "edited")],
        [IssueCommentId.make("c2"), null],
        [IssueCommentId.make("c3"), comment("c3", "1", "2026-08-12T00:00:03.000Z")],
      ]),
    });

    expect(merged.comments.map((value) => value.id)).toEqual(["c1", "c3"]);
    expect(merged.comments[0]?.body).toBe("edited");
    expect(merged.relations).toBe(detail.relations);
  });
});

describe("issueChildRollup", () => {
  it("orders children by sortOrder and counts completed against the uncanceled total", () => {
    const store = storeOf([
      issue("parent"),
      issue("c", { parentId: IssueId.make("parent"), sortOrder: "n", statusId: DONE.id }),
      issue("a", { parentId: IssueId.make("parent"), sortOrder: "b", statusId: DOING.id }),
      issue("b", { parentId: IssueId.make("parent"), sortOrder: "m", statusId: DONE.id }),
      issue("x", { parentId: IssueId.make("parent"), sortOrder: "y", statusId: CANCELED.id }),
    ]);

    const rollup = issueChildRollup(store, IssueId.make("parent"));

    expect(rollup.childIds).toEqual(["a", "b", "c", "x"]);
    expect(rollup).toMatchObject({ done: 2, total: 3 });
  });

  it("ignores deleted and triage children and answers zero for a childless issue", () => {
    const store = storeOf([
      issue("parent"),
      issue("gone", { parentId: IssueId.make("parent"), deletedAt: NOW }),
      issue("pending", { parentId: IssueId.make("parent"), triage: true }),
    ]);

    expect(issueChildRollup(store, IssueId.make("parent"))).toMatchObject({
      childIds: [],
      done: 0,
      total: 0,
    });
    expect(issueChildRollup(store, IssueId.make("nobody")).total).toBe(0);
  });
});

describe("issueMilestoneProgress", () => {
  const MILESTONE = IssueMilestoneId.make("m1");
  const store: IssuesStore = {
    ...storeOf([
      issue("1", { milestoneId: MILESTONE, statusId: DONE.id }),
      issue("2", { milestoneId: MILESTONE, statusId: TODO.id }),
      issue("3", { milestoneId: MILESTONE, statusId: CANCELED.id }),
      issue("4", { milestoneId: MILESTONE, statusId: DONE.id, deletedAt: NOW }),
      issue("5", { statusId: DONE.id }),
    ]),
    milestones: [milestone("m1", "alpha", 0), milestone("m2", "alpha", 1)],
  };

  it("counts only the milestone's live, uncanceled issues", () => {
    expect(issueMilestoneProgress(store, MILESTONE)).toEqual({ done: 1, total: 2 });
  });

  it("answers zero for an empty milestone and for one that is gone", () => {
    expect(issueMilestoneProgress(store, IssueMilestoneId.make("m2"))).toEqual({
      done: 0,
      total: 0,
    });
    expect(issueMilestoneProgress(store, IssueMilestoneId.make("gone"))).toEqual({
      done: 0,
      total: 0,
    });
  });
});

describe("issueRelationDisplays", () => {
  it("reads a blocks row from both ends and names the counterpart", () => {
    const [blocking, blocked] = issueRelationDisplays([
      edge("r1", "1", "2", "blocks", "outgoing"),
      edge("r2", "3", "1", "blocks", "incoming"),
    ]);

    expect(blocking).toMatchObject({ label: "Blocking", issueId: "2" });
    expect(blocked).toMatchObject({ label: "Blocked by", issueId: "3" });
  });

  it("labels the symmetric kinds the same from either end and groups the list", () => {
    const displays = issueRelationDisplays([
      edge("r4", "9", "1", "duplicate", "incoming"),
      edge("r3", "1", "8", "relates", "outgoing"),
      edge("r2", "7", "1", "blocks", "incoming"),
      edge("r1", "1", "6", "blocks", "outgoing"),
    ]);

    expect(displays.map((display) => display.label)).toEqual([
      "Blocking",
      "Blocked by",
      "Related",
      "Duplicate",
    ]);
    expect(displays.map((display) => display.issueId)).toEqual(["6", "7", "8", "9"]);
  });
});

describe("cycle status", () => {
  const cycles = [
    cycle("past", "2026-07-01", "2026-07-31"),
    cycle("now", "2026-08-01", "2026-08-14"),
    cycle("next", "2026-08-15", "2026-08-28"),
    cycle("later", "2026-09-01", "2026-09-14"),
  ];

  it("splits the list into active, upcoming, and ended", () => {
    const split = issueCyclesByStatus(cycles, "2026-08-12");

    expect(split.active.map((value) => value.id)).toEqual(["now"]);
    expect(split.upcoming.map((value) => value.id)).toEqual(["next", "later"]);
    expect(split.ended.map((value) => value.id)).toEqual(["past"]);
  });

  it("includes both ends of the range, so the last day is still active", () => {
    expect(activeIssueCycle(cycles, "2026-08-01")?.id).toBe("now");
    expect(activeIssueCycle(cycles, "2026-08-14")?.id).toBe("now");
    expect(activeIssueCycle(cycles, "2026-08-29")).toBeNull();
    expect(upcomingIssueCycles(cycles, "2026-08-29").map((value) => value.id)).toEqual(["later"]);
  });

  it("takes the earliest of two overlapping cycles rather than guessing", () => {
    const overlapping = [
      cycle("second", "2026-08-10", "2026-08-20"),
      cycle("first", "2026-08-01", "2026-08-14"),
    ];

    expect(activeIssueCycle(overlapping, "2026-08-12")?.id).toBe("second");
    expect(issueCyclesByStatus(overlapping, "2026-08-12").active).toHaveLength(2);
  });
});

describe("todayIssueDate", () => {
  it("pads a local calendar day rather than reading one out of an instant", () => {
    expect(todayIssueDate(new Date(2026, 0, 5, 23, 30))).toBe("2026-01-05");
    expect(todayIssueDate(new Date(2026, 11, 31, 0, 15))).toBe("2026-12-31");
  });
});

describe("issueIdsNamedByCommandInput", () => {
  it("finds the issues a write touches so their change log can be invalidated", () => {
    expect(issueIdsNamedByCommandInput({ issueId: "1", patch: {} })).toEqual(["1"]);
    expect(issueIdsNamedByCommandInput({ issueIds: ["1", "2"], patch: {} })).toEqual(["1", "2"]);
    expect(
      issueIdsNamedByCommandInput({ issueId: "1", relatedIssueId: "2", kind: "blocks" }),
    ).toEqual(["1", "2"]);
  });

  it("names nothing for a create, a row-id-only delete, or a malformed input", () => {
    expect(issueIdsNamedByCommandInput({ title: "New" })).toEqual([]);
    expect(issueIdsNamedByCommandInput({ relationId: "r1" })).toEqual([]);
    expect(issueIdsNamedByCommandInput(null)).toEqual([]);
    expect(issueIdsNamedByCommandInput({ issueIds: [1, "2"] })).toEqual(["2"]);
  });
});

function run(
  id: string,
  issueId: string,
  state: IssueEnrichmentRunState,
  overrides: Partial<IssueEnrichmentRun> = {},
): IssueEnrichmentRun {
  return {
    id: IssueEnrichmentRunId.make(id),
    issueId: IssueId.make(issueId),
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

function link(issueId: string, threadId: string, createdAt = NOW): IssueThreadLink {
  return {
    issueId: IssueId.make(issueId),
    threadId: ThreadId.make(threadId),
    createdAt,
    origin: "start-work",
  };
}

describe("applyIssueAgentStreamEvent", () => {
  it("marks an issue as investigating while a run is in flight and unmarks it when it settles", () => {
    const queued = applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "queued"),
    });
    expect([...queued.investigatingIssueIds]).toEqual(["1"]);
    expect([...queued.investigatedIssueIds]).toEqual(["1"]);

    const done = applyIssueAgentStreamEvent(queued, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "done"),
    });
    expect([...done.investigatingIssueIds]).toEqual([]);
    expect([...done.investigatedIssueIds]).toEqual(["1"]);
    expect(
      done.runsByIssue.get(IssueId.make("1"))?.get(IssueEnrichmentRunId.make("r1"))?.state,
    ).toBe("done");
  });

  it("keeps the set identity across a transcript batch that changes no membership", () => {
    const started = applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "running", { transcript: "one" }),
    });
    const grown = applyIssueAgentStreamEvent(started, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "running", { transcript: "one two" }),
    });

    expect(grown.investigatingIssueIds).toBe(started.investigatingIssueIds);
    expect(grown.investigatedIssueIds).toBe(started.investigatedIssueIds);
    expect(grown.runsByIssue).not.toBe(started.runsByIssue);
  });

  it("offers a retry after the only observed investigation failed", () => {
    const started = applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "running"),
    });
    const failed = applyIssueAgentStreamEvent(started, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "failed"),
    });

    expect([...failed.investigatedIssueIds]).toEqual([]);
  });

  it("stays marked while a second run is still queued behind the one that finished", () => {
    let state: IssueAgentState = EMPTY_ISSUE_AGENT_STATE;
    state = applyIssueAgentStreamEvent(state, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "running"),
    });
    state = applyIssueAgentStreamEvent(state, {
      _tag: "EnrichmentRunChanged",
      run: run("r2", "1", "queued", { createdAt: "2026-08-12T00:00:01.000Z" }),
    });
    state = applyIssueAgentStreamEvent(state, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "done"),
    });

    expect([...state.investigatingIssueIds]).toEqual(["1"]);
  });

  it("replaces an issue's thread links outright, because the event carries the whole list", () => {
    const linked = applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
      _tag: "IssueThreadLinksChanged",
      issueId: IssueId.make("1"),
      links: [link("1", "t1"), link("1", "t2")],
    });
    const unlinked = applyIssueAgentStreamEvent(linked, {
      _tag: "IssueThreadLinksChanged",
      issueId: IssueId.make("1"),
      links: [link("1", "t2")],
    });

    expect(unlinked.linksByIssue.get(IssueId.make("1"))?.map((each) => each.threadId)).toEqual([
      "t2",
    ]);
  });

  it("drops everything an issue owned on a hard purge, and ignores an issue it never saw", () => {
    const seeded = applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
      _tag: "EnrichmentRunChanged",
      run: run("r1", "1", "running"),
    });

    const purged = applyIssueAgentStreamEvent(seeded, {
      _tag: "IssueDeleted",
      issueId: IssueId.make("1"),
    });
    expect(purged.runsByIssue.size).toBe(0);
    expect([...purged.investigatingIssueIds]).toEqual([]);
    expect([...purged.investigatedIssueIds]).toEqual([]);

    expect(
      applyIssueAgentStreamEvent(seeded, { _tag: "IssueDeleted", issueId: IssueId.make("9") }),
    ).toBe(seeded);
  });

  it("ignores the tracker's own diffs", () => {
    expect(
      applyIssueAgentStreamEvent(EMPTY_ISSUE_AGENT_STATE, {
        _tag: "IssueUpserted",
        issue: issue("1"),
      }),
    ).toBe(EMPTY_ISSUE_AGENT_STATE);
  });
});

describe("startWorkIssuesByThread", () => {
  it("indexes start-work links and ignores manual attachments", () => {
    const first = issue("1");
    const second = issue("2");
    const manual = { ...link("2", "manual"), origin: "manual" as const };
    const issues = startWorkIssuesByThread(
      new Map([
        [first.id, first],
        [second.id, second],
      ]),
      new Map([
        [first.id, [link("1", "work")]],
        [second.id, [manual]],
      ]),
    );

    expect(issues.get(ThreadId.make("work"))?.key).toBe("PAT-1");
    expect(issues.has(ThreadId.make("manual"))).toBe(false);
  });

  it("keeps the oldest start-work issue when persisted data contains more than one", () => {
    const first = issue("1");
    const second = issue("2");
    const issues = startWorkIssuesByThread(
      new Map([
        [first.id, first],
        [second.id, second],
      ]),
      new Map([
        [first.id, [link("1", "work", "2026-08-12T00:00:02.000Z")]],
        [second.id, [link("2", "work", "2026-08-12T00:00:01.000Z")]],
      ]),
    );

    expect(issues.get(ThreadId.make("work"))?.key).toBe("PAT-2");
  });
});

describe("mergeIssueLinksForThread", () => {
  it("applies issue-side link and unlink patches to the persisted thread read", () => {
    const threadId = ThreadId.make("t1");
    const persisted = [link("1", "t1"), link("2", "t1", "2026-08-12T00:00:01.000Z")];
    const patches = new Map([
      [IssueId.make("1"), []],
      [IssueId.make("3"), [link("3", "t1", "2026-08-12T00:00:02.000Z")]],
      [IssueId.make("4"), [link("4", "another-thread")]],
    ]);

    expect(
      mergeIssueLinksForThread(persisted, patches, threadId).map((entry) => entry.issueId),
    ).toEqual(["2", "3"]);
  });
});

describe("agent diffs inside the stream state", () => {
  it("leaves the store and the detail overlays untouched when only a run moved", () => {
    const opened = applyIssuesStreamStateEvents(EMPTY_ISSUES_STREAM_STATE, [
      { _tag: "IssueUpserted", issue: issue("1") },
    ]);
    const investigating = applyIssuesStreamStateEvents(opened, [
      { _tag: "EnrichmentRunChanged", run: run("r1", "1", "running") },
    ]);

    expect(investigating.store).toBe(opened.store);
    expect(investigating.details).toBe(opened.details);
    expect(investigating.agents).not.toBe(opened.agents);
  });
});

describe("mergeIssueEnrichmentRuns", () => {
  const older = run("r1", "1", "done", { createdAt: "2026-08-12T00:00:00.000Z" });
  const newer = run("r2", "1", "running", { createdAt: "2026-08-12T00:01:00.000Z" });

  it("orders newest first and lets the live patch win over the read", () => {
    const merged = mergeIssueEnrichmentRuns(
      [newer, older],
      new Map([[newer.id, { ...newer, state: "done" as const, transcript: "final" }]]),
    );

    expect(merged.map((each) => each.id)).toEqual(["r2", "r1"]);
    expect(merged[0]?.state).toBe("done");
    expect(merged[0]?.transcript).toBe("final");
  });

  it("carries a run the read never saw, and sorts an empty patch set", () => {
    const fresh = run("r3", "1", "queued", { createdAt: "2026-08-12T00:02:00.000Z" });
    expect(
      mergeIssueEnrichmentRuns([older, newer], new Map([[fresh.id, fresh]])).map((each) => each.id),
    ).toEqual(["r3", "r2", "r1"]);
    expect(mergeIssueEnrichmentRuns([older, newer], undefined).map((each) => each.id)).toEqual([
      "r2",
      "r1",
    ]);
  });

  it("breaks a same-instant tie on the id, so the order is total", () => {
    const a = run("a", "1", "done");
    const b = run("b", "1", "done");
    expect(mergeIssueEnrichmentRuns([a, b], undefined).map((each) => each.id)).toEqual(["b", "a"]);
  });
});
