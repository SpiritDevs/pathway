import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { cloudEntityCodec, type CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import { ISSUE_KEY_DRAFT_PLACEHOLDER, type SyncEntityKind } from "@spiritdevs/contracts/cloudSync";
import { IssueId, SlackChannelWatchId, type SlackChannelWatch } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import { syncedIssueDomainFromReplica } from "../cloud/issueDomainReadModel";
import {
  EMPTY_ISSUES_STORE,
  selectIssuesStoreState,
  type IssuesStore,
  type IssuesStoreState,
} from "./issues";
import { issuesStoreFromReplica } from "./issuesFromReplica";

const JAN_1 = Date.UTC(2026, 0, 1);
const JAN_2 = Date.UTC(2026, 0, 2);
const VIEW_CONFIG = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
} as const;

function decoded(entityKind: SyncEntityKind, payload: Record<string, unknown>): CloudSyncEntity {
  const codec = cloudEntityCodec(entityKind);
  if (codec === null) throw new Error(`Missing fixture codec for ${entityKind}.`);
  return Option.getOrThrow(codec.decode(payload));
}

function replica(...entities: ReadonlyArray<CloudSyncEntity>): CompanyRegistryReplicaState {
  return {
    view: new Map(entities.map((entity, index) => [`fixture:${index}`, entity])),
  };
}

function status(input: {
  readonly id: string;
  readonly scope?: "company" | "team";
  readonly teamId?: string | null;
  readonly baseStatusId?: string | null;
  readonly name?: string | null;
  readonly color?: string | null;
  readonly category?: string | null;
  readonly position?: number | null;
  readonly hidden?: boolean;
  readonly createdAt?: number;
  readonly updatedAt?: number;
}) {
  return decoded("issueStatus", {
    scope: "company",
    teamId: null,
    baseStatusId: null,
    name: "Open",
    color: "#123456",
    category: "unstarted",
    position: 0,
    hidden: false,
    createdAt: JAN_1,
    updatedAt: JAN_2,
    ...input,
  });
}

function issue(input: {
  readonly id: string;
  readonly key: string;
  readonly keyNumber: number;
  readonly statusId: string;
  readonly triage?: boolean;
  readonly assignee?: unknown;
  readonly projectId?: string | null;
  readonly milestoneId?: string | null;
}) {
  return decoded("issue", {
    title: `Issue ${input.id}`,
    description: "",
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
    teamIds: [],
    workflowOwner: { kind: "company" },
    workModelSelection: null,
    automationAssignment: null,
    pullRequest: null,
    createdAt: JAN_1,
    updatedAt: JAN_2,
    ...input,
  });
}

function milestone(id: string, cloudProjectId: string, position: number) {
  return decoded("issueMilestone", {
    id,
    cloudProjectId,
    name: id,
    description: null,
    startDate: null,
    targetDate: null,
    position,
    createdAt: JAN_1,
    updatedAt: JAN_2,
  });
}

function cycle(id: string, startDate: string, endDate: string) {
  return decoded("issueCycle", {
    id,
    teamId: null,
    name: id,
    startDate,
    endDate,
    completedAt: null,
    createdAt: JAN_1,
    updatedAt: JAN_2,
  });
}

function view(id: string, position: number) {
  return decoded("issueView", {
    id,
    ownerMembershipId: null,
    visibility: "company",
    teamIds: [],
    name: id,
    config: VIEW_CONFIG,
    position,
    createdAt: JAN_1,
    updatedAt: JAN_2,
  });
}

const WATCH: SlackChannelWatch = {
  id: SlackChannelWatchId.make("watch-1"),
  channelId: "C123",
  channelName: "issues",
  projectId: null,
  autoInvestigate: false,
  trigger: { reactionRoutes: [], everyMessage: true, botMention: false },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const LEGACY_STORE: IssuesStore = {
  ...EMPTY_ISSUES_STORE,
  config: { keyPrefix: "OLD", nextNumber: 41 },
  slackWatches: [WATCH],
  slackStatus: {
    configured: true,
    lastPollAt: "2026-01-02T00:00:00.000Z",
    lastError: null,
    workspaceName: "Pathway",
  },
};

describe("issuesStoreFromReplica", () => {
  it("merges every team workflow into the flat status catalog", () => {
    const readModel = syncedIssueDomainFromReplica(
      replica(
        status({ id: "company-todo", position: 0 }),
        status({
          id: "company-doing",
          name: "Doing",
          color: "#abcdef",
          category: "started",
          position: 3,
        }),
        status({
          id: "team-doing",
          scope: "team",
          teamId: "team-a",
          baseStatusId: "company-doing",
          name: null,
          color: "#fedcba",
          category: null,
          position: 1,
          hidden: true,
        }),
        status({
          id: "team-review",
          scope: "team",
          teamId: "team-a",
          baseStatusId: null,
          name: "Review",
          color: "#654321",
          category: "review",
          position: 2,
        }),
      ),
    );

    const projected = issuesStoreFromReplica(readModel, LEGACY_STORE);

    expect(projected.statuses.map(({ id }) => id)).toEqual([
      "company-todo",
      "team-doing",
      "team-review",
      "company-doing",
    ]);
    expect(projected.statuses.find(({ id }) => id === "team-doing")).toMatchObject({
      name: "Doing",
      color: "#fedcba",
      category: "started",
      position: 1,
    });
  });

  it("maps issue fields, replica timestamps, nulls, project linkage, and the draft key", () => {
    const readModel = syncedIssueDomainFromReplica(
      replica(
        issue({
          id: "issue-draft",
          key: ISSUE_KEY_DRAFT_PLACEHOLDER,
          keyNumber: 0,
          statusId: "",
          triage: true,
          assignee: { kind: "member", membershipId: "membership-1" },
        }),
        issue({
          id: "issue-project",
          key: "PAT-2",
          keyNumber: 2,
          statusId: "company-todo",
          projectId: "project-b",
          milestoneId: "milestone-b",
        }),
        milestone("milestone-b", "project-b", 0),
      ),
    );

    const projected = issuesStoreFromReplica(readModel, LEGACY_STORE);
    const draft = projected.issuesById.get(IssueId.make("issue-draft"));

    expect(draft).toEqual({
      id: "issue-draft",
      key: ISSUE_KEY_DRAFT_PLACEHOLDER,
      title: "Issue issue-draft",
      description: "",
      statusId: "",
      priority: "none",
      triage: true,
      assignee: { kind: "member", membershipId: "membership-1" },
      workModelSelection: null,
      automationAssignment: null,
      pullRequest: null,
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: null,
      sortOrder: "m",
      labelIds: [],
      dueDate: null,
      slackSource: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      deletedAt: null,
    });
    expect(projected.issuesById.get(IssueId.make("issue-project"))).toMatchObject({
      projectId: "project-b",
      milestoneId: "milestone-b",
    });
    expect(projected.milestones).toContainEqual(
      expect.objectContaining({ id: "milestone-b", projectId: "project-b" }),
    );
  });

  it("matches every legacy list sort invariant and keeps stream-owned corners", () => {
    const readModel = syncedIssueDomainFromReplica(
      replica(
        decoded("issueLabel", {
          id: "label-z",
          teamId: null,
          name: "Zulu",
          color: "#123456",
          createdAt: JAN_1,
          updatedAt: JAN_2,
        }),
        decoded("issueLabel", {
          id: "label-a",
          teamId: "team-a",
          name: "Alpha",
          color: "#123456",
          createdAt: JAN_1,
          updatedAt: JAN_2,
        }),
        milestone("milestone-b2", "project-b", 2),
        milestone("milestone-a2", "project-a", 2),
        milestone("milestone-a1b", "project-a", 1),
        milestone("milestone-a1a", "project-a", 1),
        cycle("cycle-late", "2026-02-01", "2026-02-14"),
        cycle("cycle-b", "2026-01-01", "2026-01-14"),
        cycle("cycle-a", "2026-01-01", "2026-01-14"),
        view("view-b", 1),
        view("view-a", 1),
        view("view-first", 0),
      ),
    );

    const projected = issuesStoreFromReplica(readModel, LEGACY_STORE);

    expect(projected.labels.map(({ id }) => id)).toEqual(["label-a", "label-z"]);
    expect(projected.milestones.map(({ id }) => id)).toEqual([
      "milestone-a1a",
      "milestone-a1b",
      "milestone-a2",
      "milestone-b2",
    ]);
    expect(projected.cycles.map(({ id }) => id)).toEqual(["cycle-a", "cycle-b", "cycle-late"]);
    expect(projected.views.map(({ id }) => id)).toEqual(["view-first", "view-a", "view-b"]);
    expect(projected.config).toBe(LEGACY_STORE.config);
    expect(projected.slackWatches).toBe(LEGACY_STORE.slackWatches);
    expect(projected.slackStatus).toBe(LEGACY_STORE.slackStatus);
  });
});

describe("selectIssuesStoreState", () => {
  it("keeps the legacy state when no active-company replica is present", () => {
    const legacy: IssuesStoreState = { store: LEGACY_STORE, status: "loading" };
    expect(selectIssuesStoreState(legacy, null)).toBe(legacy);
  });

  it("serves a present replica as ready regardless of legacy stream status", () => {
    const legacy: IssuesStoreState = { store: LEGACY_STORE, status: "error" };
    const replicaStore = { ...LEGACY_STORE, issuesById: new Map() };
    expect(selectIssuesStoreState(legacy, replicaStore)).toEqual({
      store: replicaStore,
      status: "ready",
    });
  });
});
