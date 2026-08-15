/**
 * Pure compatibility translations from environment-era issue RPC inputs to cloud-sync writes.
 *
 * Create ids are supplied by the caller so translation stays deterministic and tests can prove
 * the exact row the optimistic overlay and Convex will share. The routing layer mints those ids
 * with its platform UUID utility before calling these functions.
 *
 * @module sync/issueOperationsFromRpc
 */
import {
  issueSyncOperation,
  type IssueSyncOperation,
  type IssueSyncOperationOf,
} from "./issueDomain.ts";
import { syncOrderKeyAfter, syncOrderKeyBetween } from "./orderKey.ts";
import { SyncEntityId, type SyncOperationId } from "@spiritdevs/contracts/cloudSync";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import type {
  EnvironmentId,
  IssueBulkUpdateInput,
  IssueCommentCreateInput,
  IssueCommentDeleteInput,
  IssueCommentId,
  IssueCommentUpdateInput,
  IssueCreateInput,
  IssueCycleCreateInput,
  IssueCycleDeleteInput,
  IssueCycleId,
  IssueCycleUpdateInput,
  IssueLabelCreateInput,
  IssueLabelDeleteInput,
  IssueLabelId,
  IssueLabelUpdateInput,
  IssueMilestoneCreateInput,
  IssueMilestoneDeleteInput,
  IssueMilestoneId,
  IssueMilestonesReorderInput,
  IssueMilestoneUpdateInput,
  IssueRefInput,
  IssueRelationCreateInput,
  IssueRelationDeleteInput,
  IssueRelationId,
  IssueSetSortOrderInput,
  IssueSlackSource,
  IssueStatusCreateInput,
  IssueStatusDeleteInput,
  IssueStatusesReorderInput,
  IssueStatusId,
  IssueStatusUpdateInput,
  IssueTodoCreateInput,
  IssueTodoDeleteInput,
  IssueTodoId,
  IssueTodosReorderInput,
  IssueTodoUpdateInput,
  IssueThreadLinkInput,
  IssueUpdateInput,
  IssueViewCreateInput,
  IssueViewDeleteInput,
  IssueViewId,
  IssueViewsReorderInput,
  IssueViewUpdateInput,
  IssueId,
} from "@spiritdevs/contracts";

const entityId = (id: string) => SyncEntityId.make(id);

export const issueCreateOperation = (
  input: IssueCreateInput,
  id: IssueId,
  slackSource?: IssueSlackSource,
): IssueSyncOperationOf<"issue.create"> =>
  issueSyncOperation({
    kind: "issue.create",
    entityId: entityId(id),
    args: {
      title: input.title,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.statusId === undefined ? {} : { statusId: input.statusId }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.assignee === undefined ? {} : { assignee: input.assignee }),
      ...(input.projectId === undefined ? {} : { projectId: CloudProjectId.make(input.projectId) }),
      ...(input.milestoneId === undefined ? {} : { milestoneId: input.milestoneId }),
      ...(input.cycleId === undefined ? {} : { cycleId: input.cycleId }),
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.labelIds === undefined ? {} : { labelIds: input.labelIds }),
      ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
      ...(input.triage === undefined ? {} : { triage: input.triage }),
      ...(slackSource === undefined ? {} : { slackSource }),
      // Intentionally keyless: Convex allocates the real key and the overlay renders Draft.
    },
  });

const issuePatchArgs = (input: IssueUpdateInput["patch"]) => {
  const { automationAssignment: _environmentOnly, projectId, ...patch } = input;
  return {
    ...patch,
    ...(projectId === undefined
      ? {}
      : { projectId: projectId === null ? null : CloudProjectId.make(projectId) }),
  };
};

export const issueUpdateOperation = (
  input: IssueUpdateInput,
): IssueSyncOperationOf<"issue.update"> =>
  issueSyncOperation({
    kind: "issue.update",
    entityId: entityId(input.issueId),
    args: issuePatchArgs(input.patch),
  });

export const issueDeleteOperation = (input: IssueRefInput): IssueSyncOperationOf<"issue.delete"> =>
  issueSyncOperation({ kind: "issue.delete", entityId: entityId(input.issueId), args: {} });

export const issueTriageRejectOperation = (
  input: IssueRefInput,
): IssueSyncOperationOf<"issue.triageReject"> =>
  issueSyncOperation({ kind: "issue.triageReject", entityId: entityId(input.issueId), args: {} });

export const issueRestoreOperation = (
  input: IssueRefInput,
): IssueSyncOperationOf<"issue.restore"> =>
  issueSyncOperation({ kind: "issue.restore", entityId: entityId(input.issueId), args: {} });

export const issueBulkUpdateOperations = (
  input: IssueBulkUpdateInput,
): ReadonlyArray<IssueSyncOperationOf<"issue.update">> =>
  input.issueIds.map((issueId) =>
    issueUpdateOperation({
      issueId,
      patch: input.patch,
    }),
  );

export const issueSetSortOrderOperation = (
  input: IssueSetSortOrderInput,
): IssueSyncOperationOf<"issue.setSortOrder"> =>
  issueSyncOperation({
    kind: "issue.setSortOrder",
    entityId: entityId(input.issueId),
    args: {
      sortOrder: input.sortOrder,
      ...(input.statusId === undefined ? {} : { statusId: input.statusId }),
    },
  });

export const issueStatusCreateOperation = (
  input: IssueStatusCreateInput,
  id: IssueStatusId,
): IssueSyncOperationOf<"issueStatus.create"> =>
  issueSyncOperation({
    kind: "issueStatus.create",
    entityId: entityId(id),
    args: {
      scope: "company",
      name: input.name,
      color: input.color,
      category: input.category,
      ...(input.position === undefined ? {} : { position: input.position }),
    },
  });

export const issueStatusUpdateOperation = (
  input: IssueStatusUpdateInput,
): IssueSyncOperationOf<"issueStatus.update"> =>
  issueSyncOperation({
    kind: "issueStatus.update",
    entityId: entityId(input.statusId),
    args: input.patch,
  });

export const issueStatusDeleteOperation = (
  input: IssueStatusDeleteInput,
): IssueSyncOperationOf<"issueStatus.delete"> =>
  issueSyncOperation({
    kind: "issueStatus.delete",
    entityId: entityId(input.statusId),
    args: { reassignToStatusId: input.reassignToStatusId },
  });

export const issueStatusesReorderOperation = (
  input: IssueStatusesReorderInput,
): IssueSyncOperationOf<"issueStatus.reorder"> =>
  issueSyncOperation({
    kind: "issueStatus.reorder",
    // The server rewrites the whole chain. The target picks which optimistic row moves first.
    entityId: entityId(input.statusIds[0]!),
    args: { statusIds: input.statusIds },
  });

export const issueLabelCreateOperation = (
  input: IssueLabelCreateInput,
  id: IssueLabelId,
): IssueSyncOperationOf<"issueLabel.create"> =>
  issueSyncOperation({
    kind: "issueLabel.create",
    entityId: entityId(id),
    args: input,
  });

export const issueLabelUpdateOperation = (
  input: IssueLabelUpdateInput,
): IssueSyncOperationOf<"issueLabel.update"> =>
  issueSyncOperation({
    kind: "issueLabel.update",
    entityId: entityId(input.labelId),
    args: input.patch,
  });

export const issueLabelDeleteOperation = (
  input: IssueLabelDeleteInput,
): IssueSyncOperationOf<"issueLabel.delete"> =>
  issueSyncOperation({ kind: "issueLabel.delete", entityId: entityId(input.labelId), args: {} });

export const issueMilestoneCreateOperation = (
  input: IssueMilestoneCreateInput,
  id: IssueMilestoneId,
): IssueSyncOperationOf<"issueMilestone.create"> =>
  issueSyncOperation({
    kind: "issueMilestone.create",
    entityId: entityId(id),
    args: {
      cloudProjectId: CloudProjectId.make(input.projectId),
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
      ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
      ...(input.position === undefined ? {} : { position: input.position }),
    },
  });

export const issueMilestoneUpdateOperation = (
  input: IssueMilestoneUpdateInput,
): IssueSyncOperationOf<"issueMilestone.update"> => {
  const { projectId, ...patch } = input.patch;
  return issueSyncOperation({
    kind: "issueMilestone.update",
    entityId: entityId(input.milestoneId),
    args: {
      ...patch,
      ...(projectId === undefined ? {} : { cloudProjectId: CloudProjectId.make(projectId) }),
    },
  });
};

export const issueMilestoneDeleteOperation = (
  input: IssueMilestoneDeleteInput,
): IssueSyncOperationOf<"issueMilestone.delete"> =>
  issueSyncOperation({
    kind: "issueMilestone.delete",
    entityId: entityId(input.milestoneId),
    args: {},
  });

export const issueMilestonesReorderOperations = (
  input: IssueMilestonesReorderInput,
): ReadonlyArray<IssueSyncOperationOf<"issueMilestone.update">> =>
  input.milestoneIds.map((milestoneId, index) =>
    issueSyncOperation({
      kind: "issueMilestone.update",
      entityId: entityId(milestoneId),
      args: { position: index + 1 },
    }),
  );

export const issueCycleCreateOperation = (
  input: IssueCycleCreateInput,
  id: IssueCycleId,
): IssueSyncOperationOf<"issueCycle.create"> =>
  issueSyncOperation({ kind: "issueCycle.create", entityId: entityId(id), args: input });

export const issueCycleUpdateOperation = (
  input: IssueCycleUpdateInput,
): IssueSyncOperationOf<"issueCycle.update"> =>
  issueSyncOperation({
    kind: "issueCycle.update",
    entityId: entityId(input.cycleId),
    args: input.patch,
  });

export const issueCycleDeleteOperation = (
  input: IssueCycleDeleteInput,
): IssueSyncOperationOf<"issueCycle.delete"> =>
  issueSyncOperation({ kind: "issueCycle.delete", entityId: entityId(input.cycleId), args: {} });

export const issueTodoCreateOperation = (
  input: IssueTodoCreateInput,
  id: IssueTodoId,
  sortOrder?: string,
): IssueSyncOperationOf<"issueTodo.create"> =>
  issueSyncOperation({
    kind: "issueTodo.create",
    entityId: entityId(id),
    args: {
      issueId: input.issueId,
      text: input.text,
      ...(sortOrder === undefined ? {} : { sortOrder }),
    },
  });

/** Converts the legacy one-based insertion position against the replica's ordered sync keys. */
export function issueTodoCreateSortOrder(
  position: number | undefined,
  todos: ReadonlyArray<{ readonly sortOrder: string }>,
): string | undefined {
  if (position === undefined) return undefined;
  const index = Math.max(0, Math.min(todos.length, position - 1));
  const before = todos[index - 1]?.sortOrder ?? null;
  const after = todos[index]?.sortOrder ?? null;
  return syncOrderKeyBetween(before, after) ?? syncOrderKeyAfter(todos.at(-1)?.sortOrder ?? null);
}

export const issueTodoUpdateOperation = (
  input: IssueTodoUpdateInput,
): IssueSyncOperationOf<"issueTodo.update"> =>
  issueSyncOperation({
    kind: "issueTodo.update",
    entityId: entityId(input.todoId),
    args: input.patch,
  });

export const issueTodoDeleteOperation = (
  input: IssueTodoDeleteInput,
): IssueSyncOperationOf<"issueTodo.delete"> =>
  issueSyncOperation({ kind: "issueTodo.delete", entityId: entityId(input.todoId), args: {} });

export const issueTodosReorderOperations = (
  input: IssueTodosReorderInput,
): ReadonlyArray<IssueSyncOperationOf<"issueTodo.update">> => {
  let previous: string | null = null;
  return input.todoIds.map((todoId) => {
    const sortOrder = syncOrderKeyAfter(previous);
    previous = sortOrder;
    return issueSyncOperation({
      kind: "issueTodo.update",
      entityId: entityId(todoId),
      args: { sortOrder },
    });
  });
};

export const issueRelationCreateOperation = (
  input: IssueRelationCreateInput,
  id: IssueRelationId,
): IssueSyncOperationOf<"issueRelation.create"> =>
  issueSyncOperation({ kind: "issueRelation.create", entityId: entityId(id), args: input });

export const issueRelationDeleteOperation = (
  input: IssueRelationDeleteInput,
): IssueSyncOperationOf<"issueRelation.delete"> =>
  issueSyncOperation({
    kind: "issueRelation.delete",
    entityId: entityId(input.relationId),
    args: {},
  });

export const issueCommentCreateOperation = (
  input: IssueCommentCreateInput,
  id: IssueCommentId,
): IssueSyncOperationOf<"issueComment.create"> => {
  const { agentMention: _environmentOnly, ...args } = input;
  return issueSyncOperation({ kind: "issueComment.create", entityId: entityId(id), args });
};

export const issueCommentUpdateOperation = (
  input: IssueCommentUpdateInput,
): IssueSyncOperationOf<"issueComment.update"> =>
  issueSyncOperation({
    kind: "issueComment.update",
    entityId: entityId(input.commentId),
    args: input.patch,
  });

export const issueCommentDeleteOperation = (
  input: IssueCommentDeleteInput,
): IssueSyncOperationOf<"issueComment.delete"> =>
  issueSyncOperation({
    kind: "issueComment.delete",
    entityId: entityId(input.commentId),
    args: {},
  });

export const issueViewCreateOperation = (
  input: IssueViewCreateInput,
  id: IssueViewId,
): IssueSyncOperationOf<"issueView.create"> =>
  issueSyncOperation({ kind: "issueView.create", entityId: entityId(id), args: input });

export const issueViewUpdateOperation = (
  input: IssueViewUpdateInput,
): IssueSyncOperationOf<"issueView.update"> =>
  issueSyncOperation({
    kind: "issueView.update",
    entityId: entityId(input.viewId),
    args: input.patch,
  });

export const issueViewDeleteOperation = (
  input: IssueViewDeleteInput,
): IssueSyncOperationOf<"issueView.delete"> =>
  issueSyncOperation({ kind: "issueView.delete", entityId: entityId(input.viewId), args: {} });

export const issueViewsReorderOperations = (
  input: IssueViewsReorderInput,
): ReadonlyArray<IssueSyncOperationOf<"issueView.update">> =>
  input.viewIds.map((viewId, index) =>
    issueSyncOperation({
      kind: "issueView.update",
      entityId: entityId(viewId),
      args: { position: index + 1 },
    }),
  );

export const issueThreadLinkCreateOperation = (
  input: IssueThreadLinkInput,
  id: SyncEntityId,
  environmentId: EnvironmentId,
  dependsOn?: ReadonlyArray<SyncOperationId>,
): IssueSyncOperationOf<"issueThreadLink.create"> =>
  issueSyncOperation({
    kind: "issueThreadLink.create",
    entityId: id,
    args: {
      issueId: input.issueId,
      environmentId,
      threadId: input.threadId,
      origin: input.origin,
    },
    ...(dependsOn === undefined ? {} : { dependsOn }),
  });

export const issueThreadLinkDeleteOperation = (
  id: SyncEntityId,
): IssueSyncOperationOf<"issueThreadLink.delete"> =>
  issueSyncOperation({ kind: "issueThreadLink.delete", entityId: id, args: {} });

export type IssueMutationRoute =
  | { readonly route: "sync"; readonly operations: ReadonlyArray<IssueSyncOperation["kind"]> }
  | {
      readonly route: "conditional";
      readonly operations: ReadonlyArray<IssueSyncOperation["kind"]>;
      readonly legacyWhen: string;
    }
  | { readonly route: "legacy-always"; readonly reason: string };

/** The complete current command boundary, kept explicit so later slices move deliberate rows. */
export const ISSUE_MUTATION_ROUTING_TABLE = {
  create: { route: "sync", operations: ["issue.create"] },
  update: {
    route: "conditional",
    operations: ["issue.update"],
    legacyWhen: "patch.automationAssignment is present",
  },
  delete: { route: "sync", operations: ["issue.delete"] },
  restore: { route: "sync", operations: ["issue.restore"] },
  bulkUpdate: {
    route: "conditional",
    operations: ["issue.update"],
    legacyWhen: "patch.automationAssignment is present",
  },
  setSortOrder: { route: "sync", operations: ["issue.setSortOrder"] },
  createStatus: { route: "sync", operations: ["issueStatus.create"] },
  updateStatus: { route: "sync", operations: ["issueStatus.update"] },
  deleteStatus: { route: "sync", operations: ["issueStatus.delete"] },
  reorderStatuses: { route: "sync", operations: ["issueStatus.reorder"] },
  createLabel: { route: "sync", operations: ["issueLabel.create"] },
  updateLabel: { route: "sync", operations: ["issueLabel.update"] },
  deleteLabel: { route: "sync", operations: ["issueLabel.delete"] },
  milestoneCreate: { route: "sync", operations: ["issueMilestone.create"] },
  milestoneUpdate: { route: "sync", operations: ["issueMilestone.update"] },
  milestoneDelete: { route: "sync", operations: ["issueMilestone.delete"] },
  milestonesReorder: { route: "sync", operations: ["issueMilestone.update"] },
  cycleCreate: { route: "sync", operations: ["issueCycle.create"] },
  cycleUpdate: { route: "sync", operations: ["issueCycle.update"] },
  cycleDelete: { route: "sync", operations: ["issueCycle.delete"] },
  todoCreate: { route: "sync", operations: ["issueTodo.create"] },
  todoUpdate: { route: "sync", operations: ["issueTodo.update"] },
  todoDelete: { route: "sync", operations: ["issueTodo.delete"] },
  todosReorder: { route: "sync", operations: ["issueTodo.update"] },
  relationCreate: { route: "sync", operations: ["issueRelation.create"] },
  relationDelete: { route: "sync", operations: ["issueRelation.delete"] },
  commentCreate: {
    route: "conditional",
    operations: ["issueComment.create"],
    legacyWhen: "agentMention is present",
  },
  commentUpdate: { route: "sync", operations: ["issueComment.update"] },
  commentDelete: { route: "sync", operations: ["issueComment.delete"] },
  viewCreate: { route: "sync", operations: ["issueView.create"] },
  viewUpdate: { route: "sync", operations: ["issueView.update"] },
  viewDelete: { route: "sync", operations: ["issueView.delete"] },
  viewsReorder: { route: "sync", operations: ["issueView.update"] },
  setKeyPrefix: { route: "legacy-always", reason: "company configuration" },
  importCsv: { route: "legacy-always", reason: "environment import executor" },
  cancelCommentAgentRun: { route: "legacy-always", reason: "environment agent run" },
  retryCommentAgentRun: { route: "legacy-always", reason: "environment agent run" },
  uploadCommentAttachment: { route: "legacy-always", reason: "attachment byte upload" },
  startEnrichment: { route: "legacy-always", reason: "environment enrichment run" },
  cancelEnrichment: { route: "legacy-always", reason: "environment enrichment run" },
  linkThread: { route: "legacy-always", reason: "web routing remains environment-owned" },
  unlinkThread: { route: "legacy-always", reason: "web routing remains environment-owned" },
  slackSetToken: { route: "legacy-always", reason: "environment Slack integration" },
  slackListChannels: { route: "legacy-always", reason: "environment Slack integration" },
  slackWatchCreate: { route: "legacy-always", reason: "environment Slack integration" },
  slackWatchUpdate: { route: "legacy-always", reason: "environment Slack integration" },
  slackWatchDelete: { route: "legacy-always", reason: "environment Slack integration" },
  triageAccept: { route: "sync", operations: ["issue.update"] },
  triageReject: { route: "sync", operations: ["issue.triageReject"] },
} as const satisfies Record<string, IssueMutationRoute>;
