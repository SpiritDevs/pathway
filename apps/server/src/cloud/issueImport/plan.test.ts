import {
  ChatAttachmentId,
  EnvironmentId,
  IssueCommentId,
  IssueCycleId,
  IssueEventId,
  IssueId,
  IssueKey,
  IssueKeyPrefix,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  IssueViewId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@spiritdevs/contracts";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { assert, describe, it } from "@effect/vitest";

import type { LocalIssueSnapshot } from "./snapshot.ts";
import {
  issueImportOperationId,
  NORMAL_PUSH_FIDELITY,
  planIssueImport,
  type IssueImportPlanConfig,
} from "./plan.ts";

const STATUS = IssueStatusId.make("status-todo");
const LABEL = IssueLabelId.make("label-bug");
const MILESTONE = IssueMilestoneId.make("milestone-one");
const CYCLE = IssueCycleId.make("cycle-one");
const ISSUE_A = IssueId.make("issue-a");
const ISSUE_B = IssueId.make("issue-b");
const TODO = IssueTodoId.make("todo-one");
const RELATION = IssueRelationId.make("relation-one");
const COMMENT = IssueCommentId.make("comment-one");
const ATTACHMENT = ChatAttachmentId.make("iss_issue-a-00000000-0000-4000-8000-000000000001");
const VIEW = IssueViewId.make("view-one");
const EVENT = IssueEventId.make("event-one");
const PROJECT = ProjectId.make("project-one");
const THREAD = ThreadId.make("thread-one");
const CREATED = "2026-01-02T03:04:05.000Z";
const UPDATED = "2026-02-03T04:05:06.000Z";

const config: IssueImportPlanConfig = {
  companyId: CompanyId.make("company-one"),
  importingMembershipId: MembershipId.make("membership-importer"),
  sourceEnvironmentId: EnvironmentId.make("environment-source"),
  importRunId: "import-run-one",
  selectedIssueKeyPrefix: IssueKeyPrefix.make("PAT"),
};

const snapshot = (): LocalIssueSnapshot => ({
  capturedAt: Date.parse("2026-03-01T00:00:00.000Z"),
  statuses: [
    {
      id: STATUS,
      name: "Todo",
      color: "#888888",
      category: "unstarted",
      position: 0,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ],
  labels: [{ id: LABEL, name: "Bug", color: "#ff0000", createdAt: CREATED }],
  labelAssignments: [{ issueId: ISSUE_A, labelId: LABEL }],
  milestones: [
    {
      id: MILESTONE,
      projectId: PROJECT,
      name: "M1",
      description: "First milestone",
      startDate: "2026-01-01",
      targetDate: "2026-04-01",
      position: 0,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ],
  cycles: [
    {
      id: CYCLE,
      name: "Cycle 1",
      startDate: "2026-01-01",
      endDate: "2026-01-31",
      completedAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ],
  issues: [
    {
      id: ISSUE_A,
      key: IssueKey.make("PAT-2"),
      title: "Preserve me",
      description: "Original body",
      statusId: STATUS,
      priority: "high",
      assignee: { kind: "user" },
      workModelSelection: null,
      automationAssignment: null,
      pullRequest: null,
      projectId: PROJECT,
      milestoneId: MILESTONE,
      cycleId: CYCLE,
      parentId: null,
      sortOrder: "a0",
      dueDate: "2026-04-01",
      triage: false,
      slackSource: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      deletedAt: null,
      labelIds: [LABEL],
    },
    {
      id: ISSUE_B,
      key: IssueKey.make("PAT-40"),
      title: "Deleted issue",
      description: "Still imported as a tombstone",
      statusId: STATUS,
      priority: "none",
      assignee: null,
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: ISSUE_A,
      sortOrder: "b0",
      dueDate: null,
      triage: false,
      slackSource: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      deletedAt: UPDATED,
      labelIds: [],
    },
  ],
  todos: [{ id: TODO, issueId: ISSUE_A, text: "Ship it", done: true, position: 3 }],
  relations: [{ id: RELATION, issueId: ISSUE_A, relatedIssueId: ISSUE_B, kind: "blocks" }],
  comments: [
    {
      id: COMMENT,
      issueId: ISSUE_A,
      author: { kind: "user" },
      body: "Historical comment",
      attachmentIds: [ATTACHMENT],
      mentions: [],
      createdAt: CREATED,
      editedAt: UPDATED,
    },
  ],
  attachments: [
    {
      id: ATTACHMENT,
      issueId: ISSUE_A,
      commentId: COMMENT,
      filePath: "/tmp/issue-a.png",
      fileName: "issue-a.png",
      mimeType: "image/png",
      byteSize: 512,
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ],
  auditEvents: [
    {
      id: EVENT,
      issueId: ISSUE_A,
      actor: { kind: "user" },
      kind: "field_changed",
      field: "priority",
      before: "none",
      after: "high",
      createdAt: CREATED,
    },
  ],
  threadLinks: [{ issueId: ISSUE_A, threadId: THREAD, createdAt: CREATED, origin: "start-work" }],
  views: [
    {
      id: VIEW,
      name: "Active work",
      position: 0,
      config: {
        tab: "active",
        grouping: "status",
        sortMode: "manual",
        viewMode: "board",
      },
      createdAt: CREATED,
      updatedAt: UPDATED,
    },
  ],
  trackerConfig: { keyPrefix: IssueKeyPrefix.make("PAT"), nextNumber: 10 },
});

const allOperations = (plan: ReturnType<typeof planIssueImport>) =>
  plan.operationBatches.flatMap((batch) => batch.operations);

describe("planIssueImport", () => {
  it("preserves domain ids, issue keys, and source timestamps in planned entities", () => {
    const plan = planIssueImport(snapshot(), config);
    const issue = plan.entities.find(
      (entity) => entity.entityKind === "issue" && entity.id === ISSUE_A,
    );
    assert.ok(issue?.entityKind === "issue");
    assert.equal(issue.id, ISSUE_A);
    assert.equal(issue.key, "PAT-2");
    assert.equal(issue.createdAt, Date.parse(CREATED));
    assert.equal(issue.updatedAt, Date.parse(UPDATED));

    const create = allOperations(plan).find(
      (entry) =>
        entry.operation.kind === "issue.create" && String(entry.operation.entityId) === ISSUE_A,
    );
    assert.ok(create?.operation.kind === "issue.create");
    assert.equal(create.operation.args.key, "PAT-2");
    assert.equal(create.sourceEntity.createdAt, Date.parse(CREATED));

    assert.equal(plan.preview.counts.issueAuditEvent, snapshot().auditEvents.length);
  });

  it("maps anonymous human assignees and historical actors to the importing membership", () => {
    const plan = planIssueImport(snapshot(), config);
    const issue = plan.entities.find(
      (entity) => entity.entityKind === "issue" && entity.id === ISSUE_A,
    );
    const comment = plan.entities.find((entity) => entity.entityKind === "issueComment");
    const audit = plan.entities.find((entity) => entity.entityKind === "issueAuditEvent");
    assert.ok(issue?.entityKind === "issue");
    assert.deepEqual(issue.assignee, {
      kind: "member",
      membershipId: config.importingMembershipId,
    });
    assert.ok(comment?.entityKind === "issueComment");
    assert.deepEqual(comment.author, {
      kind: "member",
      membershipId: config.importingMembershipId,
    });
    assert.ok(audit?.entityKind === "issueAuditEvent");
    assert.deepEqual(audit.actor, {
      kind: "member",
      membershipId: config.importingMembershipId,
    });
  });

  it("keeps agent attribution and maps it to the importing member on whose behalf it ran", () => {
    const base = snapshot();
    const source: LocalIssueSnapshot = {
      ...base,
      comments: base.comments.map((comment, index) =>
        index === 0
          ? {
              ...comment,
              author: {
                kind: "agent" as const,
                provider: ProviderDriverKind.make("claudeAgent"),
              },
            }
          : comment,
      ),
    };
    const plan = planIssueImport(source, config);
    const comment = plan.entities.find((entity) => entity.entityKind === "issueComment");
    assert.ok(comment?.entityKind === "issueComment");
    assert.deepEqual(comment.author, {
      kind: "agent",
      provider: ProviderDriverKind.make("claudeAgent"),
      onBehalfOfMembershipId: config.importingMembershipId,
    });
  });

  it("stamps every thread link with the source environment", () => {
    const plan = planIssueImport(snapshot(), config);
    const link = plan.entities.find((entity) => entity.entityKind === "issueThreadLink");
    assert.ok(link?.entityKind === "issueThreadLink");
    assert.equal(link.environmentId, config.sourceEnvironmentId);
    assert.equal(link.createdByMembershipId, config.importingMembershipId);
    const operation = allOperations(plan).find(
      (entry) => entry.operation.kind === "issueThreadLink.create",
    );
    assert.ok(operation?.operation.kind === "issueThreadLink.create");
    assert.equal(operation.operation.args.environmentId, config.sourceEnvironmentId);
  });

  it("derives deterministic operation ids without cross-kind collisions", () => {
    const first = issueImportOperationId(config, "issue", "same-id", "issue.create");
    const rerun = issueImportOperationId(config, "issue", "same-id", "issue.create");
    const otherKind = issueImportOperationId(config, "issueLabel", "same-id", "issueLabel.create");
    assert.equal(first, rerun);
    assert.notEqual(first, otherKind);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const one = allOperations(planIssueImport(snapshot(), config)).map(
      (entry) => entry.operationId,
    );
    const two = allOperations(planIssueImport(snapshot(), config)).map(
      (entry) => entry.operationId,
    );
    assert.deepEqual(one, two);
    assert.equal(new Set(one).size, one.length);
  });

  it("computes the next issue number above every preserved key and the local counter", () => {
    const plan = planIssueImport(snapshot(), config);
    assert.deepEqual(plan.preview.issueKeyRange, {
      first: "PAT-2",
      last: "PAT-40",
      lowestNumber: 2,
      highestNumber: 40,
    });
    assert.equal(plan.preview.nextIssueNumber, 41);
    assert.equal(plan.trackerConfig.nextIssueNumber, 41);
  });

  it("surfaces unrepresentable records instead of silently dropping them", () => {
    const base = snapshot();
    const source: LocalIssueSnapshot = {
      ...base,
      issues: base.issues.map((issue, index) =>
        index === 0 ? { ...issue, key: IssueKey.make("OLD-2") } : issue,
      ),
      attachments: base.attachments.map((attachment, index) =>
        index === 0 ? { ...attachment, filePath: null, byteSize: null } : attachment,
      ),
    };
    const plan = planIssueImport(source, config);
    assert.ok(
      plan.preview.rejected.some(
        (record) => record.entityKind === "issue" && record.entityId === ISSUE_A,
      ),
    );
    assert.ok(
      plan.preview.rejected.some(
        (record) => record.entityKind === "issueAttachment" && record.entityId === ATTACHMENT,
      ),
    );
    assert.ok(
      !plan.preview.rejected.some(
        (record) => record.entityKind === "issueComment" && record.entityId === COMMENT,
      ),
    );
    const commentCreate = allOperations(plan).find(
      (operation) => operation.operation.kind === "issueComment.create",
    );
    assert.deepEqual(commentCreate?.operation.args, {
      issueId: ISSUE_A,
      body: "Historical comment",
      attachmentIds: [],
    });
    assert.equal(plan.preview.attachments.count, 1);
  });

  it("orders catalog, issues, uploads, dependents, tombstones, and history by real dependencies", () => {
    const source = snapshot();
    const plan = planIssueImport({ ...source, issues: [...source.issues].reverse() }, config);
    assert.deepEqual(
      plan.operationBatches.map((batch) => batch.stage),
      ["trackerConfig", "catalog", "issues", "attachments", "dependents", "tombstones", "history"],
    );
    const operations = allOperations(plan);
    const issueCreates = plan.operationBatches
      .find((batch) => batch.stage === "issues")!
      .operations.filter((entry) => entry.operation.kind === "issue.create");
    assert.deepEqual(
      issueCreates.map((entry) => String(entry.operation.entityId)),
      [ISSUE_A, ISSUE_B],
    );
    const issueA = operations.find(
      (entry) =>
        entry.operation.kind === "issue.create" && String(entry.operation.entityId) === ISSUE_A,
    );
    const relation = operations.find((entry) => entry.operation.kind === "issueRelation.create");
    const tombstone = operations.find(
      (entry) =>
        entry.operation.kind === "issue.delete" && String(entry.operation.entityId) === ISSUE_B,
    );
    assert.ok(issueA);
    assert.ok(relation?.operation.dependsOn?.includes(issueA.operationId));
    assert.ok(tombstone?.operation.dependsOn?.length === 1);
    assert.ok(
      plan.operationBatches.findIndex((batch) => batch.stage === "dependents") <
        plan.operationBatches.findIndex((batch) => batch.stage === "tombstones"),
    );
    assert.equal(plan.attachmentUploads.length, 1);
  });

  it("reports a fidelity verdict for all twelve entity kinds plus tracker configuration", () => {
    assert.equal(NORMAL_PUSH_FIDELITY.length, 13);
    assert.equal(new Set(NORMAL_PUSH_FIDELITY.map((entry) => entry.entityKind)).size, 13);
    assert.equal(
      NORMAL_PUSH_FIDELITY.find((entry) => entry.entityKind === "issueAttachment")?.verdict,
      "not-supported",
    );
    assert.equal(
      NORMAL_PUSH_FIDELITY.find((entry) => entry.entityKind === "issueAuditEvent")?.verdict,
      "not-supported",
    );
    assert.ok(
      NORMAL_PUSH_FIDELITY.find((entry) => entry.entityKind === "issueComment")?.gaps.some((gap) =>
        gap.fields.includes("author"),
      ),
    );
  });
});
