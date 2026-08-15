import {
  ChatAttachmentId,
  EnvironmentId,
  IssueCommentId,
  IssueCycleId,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  IssueViewId,
  ProjectId,
  ThreadId,
  type IssueViewConfig,
} from "@spiritdevs/contracts";
import { decodeIssueSyncOperation, issueSyncDomainAdapter } from "@spiritdevs/client-runtime/sync";
import {
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  issueBulkUpdateOperations,
  issueCommentCreateOperation,
  issueCommentDeleteOperation,
  issueCommentUpdateOperation,
  issueCreateOperation,
  issueCycleCreateOperation,
  issueCycleDeleteOperation,
  issueCycleUpdateOperation,
  issueDeleteOperation,
  issueLabelCreateOperation,
  issueLabelDeleteOperation,
  issueLabelUpdateOperation,
  issueMilestoneCreateOperation,
  issueMilestoneDeleteOperation,
  issueMilestonesReorderOperations,
  issueMilestoneUpdateOperation,
  issueRelationCreateOperation,
  issueRelationDeleteOperation,
  issueRestoreOperation,
  issueSetSortOrderOperation,
  issueTriageRejectOperation,
  issueStatusCreateOperation,
  issueStatusDeleteOperation,
  issueStatusesReorderOperation,
  issueStatusUpdateOperation,
  issueThreadLinkCreateOperation,
  issueThreadLinkDeleteOperation,
  issueTodoCreateOperation,
  issueTodoCreateSortOrder,
  issueTodoDeleteOperation,
  issueTodosReorderOperations,
  issueTodoUpdateOperation,
  issueUpdateOperation,
  issueViewCreateOperation,
  issueViewDeleteOperation,
  issueViewsReorderOperations,
  issueViewUpdateOperation,
} from "@spiritdevs/client-runtime/sync";

const ISSUE = IssueId.make("issue-1");
const ISSUE_2 = IssueId.make("issue-2");
const STATUS = IssueStatusId.make("status-1");
const STATUS_2 = IssueStatusId.make("status-2");
const LABEL = IssueLabelId.make("label-1");
const MILESTONE = IssueMilestoneId.make("milestone-1");
const MILESTONE_2 = IssueMilestoneId.make("milestone-2");
const CYCLE = IssueCycleId.make("cycle-1");
const TODO = IssueTodoId.make("todo-1");
const TODO_2 = IssueTodoId.make("todo-2");
const RELATION = IssueRelationId.make("relation-1");
const COMMENT = IssueCommentId.make("comment-1");
const VIEW = IssueViewId.make("view-1");
const VIEW_2 = IssueViewId.make("view-2");
const PROJECT = ProjectId.make("project-1");

const VIEW_CONFIG: IssueViewConfig = {
  tab: "active",
  grouping: "status",
  sortMode: "manual",
  viewMode: "list",
};

describe("issue RPC operation translation", () => {
  it("maps issue create field-for-field and deliberately leaves the key absent", () => {
    const operation = issueCreateOperation(
      {
        title: "Ship C4",
        description: "Use the outbox",
        statusId: STATUS,
        priority: "high",
        projectId: PROJECT,
        milestoneId: MILESTONE,
        cycleId: CYCLE,
        parentId: ISSUE_2,
        labelIds: [LABEL],
        dueDate: "2026-08-20",
        triage: true,
      },
      ISSUE,
    );

    expect(operation).toEqual({
      kind: "issue.create",
      entityId: ISSUE,
      args: {
        title: "Ship C4",
        description: "Use the outbox",
        statusId: STATUS,
        priority: "high",
        projectId: PROJECT,
        milestoneId: MILESTONE,
        cycleId: CYCLE,
        parentId: ISSUE_2,
        labelIds: [LABEL],
        dueDate: "2026-08-20",
        triage: true,
      },
    });
    expect(operation.args).not.toHaveProperty("key");
  });

  it("carries server-authored Slack source metadata and maps triage rejection distinctly", () => {
    const slackSource = {
      issueId: ISSUE,
      channelId: "C123",
      messageTs: "1723459200.001900",
      permalink: "https://example.slack.com/archives/C123/p1723459200001900",
      authorName: "Corey",
    };
    expect(
      issueCreateOperation({ title: "Slack report", triage: true }, ISSUE, slackSource),
    ).toEqual({
      kind: "issue.create",
      entityId: ISSUE,
      args: { title: "Slack report", triage: true, slackSource },
    });
    expect(issueTriageRejectOperation({ issueId: ISSUE })).toEqual({
      kind: "issue.triageReject",
      entityId: ISSUE,
      args: {},
    });
  });

  it("maps issue updates, refs, sort order, and expands bulk updates one target at a time", () => {
    expect(
      issueUpdateOperation({
        issueId: ISSUE,
        patch: { title: "New", projectId: PROJECT, assignee: null },
      }),
    ).toEqual({
      kind: "issue.update",
      entityId: ISSUE,
      args: { title: "New", projectId: PROJECT, assignee: null },
    });
    expect(issueDeleteOperation({ issueId: ISSUE })).toMatchObject({
      kind: "issue.delete",
      entityId: ISSUE,
      args: {},
    });
    expect(issueRestoreOperation({ issueId: ISSUE })).toMatchObject({
      kind: "issue.restore",
      entityId: ISSUE,
      args: {},
    });
    expect(
      issueSetSortOrderOperation({ issueId: ISSUE, sortOrder: "n", statusId: STATUS }),
    ).toEqual({
      kind: "issue.setSortOrder",
      entityId: ISSUE,
      args: { sortOrder: "n", statusId: STATUS },
    });
    expect(
      issueBulkUpdateOperations({ issueIds: [ISSUE, ISSUE_2], patch: { priority: "urgent" } }),
    ).toEqual([
      { kind: "issue.update", entityId: ISSUE, args: { priority: "urgent" } },
      { kind: "issue.update", entityId: ISSUE_2, args: { priority: "urgent" } },
    ]);
  });

  it("maps status and label CRUD, with company scope and the complete status reorder", () => {
    expect(
      issueStatusCreateOperation(
        { name: "Review", color: "#123456", category: "review", position: 3 },
        STATUS,
      ),
    ).toEqual({
      kind: "issueStatus.create",
      entityId: STATUS,
      args: {
        scope: "company",
        name: "Review",
        color: "#123456",
        category: "review",
        position: 3,
      },
    });
    expect(issueStatusUpdateOperation({ statusId: STATUS, patch: { name: "QA" } })).toMatchObject({
      kind: "issueStatus.update",
      entityId: STATUS,
      args: { name: "QA" },
    });
    expect(
      issueStatusDeleteOperation({ statusId: STATUS, reassignToStatusId: STATUS_2 }),
    ).toMatchObject({
      kind: "issueStatus.delete",
      entityId: STATUS,
      args: { reassignToStatusId: STATUS_2 },
    });
    expect(issueStatusesReorderOperation({ statusIds: [STATUS_2, STATUS] })).toEqual({
      kind: "issueStatus.reorder",
      entityId: STATUS_2,
      args: { statusIds: [STATUS_2, STATUS] },
    });

    expect(issueLabelCreateOperation({ name: "Bug", color: "#ff0000" }, LABEL)).toEqual({
      kind: "issueLabel.create",
      entityId: LABEL,
      args: { name: "Bug", color: "#ff0000" },
    });
    expect(
      issueLabelUpdateOperation({ labelId: LABEL, patch: { color: "#00ff00" } }),
    ).toMatchObject({ kind: "issueLabel.update", entityId: LABEL, args: { color: "#00ff00" } });
    expect(issueLabelDeleteOperation({ labelId: LABEL })).toMatchObject({
      kind: "issueLabel.delete",
      entityId: LABEL,
    });
  });

  it("maps milestone and cycle CRUD and expands milestone order to one positioned update per row", () => {
    expect(
      issueMilestoneCreateOperation(
        {
          projectId: PROJECT,
          name: "Beta",
          description: "Ready",
          startDate: "2026-08-01",
          targetDate: "2026-08-31",
          position: 2,
        },
        MILESTONE,
      ),
    ).toEqual({
      kind: "issueMilestone.create",
      entityId: MILESTONE,
      args: {
        cloudProjectId: PROJECT,
        name: "Beta",
        description: "Ready",
        startDate: "2026-08-01",
        targetDate: "2026-08-31",
        position: 2,
      },
    });
    expect(
      issueMilestoneUpdateOperation({ milestoneId: MILESTONE, patch: { projectId: PROJECT } }),
    ).toMatchObject({
      kind: "issueMilestone.update",
      entityId: MILESTONE,
      args: { cloudProjectId: PROJECT },
    });
    expect(issueMilestoneDeleteOperation({ milestoneId: MILESTONE })).toMatchObject({
      kind: "issueMilestone.delete",
      entityId: MILESTONE,
    });
    expect(
      issueMilestonesReorderOperations({
        projectId: PROJECT,
        milestoneIds: [MILESTONE_2, MILESTONE],
      }),
    ).toEqual([
      { kind: "issueMilestone.update", entityId: MILESTONE_2, args: { position: 1 } },
      { kind: "issueMilestone.update", entityId: MILESTONE, args: { position: 2 } },
    ]);

    expect(
      issueCycleCreateOperation(
        { name: "Sprint", startDate: "2026-08-01", endDate: "2026-08-14" },
        CYCLE,
      ),
    ).toMatchObject({ kind: "issueCycle.create", entityId: CYCLE });
    expect(
      issueCycleUpdateOperation({ cycleId: CYCLE, patch: { name: "Sprint 2" } }),
    ).toMatchObject({ kind: "issueCycle.update", entityId: CYCLE, args: { name: "Sprint 2" } });
    expect(issueCycleDeleteOperation({ cycleId: CYCLE })).toMatchObject({
      kind: "issueCycle.delete",
      entityId: CYCLE,
    });
  });

  it("maps todo CRUD and emits strictly increasing sort keys for a full reorder", () => {
    const inserted = issueTodoCreateSortOrder(2, [{ sortOrder: "b" }, { sortOrder: "n" }]);
    expect(inserted! > "b" && inserted! < "n").toBe(true);
    expect(issueTodoCreateOperation({ issueId: ISSUE, text: "Test" }, TODO, "m")).toEqual({
      kind: "issueTodo.create",
      entityId: TODO,
      args: { issueId: ISSUE, text: "Test", sortOrder: "m" },
    });
    expect(issueTodoUpdateOperation({ todoId: TODO, patch: { done: true } })).toMatchObject({
      kind: "issueTodo.update",
      entityId: TODO,
      args: { done: true },
    });
    expect(issueTodoDeleteOperation({ todoId: TODO })).toMatchObject({
      kind: "issueTodo.delete",
      entityId: TODO,
    });
    const reordered = issueTodosReorderOperations({ issueId: ISSUE, todoIds: [TODO_2, TODO] });
    expect(reordered.map((operation) => operation.entityId)).toEqual([TODO_2, TODO]);
    expect(reordered[0]!.args.sortOrder! < reordered[1]!.args.sortOrder!).toBe(true);
  });

  it("maps relation and ordinary comment CRUD without the environment-only mention control", () => {
    expect(
      issueRelationCreateOperation(
        { issueId: ISSUE, relatedIssueId: ISSUE_2, kind: "blocks" },
        RELATION,
      ),
    ).toEqual({
      kind: "issueRelation.create",
      entityId: RELATION,
      args: { issueId: ISSUE, relatedIssueId: ISSUE_2, kind: "blocks" },
    });
    expect(issueRelationDeleteOperation({ relationId: RELATION })).toMatchObject({
      kind: "issueRelation.delete",
      entityId: RELATION,
    });
    const attachmentId = ChatAttachmentId.make("attachment-1");
    expect(
      issueCommentCreateOperation(
        { issueId: ISSUE, body: "Done", attachmentIds: [attachmentId] },
        COMMENT,
      ),
    ).toEqual({
      kind: "issueComment.create",
      entityId: COMMENT,
      args: { issueId: ISSUE, body: "Done", attachmentIds: [attachmentId] },
    });
    expect(
      issueCommentUpdateOperation({ commentId: COMMENT, patch: { body: "Edited" } }),
    ).toMatchObject({ kind: "issueComment.update", entityId: COMMENT, args: { body: "Edited" } });
    expect(issueCommentDeleteOperation({ commentId: COMMENT })).toMatchObject({
      kind: "issueComment.delete",
      entityId: COMMENT,
    });
  });

  it("maps view CRUD and expands a view reorder to one position update per row", () => {
    expect(
      issueViewCreateOperation({ name: "Mine", config: VIEW_CONFIG, position: 4 }, VIEW),
    ).toEqual({
      kind: "issueView.create",
      entityId: VIEW,
      args: { name: "Mine", config: VIEW_CONFIG, position: 4 },
    });
    expect(issueViewUpdateOperation({ viewId: VIEW, patch: { name: "Ours" } })).toMatchObject({
      kind: "issueView.update",
      entityId: VIEW,
      args: { name: "Ours" },
    });
    expect(issueViewDeleteOperation({ viewId: VIEW })).toMatchObject({
      kind: "issueView.delete",
      entityId: VIEW,
    });
    expect(issueViewsReorderOperations({ viewIds: [VIEW_2, VIEW] })).toEqual([
      { kind: "issueView.update", entityId: VIEW_2, args: { position: 1 } },
      { kind: "issueView.update", entityId: VIEW, args: { position: 2 } },
    ]);
  });

  it("maps thread links and round-trips translated arguments through the production codec", () => {
    const environmentId = EnvironmentId.make("environment-c7");
    const linkId = SyncEntityId.make("thread-link-c7");
    const dependency = SyncOperationId.make("delete-old-link");
    const operation = issueThreadLinkCreateOperation(
      { issueId: ISSUE, threadId: ThreadId.make("thread-c7"), origin: "manual" },
      linkId,
      environmentId,
      [dependency],
    );
    expect(operation).toEqual({
      kind: "issueThreadLink.create",
      entityId: linkId,
      args: { issueId: ISSUE, environmentId, threadId: "thread-c7", origin: "manual" },
      dependsOn: [dependency],
    });
    expect(issueThreadLinkDeleteOperation(linkId)).toEqual({
      kind: "issueThreadLink.delete",
      entityId: linkId,
      args: {},
    });

    const decoded = decodeIssueSyncOperation({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      operationId: SyncOperationId.make("create-new-link"),
      companyId: CompanyId.make("company-c7"),
      clientId: SyncClientId.make("client-c7"),
      environmentId,
      actor: { kind: "environment", environmentId },
      localSequence: LocalSequence.make(1),
      baseVersion: CompanyVersion.make(4),
      kind: operation.kind,
      entityId: operation.entityId,
      args: issueSyncDomainAdapter.operationCodec.encode(operation),
      dependsOn: [dependency],
    });
    expect(Option.getOrThrow(decoded)).toEqual(operation);
  });
});
