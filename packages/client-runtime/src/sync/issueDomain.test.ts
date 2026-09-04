import { describe, expect, it } from "@effect/vitest";
import {
  CompanyVersion,
  ISSUE_KEY_BLOCK_SIZE,
  ISSUE_KEY_DRAFT_PLACEHOLDER,
  LocalSequence,
  SYNC_ENTITY_KINDS,
  SYNC_OPERATION_KINDS,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncActor,
  type SyncApplyOperationsResponse,
  type SyncBootstrapResponse,
  type SyncEntityKind,
  type SyncListChangesResponse,
  type SyncOperationEnvelope,
  type SyncOperationReceipt,
} from "@spiritdevs/contracts/cloudSync";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId, MembershipId, TeamId } from "@spiritdevs/contracts/company";
import {
  EnvironmentId,
  IssueId,
  IssueMilestoneId,
  IssueStatusId,
  type IssueViewConfig,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { SyncApplyOutcome } from "./adapter.ts";
import { CloudSyncCapability } from "./capability.ts";
import { makeSyncEngine } from "./engine.ts";
import {
  ISSUE_SYNC_APPEND_POSITION,
  ISSUE_SYNC_ENTITY_KINDS,
  cloudEntityCodec,
  decodeIssueSyncOperation,
  defaultIssueSortOrder,
  isIssueSyncEntityKind,
  issueEntityCodec,
  issueKeyNumber,
  issueSyncDomainAdapter,
  issueSyncOperation,
  issueSyncOperationEntityKind,
  issueSyncOperationTarget,
  makeIssueSyncAdapter,
  type CloudSyncEntity,
  type IssueEntity,
  type IssueSyncEntity,
  type IssueSyncEntityKind,
  type IssueSyncEntityOf,
  type IssueSyncOperation,
} from "./issueDomain.ts";
import { makeMemorySyncStore } from "./memoryStore.ts";
import { SYNC_INITIAL_EPOCH, syncEntityKey } from "./model.ts";
import { SyncStore } from "./persistence.ts";
import { SyncTransport } from "./transport.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const COMPANY_ID = CompanyId.make("company-issues");
const TEAM_A = TeamId.make("team-a");
const TEAM_B = TeamId.make("team-b");
const PROJECT = CloudProjectId.make("project-a");
const ENVIRONMENT = EnvironmentId.make("environment-a");
const MEMBERSHIP = MembershipId.make("membership-a");
const ACTOR: SyncActor = { kind: "member", membershipId: MEMBERSHIP };
const OTHER_ACTOR: SyncActor = {
  kind: "member",
  membershipId: MembershipId.make("membership-server"),
};
const SLACK_ACTOR: SyncActor = { kind: "system", source: "slack" };

const ISSUE_ID = SyncEntityId.make("issue-1");
const STATUS_ID = SyncEntityId.make("status-1");
const LABEL_ID = SyncEntityId.make("label-1");
const MILESTONE_ID = SyncEntityId.make("milestone-1");
const CYCLE_ID = SyncEntityId.make("cycle-1");
const TODO_ID = SyncEntityId.make("todo-1");
const RELATION_ID = SyncEntityId.make("relation-1");
const COMMENT_ID = SyncEntityId.make("comment-1");
const VIEW_ID = SyncEntityId.make("view-1");
const THREAD_LINK_ID = SyncEntityId.make("thread-link-1");

const VIEW_CONFIG: IssueViewConfig = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
};

/** Wire payloads exactly as `convex/lib/issueApply.ts` encodes them, minus `companyId`. */
const ENTITY_PAYLOADS: Record<IssueSyncEntityKind, Record<string, unknown>> = {
  issue: {
    id: "issue-1",
    key: "PAT-7",
    keyNumber: 7,
    title: "Ship the replica",
    description: "Body",
    statusId: "status-1",
    priority: "high",
    assignee: { kind: "member", membershipId: "membership-a" },
    projectId: "project-a",
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: "i0000000007",
    labelIds: ["label-1"],
    dueDate: "2026-03-01",
    triage: false,
    slackSource: null,
    teamIds: ["team-a"],
    workflowOwner: { kind: "team", teamId: "team-a" },
    workModelSelection: null,
    automationAssignment: null,
    pullRequest: null,
    createdAt: 100,
    updatedAt: 200,
  },
  issueStatus: {
    id: "status-1",
    scope: "team",
    teamId: "team-a",
    baseStatusId: null,
    name: "In review",
    color: "#3b82f6",
    category: "started",
    position: 2,
    hidden: false,
    createdAt: 100,
    updatedAt: 200,
  },
  issueLabel: {
    id: "label-1",
    teamId: null,
    name: "bug",
    color: "#ef4444",
    createdAt: 100,
    updatedAt: 200,
  },
  issueMilestone: {
    id: "milestone-1",
    cloudProjectId: "project-a",
    name: "Beta",
    description: null,
    startDate: null,
    targetDate: "2026-04-01",
    position: 1,
    createdAt: 100,
    updatedAt: 200,
  },
  issueCycle: {
    id: "cycle-1",
    teamId: "team-a",
    name: "Sprint 3",
    startDate: "2026-01-05",
    endDate: "2026-01-19",
    completedAt: null,
    createdAt: 100,
    updatedAt: 200,
  },
  issueTodo: {
    id: "todo-1",
    issueId: "issue-1",
    text: "Write the reducer",
    done: false,
    sortOrder: "n",
    createdAt: 100,
    updatedAt: 200,
  },
  issueRelation: {
    id: "relation-1",
    issueId: "issue-1",
    relatedIssueId: "issue-2",
    kind: "blocks",
    createdAt: 100,
  },
  issueComment: {
    id: "comment-1",
    issueId: "issue-1",
    body: "Looks right",
    author: { kind: "member", membershipId: "membership-a" },
    attachmentIds: ["attachment-1"],
    mentions: [],
    createdAt: 100,
    updatedAt: 200,
  },
  issueAttachment: {
    id: "attachment-1",
    issueId: "issue-1",
    commentId: "comment-1",
    fileName: "trace.log",
    mimeType: "text/plain",
    byteSize: 12,
    checksum: "abc123",
    uploadedByMembershipId: "membership-a",
    state: "finalized",
    createdAt: 100,
    updatedAt: 200,
  },
  issueView: {
    id: "view-1",
    ownerMembershipId: "membership-a",
    visibility: "teams",
    teamIds: ["team-a"],
    name: "My work",
    config: VIEW_CONFIG,
    position: 0,
    createdAt: 100,
    updatedAt: 200,
  },
  issueAuditEvent: {
    id: "audit-1",
    issueId: "issue-1",
    kind: "issue.updated",
    actor: { kind: "member", membershipId: "membership-a" },
    payload: { before: { title: "Old" }, after: { title: "New" } },
    operationId: "operation-1",
    createdAt: 100,
  },
  issueThreadLink: {
    id: "thread-link-1",
    issueId: "issue-1",
    environmentId: "environment-a",
    threadId: "thread-1",
    origin: "start-work",
    createdByMembershipId: "membership-a",
    createdAt: 100,
  },
};

function decodeFixture<K extends IssueSyncEntityKind>(kind: K): IssueSyncEntityOf<K> {
  const codec = issueEntityCodec(kind);
  if (codec === null) throw new Error(`No codec for ${kind}.`);
  const decoded = codec.decode(ENTITY_PAYLOADS[kind]);
  if (Option.isNone(decoded)) throw new Error(`The ${kind} fixture does not decode.`);
  return decoded.value as IssueSyncEntityOf<K>;
}

const ISSUE = decodeFixture("issue");
const STATUS = decodeFixture("issueStatus");
const LABEL = decodeFixture("issueLabel");
const MILESTONE = decodeFixture("issueMilestone");
const CYCLE = decodeFixture("issueCycle");
const TODO = decodeFixture("issueTodo");
const RELATION = decodeFixture("issueRelation");
const COMMENT = decodeFixture("issueComment");
const VIEW = decodeFixture("issueView");
const THREAD_LINK = decodeFixture("issueThreadLink");

const adapter = makeIssueSyncAdapter({ actor: ACTOR, now: () => 1_000 });

function appliedEntity(outcome: SyncApplyOutcome<CloudSyncEntity>): CloudSyncEntity {
  if (outcome._tag !== "Applied") {
    throw new Error(`Expected Applied, got ${outcome._tag}.`);
  }
  return outcome.entity;
}

function appliedOf<K extends IssueSyncEntityKind>(
  outcome: SyncApplyOutcome<CloudSyncEntity>,
  entityKind: K,
): IssueSyncEntityOf<K> {
  const entity = appliedEntity(outcome);
  expect(entity.entityKind).toBe(entityKind);
  return entity as IssueSyncEntityOf<K>;
}

// The adapter answers over the widened `CloudSyncEntity` because it also decodes the company
// domain's read-cache rows. Its reducer is still issues-only, so every outcome reachable from an
// issue operation is an issue entity, and the cases below stay typed as such.
const applyTo = (
  current: IssueSyncEntity | null,
  operation: IssueSyncOperation,
): SyncApplyOutcome<IssueSyncEntity> =>
  adapter.apply({ current, operation }) as SyncApplyOutcome<IssueSyncEntity>;

// ---------------------------------------------------------------------------
// Entity codecs
// ---------------------------------------------------------------------------

describe("issue entity codecs", () => {
  it("covers exactly the issue-domain tables of the protocol", () => {
    expect([...ISSUE_SYNC_ENTITY_KINDS].sort()).toEqual(
      SYNC_ENTITY_KINDS.filter((kind) => kind.startsWith("issue"))
        .slice()
        .sort(),
    );
  });

  it.each([...ISSUE_SYNC_ENTITY_KINDS])("round-trips a %s payload", (kind) => {
    const codec = issueEntityCodec(kind);
    expect(codec).not.toBeNull();
    const decoded = codec?.decode(ENTITY_PAYLOADS[kind]);
    expect(decoded === undefined || Option.isSome(decoded)).toBe(true);
    const entity = Option.getOrThrow(decoded ?? Option.none());
    expect(entity.entityKind).toBe(kind);
    // The tag is local; what goes back on the wire is the payload the server would have sent.
    expect(codec?.encode(entity)).toEqual(ENTITY_PAYLOADS[kind]);
  });

  it("ignores the company scope the wire carries and the replica does not need", () => {
    const codec = issueEntityCodec("issue");
    const decoded = codec?.decode({ ...ENTITY_PAYLOADS["issue"], companyId: "company-issues" });
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    expect(codec?.encode(Option.getOrThrow(decoded ?? Option.none()))).toEqual(
      ENTITY_PAYLOADS["issue"],
    );
  });

  it("quarantines a payload this build cannot read", () => {
    const codec = issueEntityCodec("issue");
    expect(codec?.decode({ id: "issue-1" })).toStrictEqual(Option.none());
    expect(codec?.decode({ ...ENTITY_PAYLOADS["issue"], priority: "screaming" })).toStrictEqual(
      Option.none(),
    );
  });

  it("keeps the empty status sentinel a triage issue carries", () => {
    const codec = issueEntityCodec("issue");
    const decoded = codec?.decode({ ...ENTITY_PAYLOADS["issue"], statusId: "", triage: true });
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
  });

  it("answers null for a table this domain does not replicate", () => {
    for (const kind of SYNC_ENTITY_KINDS) {
      const expected = isIssueSyncEntityKind(kind) ? "codec" : "none";
      expect(issueEntityCodec(kind) === null ? "none" : "codec").toBe(expected);
    }
    expect(issueEntityCodec("membership" satisfies SyncEntityKind)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/** One representative operation per protocol kind; the arguments are checked by kind. */
const OPERATIONS: ReadonlyArray<IssueSyncOperation> = [
  issueSyncOperation({ kind: "issue.create", entityId: ISSUE_ID, args: { title: "New issue" } }),
  issueSyncOperation({ kind: "issue.update", entityId: ISSUE_ID, args: { title: "Edited" } }),
  issueSyncOperation({ kind: "issue.delete", entityId: ISSUE_ID, args: {} }),
  issueSyncOperation({ kind: "issue.triageReject", entityId: ISSUE_ID, args: {} }),
  issueSyncOperation({ kind: "issue.restore", entityId: ISSUE_ID, args: {} }),
  issueSyncOperation({
    kind: "issue.setSortOrder",
    entityId: ISSUE_ID,
    args: { sortOrder: "n5", statusId: IssueStatusId.make("status-2") },
  }),
  issueSyncOperation({
    kind: "issue.setWorkflowOwner",
    entityId: ISSUE_ID,
    args: { workflowOwner: { kind: "team", teamId: TEAM_B } },
  }),
  issueSyncOperation({ kind: "issue.setTeams", entityId: ISSUE_ID, args: { teamIds: [TEAM_B] } }),
  issueSyncOperation({
    kind: "issueStatus.create",
    entityId: STATUS_ID,
    args: { scope: "team", teamId: TEAM_A, name: "Blocked", color: "#f59e0b" },
  }),
  issueSyncOperation({
    kind: "issueStatus.update",
    entityId: STATUS_ID,
    args: { name: "Reviewing", hidden: true },
  }),
  issueSyncOperation({
    kind: "issueStatus.delete",
    entityId: STATUS_ID,
    args: { reassignToStatusId: IssueStatusId.make("status-2") },
  }),
  issueSyncOperation({
    kind: "issueStatus.reorder",
    entityId: STATUS_ID,
    args: {
      statusIds: [IssueStatusId.make("status-2"), IssueStatusId.make("status-1")],
    },
  }),
  issueSyncOperation({
    kind: "issueLabel.create",
    entityId: LABEL_ID,
    args: { name: "regression", color: "#ef4444", teamId: TEAM_A },
  }),
  issueSyncOperation({ kind: "issueLabel.update", entityId: LABEL_ID, args: { name: "defect" } }),
  issueSyncOperation({ kind: "issueLabel.delete", entityId: LABEL_ID, args: {} }),
  issueSyncOperation({
    kind: "issueMilestone.create",
    entityId: MILESTONE_ID,
    args: { cloudProjectId: PROJECT, name: "GA", targetDate: "2026-06-01" },
  }),
  issueSyncOperation({
    kind: "issueMilestone.update",
    entityId: MILESTONE_ID,
    args: { name: "GA cut", description: null },
  }),
  issueSyncOperation({ kind: "issueMilestone.delete", entityId: MILESTONE_ID, args: {} }),
  issueSyncOperation({
    kind: "issueCycle.create",
    entityId: CYCLE_ID,
    args: { name: "Sprint 4", startDate: "2026-02-02", endDate: "2026-02-16", teamId: TEAM_A },
  }),
  issueSyncOperation({
    kind: "issueCycle.update",
    entityId: CYCLE_ID,
    args: { endDate: "2026-02-23" },
  }),
  issueSyncOperation({ kind: "issueCycle.delete", entityId: CYCLE_ID, args: {} }),
  issueSyncOperation({
    kind: "issueTodo.create",
    entityId: TODO_ID,
    args: { issueId: IssueId.make("issue-1"), text: "Add tests" },
  }),
  issueSyncOperation({ kind: "issueTodo.update", entityId: TODO_ID, args: { done: true } }),
  issueSyncOperation({ kind: "issueTodo.delete", entityId: TODO_ID, args: {} }),
  issueSyncOperation({
    kind: "issueRelation.create",
    entityId: RELATION_ID,
    args: {
      issueId: IssueId.make("issue-1"),
      relatedIssueId: IssueId.make("issue-2"),
      kind: "relates",
    },
  }),
  issueSyncOperation({ kind: "issueRelation.delete", entityId: RELATION_ID, args: {} }),
  issueSyncOperation({
    kind: "issueComment.create",
    entityId: COMMENT_ID,
    args: { issueId: IssueId.make("issue-1"), body: "Shipping this" },
  }),
  issueSyncOperation({
    kind: "issueComment.update",
    entityId: COMMENT_ID,
    args: { body: "Shipping this today" },
  }),
  issueSyncOperation({ kind: "issueComment.delete", entityId: COMMENT_ID, args: {} }),
  issueSyncOperation({
    kind: "issueView.create",
    entityId: VIEW_ID,
    args: { name: "Team board", config: VIEW_CONFIG, visibility: "teams", teamIds: [TEAM_A] },
  }),
  issueSyncOperation({
    kind: "issueView.update",
    entityId: VIEW_ID,
    args: { visibility: "private" },
  }),
  issueSyncOperation({ kind: "issueView.delete", entityId: VIEW_ID, args: {} }),
  issueSyncOperation({
    kind: "issueThreadLink.create",
    entityId: THREAD_LINK_ID,
    args: {
      issueId: IssueId.make("issue-1"),
      environmentId: ENVIRONMENT,
      threadId: "thread-9",
      origin: "start-work",
    },
  }),
  issueSyncOperation({ kind: "issueThreadLink.delete", entityId: THREAD_LINK_ID, args: {} }),
];

const envelopeFor = (operation: IssueSyncOperation): SyncOperationEnvelope => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make(`operation-${operation.kind}`),
  companyId: COMPANY_ID,
  clientId: SyncClientId.make("client-a"),
  environmentId: null,
  actor: ACTOR,
  localSequence: LocalSequence.make(1),
  baseVersion: CompanyVersion.make(0),
  entityId: operation.entityId,
  dependsOn: operation.dependsOn ?? [],
  kind: adapter.operationKind(operation),
  args: adapter.operationCodec.encode(operation),
});

describe("issue operations", () => {
  it("has one representative operation for every protocol kind", () => {
    expect(OPERATIONS.map((operation) => operation.kind).sort()).toEqual(
      SYNC_OPERATION_KINDS.slice().sort(),
    );
  });

  it.each(OPERATIONS.map((operation) => [operation.kind, operation] as const))(
    "round-trips %s through an envelope",
    (_kind, operation) => {
      const envelope = envelopeFor(operation);
      expect(envelope.kind).toBe(operation.kind);
      const decoded = decodeIssueSyncOperation(envelope);
      expect(Option.isSome(decoded)).toBe(true);
      expect(Option.getOrThrow(decoded)).toEqual({
        kind: operation.kind,
        entityId: operation.entityId,
        args: operation.args,
      });
    },
  );

  it.each(OPERATIONS.map((operation) => [operation.kind, operation] as const))(
    "targets the table named by %s",
    (kind, operation) => {
      const target = issueSyncOperationTarget(operation);
      expect(target.entityId).toBe(operation.entityId);
      expect(isIssueSyncEntityKind(target.entityKind)).toBe(true);
      expect(target.entityKind).toBe(kind.slice(0, kind.indexOf(".")));
      expect(issueSyncOperationEntityKind(kind)).toBe(target.entityKind);
    },
  );

  it("ships a ready-made adapter for the issues domain", () => {
    expect(issueSyncDomainAdapter.domain).toBe("issues");
    const create = OPERATIONS[0] as IssueSyncOperation;
    expect(issueSyncDomainAdapter.operationKind(create)).toBe("issue.create");
    expect(issueSyncDomainAdapter.operationTarget(create)).toEqual({
      entityKind: "issue",
      entityId: ISSUE_ID,
    });
  });

  it("keeps the arguments codec out of the kind-guessing business", () => {
    // Nine deletes, one restore, and every no-op patch all encode to `{}`; a codec handed only
    // those bytes must not pretend it knows which operation they came from.
    expect(adapter.operationCodec.decode({})).toStrictEqual(Option.none());
  });

  it("recovers dependencies from the envelope", () => {
    const dependency = SyncOperationId.make("operation-create");
    const operation = issueSyncOperation({
      kind: "issueTodo.create",
      entityId: TODO_ID,
      args: { issueId: IssueId.make("issue-1"), text: "Add tests" },
      dependsOn: [dependency],
    });
    expect(adapter.operationDependencies?.(operation)).toEqual([dependency]);
    const decoded = decodeIssueSyncOperation(envelopeFor(operation));
    expect(Option.getOrThrow(decoded).dependsOn).toEqual([dependency]);
  });

  it("refuses an envelope this build cannot read", () => {
    const envelope = envelopeFor(OPERATIONS[0] as IssueSyncOperation);
    expect(decodeIssueSyncOperation({ ...envelope, args: { title: "" } })).toStrictEqual(
      Option.none(),
    );
    expect(
      decodeIssueSyncOperation({
        ...envelope,
        kind: "issue.explode" as SyncOperationEnvelope["kind"],
        args: {},
      }),
    ).toStrictEqual(Option.none());
  });
});

// ---------------------------------------------------------------------------
// apply: one case per operation kind
// ---------------------------------------------------------------------------

interface ApplyCase {
  readonly kind: IssueSyncOperation["kind"];
  readonly current: IssueSyncEntity | null;
  readonly operation: IssueSyncOperation;
  readonly check: (outcome: SyncApplyOutcome<IssueSyncEntity>) => void;
}

const applyCases: ReadonlyArray<ApplyCase> = [
  {
    kind: "issue.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issue.create",
      entityId: ISSUE_ID,
      args: {
        title: "New issue",
        key: "PAT-9",
        teamIds: [TEAM_A],
        labelIds: [],
        triage: true,
        slackSource: {
          issueId: IssueId.make(ISSUE_ID),
          channelId: "C1",
          messageTs: "1723459200.001900",
          permalink: null,
          authorName: "Corey",
        },
      },
    }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      expect(issue.id).toBe("issue-1");
      expect(issue.key).toBe("PAT-9");
      expect(issue.keyNumber).toBe(9);
      expect(issue.sortOrder).toBe(defaultIssueSortOrder(9));
      expect(issue.statusId).toBe("");
      expect(issue.priority).toBe("none");
      expect(issue.workflowOwner).toEqual({ kind: "company" });
      expect(issue.teamIds).toEqual([TEAM_A]);
      expect(issue.slackSource?.messageTs).toBe("1723459200.001900");
      expect(issue.createdAt).toBe(1_000);
    },
  },
  {
    kind: "issue.update",
    current: ISSUE,
    operation: issueSyncOperation({
      kind: "issue.update",
      entityId: ISSUE_ID,
      args: { description: "Rewritten", assignee: null },
    }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      // Different fields merge: the title the patch never mentioned survives.
      expect(issue.title).toBe(ISSUE.title);
      expect(issue.description).toBe("Rewritten");
      expect(issue.assignee).toBeNull();
      expect(issue.updatedAt).toBe(1_000);
    },
  },
  {
    kind: "issue.delete",
    current: ISSUE,
    operation: issueSyncOperation({ kind: "issue.delete", entityId: ISSUE_ID, args: {} }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      expect(issue.deletedAt).toBe(1_000);
      expect(issue.updatedAt).toBe(1_000);
    },
  },
  {
    kind: "issue.triageReject",
    current: ISSUE,
    operation: issueSyncOperation({ kind: "issue.triageReject", entityId: ISSUE_ID, args: {} }),
    check: (outcome) => expect(appliedOf(outcome, "issue").deletedAt).toBe(1_000),
  },
  {
    kind: "issue.restore",
    current: null,
    operation: issueSyncOperation({ kind: "issue.restore", entityId: ISSUE_ID, args: {} }),
    // Not `Blocked`: a blocked operation is never sent, and only the server can restore.
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issue.setSortOrder",
    current: ISSUE,
    operation: issueSyncOperation({
      kind: "issue.setSortOrder",
      entityId: ISSUE_ID,
      args: { sortOrder: "n5", statusId: IssueStatusId.make("status-2") },
    }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      expect(issue.sortOrder).toBe("n5");
      expect(issue.statusId).toBe("status-2");
    },
  },
  {
    kind: "issue.setWorkflowOwner",
    current: ISSUE,
    operation: issueSyncOperation({
      kind: "issue.setWorkflowOwner",
      entityId: ISSUE_ID,
      args: { workflowOwner: { kind: "company" } },
    }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      expect(issue.workflowOwner).toEqual({ kind: "company" });
      // The client cannot pick the matching status in the target workflow; the server's choice
      // arrives with the accepted change.
      expect(issue.statusId).toBe(ISSUE.statusId);
    },
  },
  {
    kind: "issue.setTeams",
    current: ISSUE,
    operation: issueSyncOperation({
      kind: "issue.setTeams",
      entityId: ISSUE_ID,
      args: { teamIds: [TEAM_B] },
    }),
    check: (outcome) => {
      const issue = appliedOf(outcome, "issue");
      expect(issue.teamIds).toEqual([TEAM_B]);
      // Detaching the owning team drops workflow ownership back to the company chain.
      expect(issue.workflowOwner).toEqual({ kind: "company" });
    },
  },
  {
    kind: "issueStatus.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueStatus.create",
      entityId: STATUS_ID,
      args: { scope: "team", teamId: TEAM_A, name: "Blocked", color: "#f59e0b" },
    }),
    check: (outcome) => {
      const status = appliedOf(outcome, "issueStatus");
      expect(status.scope).toBe("team");
      expect(status.teamId).toBe(TEAM_A);
      expect(status.name).toBe("Blocked");
      expect(status.category).toBeNull();
      expect(status.position).toBeNull();
      expect(status.hidden).toBe(false);
    },
  },
  {
    kind: "issueStatus.update",
    current: STATUS,
    operation: issueSyncOperation({
      kind: "issueStatus.update",
      entityId: STATUS_ID,
      args: { name: null, hidden: true },
    }),
    check: (outcome) => {
      const status = appliedOf(outcome, "issueStatus");
      // Explicit null clears an override so the inherited base supplies the field again.
      expect(status.name).toBeNull();
      expect(status.hidden).toBe(true);
      expect(status.color).toBe(STATUS.color);
    },
  },
  {
    kind: "issueStatus.delete",
    current: STATUS,
    operation: issueSyncOperation({
      kind: "issueStatus.delete",
      entityId: STATUS_ID,
      args: { reassignToStatusId: IssueStatusId.make("status-2") },
    }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueStatus.reorder",
    current: STATUS,
    operation: issueSyncOperation({
      kind: "issueStatus.reorder",
      entityId: STATUS_ID,
      args: { statusIds: [IssueStatusId.make("status-2"), IssueStatusId.make("status-1")] },
    }),
    check: (outcome) => {
      const status = appliedOf(outcome, "issueStatus");
      expect(status.position).toBe(1);
    },
  },
  {
    kind: "issueLabel.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueLabel.create",
      entityId: LABEL_ID,
      args: { name: "regression", color: "#ef4444" },
    }),
    check: (outcome) => {
      const label = appliedOf(outcome, "issueLabel");
      expect(label.name).toBe("regression");
      expect(label.teamId).toBeNull();
    },
  },
  {
    kind: "issueLabel.update",
    current: LABEL,
    operation: issueSyncOperation({
      kind: "issueLabel.update",
      entityId: LABEL_ID,
      args: { color: "#22c55e" },
    }),
    check: (outcome) => {
      const label = appliedOf(outcome, "issueLabel");
      expect(label.color).toBe("#22c55e");
      expect(label.name).toBe(LABEL.name);
    },
  },
  {
    kind: "issueLabel.delete",
    current: LABEL,
    operation: issueSyncOperation({ kind: "issueLabel.delete", entityId: LABEL_ID, args: {} }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueMilestone.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueMilestone.create",
      entityId: MILESTONE_ID,
      args: { cloudProjectId: PROJECT, name: "GA" },
    }),
    check: (outcome) => {
      const milestone = appliedOf(outcome, "issueMilestone");
      expect(milestone.cloudProjectId).toBe(PROJECT);
      expect(milestone.description).toBeNull();
      expect(milestone.position).toBe(ISSUE_SYNC_APPEND_POSITION);
    },
  },
  {
    kind: "issueMilestone.update",
    current: MILESTONE,
    operation: issueSyncOperation({
      kind: "issueMilestone.update",
      entityId: MILESTONE_ID,
      args: { targetDate: null, position: 4 },
    }),
    check: (outcome) => {
      const milestone = appliedOf(outcome, "issueMilestone");
      expect(milestone.targetDate).toBeNull();
      expect(milestone.position).toBe(4);
      expect(milestone.name).toBe(MILESTONE.name);
    },
  },
  {
    kind: "issueMilestone.delete",
    current: MILESTONE,
    operation: issueSyncOperation({
      kind: "issueMilestone.delete",
      entityId: MILESTONE_ID,
      args: {},
    }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueCycle.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueCycle.create",
      entityId: CYCLE_ID,
      args: { name: "Sprint 4", startDate: "2026-02-02", endDate: "2026-02-16" },
    }),
    check: (outcome) => {
      const cycle = appliedOf(outcome, "issueCycle");
      expect(cycle.startDate).toBe("2026-02-02");
      expect(cycle.completedAt).toBeNull();
      expect(cycle.teamId).toBeNull();
    },
  },
  {
    kind: "issueCycle.update",
    current: CYCLE,
    operation: issueSyncOperation({
      kind: "issueCycle.update",
      entityId: CYCLE_ID,
      args: { endDate: "2026-02-23" },
    }),
    check: (outcome) => {
      const cycle = appliedOf(outcome, "issueCycle");
      expect(cycle.endDate).toBe("2026-02-23");
      expect(cycle.startDate).toBe(CYCLE.startDate);
    },
  },
  {
    kind: "issueCycle.delete",
    current: CYCLE,
    operation: issueSyncOperation({ kind: "issueCycle.delete", entityId: CYCLE_ID, args: {} }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueTodo.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueTodo.create",
      entityId: TODO_ID,
      args: { issueId: IssueId.make("issue-1"), text: "Add tests", sortOrder: "n5" },
    }),
    check: (outcome) => {
      const todo = appliedOf(outcome, "issueTodo");
      expect(todo.issueId).toBe("issue-1");
      expect(todo.done).toBe(false);
      expect(todo.sortOrder).toBe("n5");
    },
  },
  {
    kind: "issueTodo.update",
    current: TODO,
    operation: issueSyncOperation({
      kind: "issueTodo.update",
      entityId: TODO_ID,
      args: { done: true },
    }),
    check: (outcome) => {
      const todo = appliedOf(outcome, "issueTodo");
      expect(todo.done).toBe(true);
      expect(todo.text).toBe(TODO.text);
    },
  },
  {
    kind: "issueTodo.delete",
    current: TODO,
    operation: issueSyncOperation({ kind: "issueTodo.delete", entityId: TODO_ID, args: {} }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueRelation.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueRelation.create",
      entityId: RELATION_ID,
      args: {
        issueId: IssueId.make("issue-1"),
        relatedIssueId: IssueId.make("issue-2"),
        kind: "duplicate",
      },
    }),
    check: (outcome) => {
      const relation = appliedOf(outcome, "issueRelation");
      expect(relation.kind).toBe("duplicate");
      expect(relation.relatedIssueId).toBe("issue-2");
      expect(relation.createdAt).toBe(1_000);
    },
  },
  {
    kind: "issueRelation.delete",
    current: RELATION,
    operation: issueSyncOperation({
      kind: "issueRelation.delete",
      entityId: RELATION_ID,
      args: {},
    }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueComment.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueComment.create",
      entityId: COMMENT_ID,
      args: { issueId: IssueId.make("issue-1"), body: "Shipping this" },
    }),
    check: (outcome) => {
      const comment = appliedOf(outcome, "issueComment");
      expect(comment.body).toBe("Shipping this");
      expect(comment.author).toEqual(ACTOR);
      expect(comment.attachmentIds).toEqual([]);
      expect(comment.mentions).toEqual([]);
    },
  },
  {
    kind: "issueComment.update",
    current: COMMENT,
    operation: issueSyncOperation({
      kind: "issueComment.update",
      entityId: COMMENT_ID,
      args: { body: "Shipped" },
    }),
    check: (outcome) => {
      const comment = appliedOf(outcome, "issueComment");
      expect(comment.body).toBe("Shipped");
      expect(comment.attachmentIds).toEqual(COMMENT.attachmentIds);
      expect(comment.updatedAt).toBe(1_000);
    },
  },
  {
    kind: "issueComment.delete",
    current: COMMENT,
    operation: issueSyncOperation({ kind: "issueComment.delete", entityId: COMMENT_ID, args: {} }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueView.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueView.create",
      entityId: VIEW_ID,
      args: { name: "Team board", config: VIEW_CONFIG, visibility: "teams", teamIds: [TEAM_A] },
    }),
    check: (outcome) => {
      const view = appliedOf(outcome, "issueView");
      expect(view.ownerMembershipId).toBe(MEMBERSHIP);
      expect(view.visibility).toBe("teams");
      expect(view.teamIds).toEqual([TEAM_A]);
      expect(view.position).toBe(0);
    },
  },
  {
    kind: "issueView.update",
    current: VIEW,
    operation: issueSyncOperation({
      kind: "issueView.update",
      entityId: VIEW_ID,
      args: { visibility: "private" },
    }),
    check: (outcome) => {
      const view = appliedOf(outcome, "issueView");
      expect(view.visibility).toBe("private");
      // Leaving `teams` visibility drops the audience.
      expect(view.teamIds).toEqual([]);
      expect(view.config).toEqual(VIEW.config);
    },
  },
  {
    kind: "issueView.delete",
    current: VIEW,
    operation: issueSyncOperation({ kind: "issueView.delete", entityId: VIEW_ID, args: {} }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
  {
    kind: "issueThreadLink.create",
    current: null,
    operation: issueSyncOperation({
      kind: "issueThreadLink.create",
      entityId: THREAD_LINK_ID,
      args: {
        issueId: IssueId.make("issue-1"),
        environmentId: ENVIRONMENT,
        threadId: "thread-9",
        origin: "mention",
      },
    }),
    check: (outcome) => {
      const link = appliedOf(outcome, "issueThreadLink");
      expect(link.threadId).toBe("thread-9");
      expect(link.origin).toBe("mention");
      expect(link.createdByMembershipId).toBe(MEMBERSHIP);
    },
  },
  {
    kind: "issueThreadLink.delete",
    current: THREAD_LINK,
    operation: issueSyncOperation({
      kind: "issueThreadLink.delete",
      entityId: THREAD_LINK_ID,
      args: {},
    }),
    check: (outcome) => expect(outcome._tag).toBe("Deleted"),
  },
];

describe("issue apply", () => {
  it("covers every protocol operation kind", () => {
    expect(applyCases.map((testCase) => testCase.kind).sort()).toEqual(
      SYNC_OPERATION_KINDS.slice().sort(),
    );
  });

  it.each(applyCases.map((testCase) => [testCase.kind, testCase] as const))(
    "applies %s",
    (_kind, testCase) => {
      testCase.check(applyTo(testCase.current, testCase.operation));
    },
  );

  it("restores a soft-deleted issue optimistically", () => {
    const outcome = applyTo(
      { ...ISSUE, deletedAt: 500 },
      issueSyncOperation({ kind: "issue.restore", entityId: ISSUE_ID, args: {} }),
    );
    expect(appliedOf(outcome, "issue").deletedAt).toBeNull();
  });

  const updateOperations = OPERATIONS.filter(
    (operation) =>
      operation.kind.endsWith(".update") ||
      operation.kind === "issue.setSortOrder" ||
      operation.kind === "issue.setWorkflowOwner" ||
      operation.kind === "issue.setTeams" ||
      operation.kind === "issueStatus.reorder",
  );

  it.each(updateOperations.map((operation) => [operation.kind, operation] as const))(
    "blocks %s against a tombstoned row",
    (_kind, operation) => {
      const outcome = applyTo(null, operation);
      expect(outcome._tag).toBe("Blocked");
      if (outcome._tag === "Blocked") {
        expect(outcome.reason).toMatch(/deleted before the change applied/);
      }
    },
  );

  it.each(updateOperations.map((operation) => [operation.kind, operation] as const))(
    "treats a row of another kind as missing for %s",
    (_kind, operation) => {
      // The engine keys the overlay by kind and id, so this only happens if a codec lied; the
      // reducer still refuses to write one table's shape over another's.
      const foreign = operation.kind.startsWith("issue.") ? LABEL : ISSUE;
      expect(applyTo(foreign, operation)._tag).toBe("Blocked");
    },
  );

  const createOperations = OPERATIONS.filter((operation) => operation.kind.endsWith(".create"));

  it.each(createOperations.map((operation) => [operation.kind, operation] as const))(
    "makes %s idempotent over an existing row",
    (kind, operation) => {
      const existing: IssueSyncEntity =
        kind === "issue.create"
          ? ISSUE
          : kind === "issueStatus.create"
            ? STATUS
            : kind === "issueLabel.create"
              ? LABEL
              : kind === "issueMilestone.create"
                ? MILESTONE
                : kind === "issueCycle.create"
                  ? CYCLE
                  : kind === "issueTodo.create"
                    ? TODO
                    : kind === "issueRelation.create"
                      ? RELATION
                      : kind === "issueComment.create"
                        ? COMMENT
                        : kind === "issueView.create"
                          ? VIEW
                          : THREAD_LINK;
      // An acknowledged create replays over its own confirmed row until the cursor covers it.
      expect(applyTo(existing, operation)).toStrictEqual({ _tag: "Applied", entity: existing });
    },
  );

  const deleteOperations = OPERATIONS.filter((operation) => operation.kind.endsWith(".delete"));

  it.each(deleteOperations.map((operation) => [operation.kind, operation] as const))(
    "tombstones on %s even when the row is already gone",
    (_kind, operation) => {
      expect(applyTo(null, operation)._tag).toBe("Deleted");
    },
  );

  it("shows a draft key until Convex assigns one", () => {
    const issue = appliedOf(
      applyTo(
        null,
        issueSyncOperation({
          kind: "issue.create",
          entityId: ISSUE_ID,
          args: { title: "Offline" },
        }),
      ),
      "issue",
    );
    expect(issue.key).toBe(ISSUE_KEY_DRAFT_PLACEHOLDER);
    expect(issue.keyNumber).toBe(0);
    expect(issueKeyNumber(ISSUE_KEY_DRAFT_PLACEHOLDER)).toBe(0);
    expect(issueKeyNumber("PAT-221")).toBe(221);
  });

  it("optimistically marks a server-finalized cycle complete", () => {
    const cycle = appliedOf(
      applyTo(
        CYCLE,
        issueSyncOperation({
          kind: "issueCycle.update",
          entityId: CYCLE_ID,
          args: { finalize: true },
        }),
      ),
      "issueCycle",
    );
    expect(cycle.completedAt).toBe(1_000);
  });

  it("places an unpositioned milestone where the server's append will place it", () => {
    // `issueMilestoneCreate` (convex/lib/issueApply.ts) appends: the project's highest position
    // plus one. The reducer sees one entity, so it cannot read that index — what it can do is sort
    // the pending row last, which is where the append lands it. The two placements must agree, or
    // the card moves when the accepted change arrives.
    const timeline = [0, 1, 2].map((position) => ({
      ...MILESTONE,
      id: IssueMilestoneId.make(`milestone-at-${position}`),
      position,
    }));
    const create = issueSyncOperation({
      kind: "issueMilestone.create",
      entityId: MILESTONE_ID,
      args: { cloudProjectId: PROJECT, name: "GA" },
    });
    const optimistic = appliedOf(applyTo(null, create), "issueMilestone");
    const confirmed = {
      ...optimistic,
      position: Math.max(...timeline.map((row) => row.position)) + 1,
    };
    const placement = (row: typeof confirmed) =>
      [...timeline, row]
        .sort((a, b) => a.position - b.position)
        .findIndex((candidate) => candidate.id === row.id);

    expect(placement(optimistic)).toBe(timeline.length);
    expect(placement(optimistic)).toBe(placement(confirmed));
    // An explicit position is still the caller's to choose, as it is on the server.
    const positioned = appliedOf(
      applyTo(
        null,
        issueSyncOperation({
          kind: "issueMilestone.create",
          entityId: MILESTONE_ID,
          args: { cloudProjectId: PROJECT, name: "GA", position: 1 },
        }),
      ),
      "issueMilestone",
    );
    expect(positioned.position).toBe(1);
  });

  it("merges two offline edits to different fields", () => {
    const first = appliedOf(
      applyTo(
        ISSUE,
        issueSyncOperation({
          kind: "issue.update",
          entityId: ISSUE_ID,
          args: { title: "Renamed" },
        }),
      ),
      "issue",
    );
    const second = appliedOf(
      applyTo(
        first,
        issueSyncOperation({
          kind: "issue.update",
          entityId: ISSUE_ID,
          args: { priority: "urgent" },
        }),
      ),
      "issue",
    );
    expect(second.title).toBe("Renamed");
    expect(second.priority).toBe("urgent");
  });

  it("attributes nothing when the adapter was built without an actor", () => {
    const anonymous = makeIssueSyncAdapter();
    const outcome = anonymous.apply({
      current: null,
      operation: issueSyncOperation({
        kind: "issueComment.create",
        entityId: COMMENT_ID,
        args: { issueId: IssueId.make("issue-1"), body: "Anonymous" },
      }),
    });
    const comment = appliedOf(outcome, "issueComment");
    expect(comment.author).toBeNull();
    expect(comment.createdAt).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Engine smoke: a minimal in-memory issue server
// ---------------------------------------------------------------------------

const SERVER_NOW = 5_000;

interface ServerChange {
  readonly version: CompanyVersion;
  readonly entityKind: SyncEntityKind;
  readonly entityId: SyncEntityId;
  readonly entity: CloudSyncEntity | null;
}

/**
 * Convex's role in one file: decode the envelope, run the same reducer the client ran, append a
 * whole-entity change, and answer with a receipt. `makeTestSyncServer` is note-domain-specific, so
 * the issue domain needs its own.
 */
const makeIssueSyncServer = Effect.fn("makeIssueSyncServer")(function* () {
  const server = makeIssueSyncAdapter({ actor: OTHER_ACTOR, now: () => SERVER_NOW });
  const entities = yield* Ref.make(new Map<string, CloudSyncEntity>());
  const changes = yield* Ref.make<ReadonlyArray<ServerChange>>([]);
  const receipts = yield* Ref.make(new Map<SyncOperationId, SyncOperationReceipt>());
  const version = yield* Ref.make(CompanyVersion.make(0));

  const applyOne = Effect.fn("IssueSyncServer.applyOne")(function* (
    envelope: SyncOperationEnvelope,
  ) {
    const known = (yield* Ref.get(receipts)).get(envelope.operationId);
    if (known !== undefined) return { ...known, duplicate: true } satisfies SyncOperationReceipt;

    const decoded = decodeIssueSyncOperation(envelope);
    if (Option.isNone(decoded)) {
      return {
        operationId: envelope.operationId,
        status: "rejected",
        duplicate: false,
        code: "invalid-arguments",
        message: "Unreadable operation.",
      } satisfies SyncOperationReceipt;
    }
    const operation = decoded.value;
    const target = issueSyncOperationTarget(operation);
    const key = syncEntityKey(target);
    const outcome = server.apply({
      current: (yield* Ref.get(entities)).get(key) ?? null,
      operation,
    });

    const record = (receipt: SyncOperationReceipt) =>
      Ref.update(receipts, (current) => new Map(current).set(envelope.operationId, receipt));

    if (outcome._tag === "Blocked") {
      const receipt: SyncOperationReceipt = {
        operationId: envelope.operationId,
        status: "rejected",
        duplicate: false,
        code: "entity-deleted",
        message: outcome.reason,
      };
      yield* record(receipt);
      return receipt;
    }

    const next = CompanyVersion.make((yield* Ref.get(version)) + 1);
    yield* Ref.set(version, next);
    yield* Ref.update(entities, (current) => {
      const updated = new Map(current);
      if (outcome._tag === "Deleted") updated.delete(key);
      else updated.set(key, outcome.entity);
      return updated;
    });
    yield* Ref.update(changes, (current) => [
      ...current,
      {
        version: next,
        entityKind: target.entityKind,
        entityId: target.entityId,
        entity: outcome._tag === "Deleted" ? null : outcome.entity,
      },
    ]);
    const receipt: SyncOperationReceipt = {
      operationId: envelope.operationId,
      status: "accepted",
      duplicate: false,
      firstVersion: next,
      lastVersion: next,
    };
    yield* record(receipt);
    return receipt;
  });

  const encodePayload = (change: ServerChange): unknown =>
    change.entity === null
      ? null
      : (cloudEntityCodec(change.entityKind)?.encode(change.entity) ?? null);

  const transport = SyncTransport.of({
    bootstrap: () =>
      Effect.gen(function* () {
        const current = yield* Ref.get(version);
        const rows = yield* Ref.get(changes);
        const live = yield* Ref.get(entities);
        return {
          version: current,
          authorizationEpoch: SYNC_INITIAL_EPOCH,
          entities: [...live.keys()].flatMap((key) => {
            const last = rows.findLast((change) => syncEntityKey(change) === key);
            return last === undefined || last.entity === null
              ? []
              : [
                  {
                    version: last.version,
                    entityKind: last.entityKind,
                    entityId: last.entityId,
                    changeKind: "upsert" as const,
                    payload: encodePayload(last),
                  },
                ];
          }),
          cursor: null,
          isDone: true,
        } satisfies SyncBootstrapResponse;
      }),
    latestVersion: () => Stream.empty,
    listChanges: (input) =>
      Effect.gen(function* () {
        const rows = yield* Ref.get(changes);
        const current = yield* Ref.get(version);
        const window = rows.filter((change) => change.version > input.cursor);
        return {
          _tag: "Changes",
          changes: window.map((change) => ({
            version: change.version,
            entityKind: change.entityKind,
            entityId: change.entityId,
            changeKind: change.entity === null ? ("tombstone" as const) : ("upsert" as const),
            payload: encodePayload(change),
          })),
          cursor: window.at(-1)?.version ?? input.cursor,
          hasMore: false,
          latestVersion: current,
          authorizationEpoch: SYNC_INITIAL_EPOCH,
        } satisfies SyncListChangesResponse;
      }),
    applyOperations: (input) =>
      Effect.gen(function* () {
        const versionFrom = yield* Ref.get(version);
        const answers: Array<SyncOperationReceipt> = [];
        for (const envelope of input.operations) answers.push(yield* applyOne(envelope));
        return {
          receipts: answers,
          versionFrom,
          versionTo: yield* Ref.get(version),
          authorizationEpoch: SYNC_INITIAL_EPOCH,
        } satisfies SyncApplyOperationsResponse;
      }),
    reserveIssueKeys: (input) =>
      Effect.succeed({
        prefix: "PAT",
        blockStart: 1,
        blockEnd: input.blockSize ?? ISSUE_KEY_BLOCK_SIZE,
        firstKey: "PAT-1",
      }),
  });

  return {
    transport,
    entity: (kind: IssueSyncEntityKind, entityId: SyncEntityId) =>
      Ref.get(entities).pipe(
        Effect.map((current) => current.get(syncEntityKey({ entityKind: kind, entityId })) ?? null),
      ),
    receipt: (operationId: SyncOperationId) =>
      Ref.get(receipts).pipe(Effect.map((current) => current.get(operationId) ?? null)),
  };
});

/**
 * What an optimistic row is stamped with in these tests. The engine reads the ambient clock once
 * per enqueue and replays that value, so the harness pins the clock there; the adapter's own
 * `now` agrees, which keeps the expected value the same whichever of the two answered.
 */
const ENQUEUED_AT = 1_000;

const makeHarness = Effect.fn("makeHarness")(function* () {
  yield* TestClock.setTime(ENQUEUED_AT);
  const store = yield* makeMemorySyncStore();
  const server = yield* makeIssueSyncServer();
  const layer = Layer.mergeAll(
    Layer.succeed(SyncStore, store.service),
    Layer.succeed(SyncTransport, server.transport),
  );
  return { store, server, layer };
});

const openEngine = (clientId: string) =>
  makeSyncEngine({
    companyId: COMPANY_ID,
    clientId: SyncClientId.make(clientId),
    actor: ACTOR,
    adapter: makeIssueSyncAdapter({ actor: ACTOR, now: () => ENQUEUED_AT }),
  });

const ENABLED = { enabled: true } as const;
const issueKey = syncEntityKey({ entityKind: "issue", entityId: ISSUE_ID });
const todoKey = syncEntityKey({ entityKind: "issueTodo", entityId: TODO_ID });
const labelKey = syncEntityKey({ entityKind: "issueLabel", entityId: LABEL_ID });

describe("issue domain on the sync engine", () => {
  it.effect("renders an optimistic create, then converges on the accepted row", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        const createId = SyncOperationId.make("operation-create");
        yield* engine.enqueue({
          operationId: createId,
          operation: issueSyncOperation({
            kind: "issue.create",
            entityId: ISSUE_ID,
            args: { title: "Offline first", teamIds: [TEAM_A] },
          }),
        });
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-todo"),
          operation: issueSyncOperation({
            kind: "issueTodo.create",
            entityId: TODO_ID,
            args: { issueId: IssueId.make("issue-1"), text: "Write it down" },
            dependsOn: [createId],
          }),
        });

        const optimistic = yield* SubscriptionRef.get(engine.state);
        expect(optimistic.view.get(issueKey)).toMatchObject({
          entityKind: "issue",
          title: "Offline first",
          key: ISSUE_KEY_DRAFT_PLACEHOLDER,
          createdAt: ENQUEUED_AT,
        });
        expect(optimistic.view.has(todoKey)).toBe(true);
        expect(optimistic.confirmed.size).toBe(0);

        const receipt = yield* engine.sync;
        expect(receipt.acceptedOperations).toBe(2);
        expect(receipt.rejectedOperations).toBe(0);

        expect(yield* harness.server.entity("issue", ISSUE_ID)).toMatchObject({
          entityKind: "issue",
          title: "Offline first",
        });

        const settled = yield* SubscriptionRef.get(engine.state);
        // The confirmed row is the server's, timestamps included; the optimistic one is gone.
        expect(settled.confirmed.get(issueKey)).toMatchObject({
          title: "Offline first",
          createdAt: SERVER_NOW,
        });
        expect(settled.view.get(issueKey)).toMatchObject({ createdAt: SERVER_NOW });
        expect(settled.view.get(todoKey)).toMatchObject({ createdAt: SERVER_NOW });
        expect(settled.pending).toEqual([]);
        expect(settled.quarantined).toEqual([]);
        expect(settled.rejected).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("uses a service actor override in the optimistic overlay", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-create"),
          operation: issueSyncOperation({
            kind: "issue.create",
            entityId: ISSUE_ID,
            args: { title: "Filed from Slack" },
          }),
          actor: SLACK_ACTOR,
        });
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-comment"),
          operation: issueSyncOperation({
            kind: "issueComment.create",
            entityId: COMMENT_ID,
            args: { issueId: IssueId.make(ISSUE_ID), body: "Slack reply" },
          }),
          actor: SLACK_ACTOR,
        });

        const optimistic = yield* SubscriptionRef.get(engine.state);
        expect(
          optimistic.view.get(
            syncEntityKey({
              entityKind: "issueComment",
              entityId: COMMENT_ID,
            }),
          ),
        ).toMatchObject({ author: SLACK_ACTOR });
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("keeps a deleted issue readable while blocking a later edit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const engine = yield* openEngine("client-a");
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-create"),
          operation: issueSyncOperation({
            kind: "issue.create",
            entityId: ISSUE_ID,
            args: { title: "Doomed" },
          }),
        });
        yield* engine.sync;

        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-delete"),
          operation: issueSyncOperation({ kind: "issue.delete", entityId: ISSUE_ID, args: {} }),
        });
        const updateId = SyncOperationId.make("operation-update");
        yield* engine.enqueue({
          operationId: updateId,
          operation: issueSyncOperation({
            kind: "issue.update",
            entityId: ISSUE_ID,
            args: { title: "Too late" },
          }),
        });

        const staged = yield* SubscriptionRef.get(engine.state);
        expect((staged.view.get(issueKey) as IssueEntity | undefined)?.deletedAt).toBe(1_000);
        expect(
          staged.pending.find((entry) => entry.operation.operationId === updateId)?.status,
        ).toMatchObject({ _tag: "Blocked" });

        const receipt = yield* engine.sync;
        expect(receipt.acceptedOperations).toBe(1);
        expect(receipt.rejectedOperations).toBe(0);
        // The blocked edit never left the client, so the server never had to refuse it.
        expect(yield* harness.server.receipt(updateId)).toBeNull();
        expect(
          ((yield* harness.server.entity("issue", ISSUE_ID)) as IssueEntity | null)?.deletedAt,
        ).toBe(5_000);

        const settled = yield* SubscriptionRef.get(engine.state);
        expect((settled.confirmed.get(issueKey) as IssueEntity | undefined)?.deletedAt).toBe(5_000);
        expect(settled.pending).toHaveLength(1);
        expect(settled.pending[0]?.status).toMatchObject({ _tag: "Blocked" });
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("reloads argument-free operations after a restart instead of quarantining them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        const first = yield* openEngine("client-a");
        yield* first.enqueue({
          operationId: SyncOperationId.make("operation-create"),
          operation: issueSyncOperation({
            kind: "issue.create",
            entityId: ISSUE_ID,
            args: { title: "Written offline" },
          }),
        });
        yield* first.enqueue({
          operationId: SyncOperationId.make("operation-label"),
          operation: issueSyncOperation({
            kind: "issueLabel.create",
            entityId: LABEL_ID,
            args: { name: "regression", color: "#ef4444" },
          }),
        });
        yield* first.enqueue({
          operationId: SyncOperationId.make("operation-label-delete"),
          operation: issueSyncOperation({
            kind: "issueLabel.delete",
            entityId: LABEL_ID,
            args: {},
          }),
        });

        // Ten of this domain's verbs carry no arguments at all, so a build that read the outbox
        // from arguments alone could not tell a delete from a restore: both rows would land in
        // quarantine on the next launch and the work would never be sent.
        const restarted = yield* openEngine("client-a");
        const reloaded = yield* SubscriptionRef.get(restarted.state);
        expect(reloaded.quarantined).toEqual([]);
        expect(reloaded.pending.map((entry) => entry.operation.kind)).toEqual([
          "issue.create",
          "issueLabel.create",
          "issueLabel.delete",
        ]);
        expect(reloaded.view.has(issueKey)).toBe(true);
        expect(reloaded.view.has(labelKey)).toBe(false);

        const receipt = yield* restarted.sync;
        expect(receipt.acceptedOperations).toBe(3);
        expect(yield* harness.server.entity("issue", ISSUE_ID)).toMatchObject({
          title: "Written offline",
        });
        expect(yield* harness.server.entity("issueLabel", LABEL_ID)).toBeNull();
        expect((yield* SubscriptionRef.get(restarted.state)).quarantined).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("stamps a pending row once instead of on every overlay recompute", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();

      yield* Effect.gen(function* () {
        let clockReads = 0;
        // A clock that never answers the same thing twice. If the reducer kept reading one, an
        // unsent row's `createdAt` would move on every republish and the row would crawl up any
        // activity-sorted list on its own.
        const drifting = () => {
          clockReads += 1;
          return ENQUEUED_AT + clockReads * 60_000;
        };
        const open = (clientId: string) =>
          makeSyncEngine({
            companyId: COMPANY_ID,
            clientId: SyncClientId.make(clientId),
            actor: ACTOR,
            adapter: makeIssueSyncAdapter({ actor: ACTOR, now: drifting }),
          });

        const engine = yield* open("client-drift");
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-create"),
          operation: issueSyncOperation({
            kind: "issue.create",
            entityId: ISSUE_ID,
            args: { title: "Written on a plane" },
          }),
        });
        expect((yield* SubscriptionRef.get(engine.state)).view.get(issueKey)).toMatchObject({
          createdAt: ENQUEUED_AT,
          updatedAt: ENQUEUED_AT,
        });

        // An hour later, an unrelated write republishes the whole overlay.
        yield* TestClock.adjust("1 hour");
        yield* engine.enqueue({
          operationId: SyncOperationId.make("operation-label"),
          operation: issueSyncOperation({
            kind: "issueLabel.create",
            entityId: LABEL_ID,
            args: { name: "regression", color: "#ef4444" },
          }),
        });
        const later = yield* SubscriptionRef.get(engine.state);
        expect(later.view.get(issueKey)).toMatchObject({
          createdAt: ENQUEUED_AT,
          updatedAt: ENQUEUED_AT,
        });
        // The stamp is per operation rather than global: the label was written an hour later and
        // says so, which is what makes it a stamp and not a frozen constant.
        expect(later.view.get(labelKey)).toMatchObject({
          createdAt: ENQUEUED_AT + 3_600_000,
          updatedAt: ENQUEUED_AT + 3_600_000,
        });

        // A restart replays the stamps from the store instead of re-reading a clock, so the rows
        // are where the user left them however long the app was closed.
        yield* TestClock.adjust("1 hour");
        const restarted = yield* open("client-drift");
        const reopened = yield* SubscriptionRef.get(restarted.state);
        expect(reopened.view.get(issueKey)).toMatchObject({
          createdAt: ENQUEUED_AT,
          updatedAt: ENQUEUED_AT,
        });
        expect(reopened.view.get(labelKey)).toMatchObject({
          createdAt: ENQUEUED_AT + 3_600_000,
        });
        // The adapter's own clock was never needed: every one of those rows came from an outbox row.
        expect(clockReads).toBe(0);
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );

  it.effect("still reads an outbox row written before the stamp existed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const operation = issueSyncOperation({
        kind: "issue.create",
        entityId: ISSUE_ID,
        args: { title: "Queued by an older build" },
      });
      // Exactly what an older build persisted: an envelope and a status, and no stamp anywhere.
      const envelope: SyncOperationEnvelope = {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operationId: SyncOperationId.make("operation-legacy"),
        companyId: COMPANY_ID,
        clientId: SyncClientId.make("client-a"),
        environmentId: null,
        actor: ACTOR,
        localSequence: LocalSequence.make(1),
        baseVersion: CompanyVersion.make(0),
        entityId: ISSUE_ID,
        dependsOn: [],
        kind: "issue.create",
        args: issueSyncDomainAdapter.operationCodec.encode(operation),
      };
      yield* harness.store.service.commit(COMPANY_ID, {
        upsertOutbox: [{ envelope, status: { _tag: "Pending" } }],
        localSequenceHighWater: LocalSequence.make(1),
      });

      yield* Effect.gen(function* () {
        const engine = yield* makeSyncEngine({
          companyId: COMPANY_ID,
          clientId: SyncClientId.make("client-a"),
          actor: ACTOR,
          adapter: makeIssueSyncAdapter({ actor: ACTOR, now: () => ENQUEUED_AT }),
        });

        // Readable, sendable, and shown — falling back to the adapter's clock, which is the only
        // answer that ever existed for it. Dropping the row instead would lose unsent work.
        const state = yield* SubscriptionRef.get(engine.state);
        expect(state.quarantined).toEqual([]);
        expect(state.pending.map((entry) => entry.operation.operationId)).toEqual([
          "operation-legacy",
        ]);
        expect(state.view.get(issueKey)).toMatchObject({
          title: "Queued by an older build",
          createdAt: ENQUEUED_AT,
        });

        const receipt = yield* engine.sync;
        expect(receipt.acceptedOperations).toBe(1);
        expect(yield* harness.server.entity("issue", ISSUE_ID)).toMatchObject({
          title: "Queued by an older build",
        });
      }).pipe(Effect.provide(harness.layer), Effect.provideService(CloudSyncCapability, ENABLED));
    }),
  );
});
