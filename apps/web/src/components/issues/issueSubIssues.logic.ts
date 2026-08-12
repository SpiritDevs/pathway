import type {
  Issue,
  IssueAssignee,
  IssueCreateInput,
  IssueLabelId,
  IssuePriority,
  IssueStatusId,
} from "@t3tools/contracts";

export interface SubIssueDraft {
  readonly title: string;
  readonly description: string;
  readonly statusId: IssueStatusId | null;
  readonly priority: IssuePriority;
  readonly assignee: IssueAssignee | null;
  readonly labelIds: ReadonlyArray<IssueLabelId>;
}

export function subIssueCreateInput(parent: Issue, draft: SubIssueDraft): IssueCreateInput | null {
  const title = draft.title.trim();
  if (title.length === 0) return null;

  return {
    title,
    parentId: parent.id,
    ...(draft.description.length === 0 ? {} : { description: draft.description }),
    ...(draft.statusId === null ? {} : { statusId: draft.statusId }),
    ...(draft.priority === "none" ? {} : { priority: draft.priority }),
    ...(draft.assignee === null ? {} : { assignee: draft.assignee }),
    ...(parent.projectId === null ? {} : { projectId: parent.projectId }),
    ...(draft.labelIds.length === 0 ? {} : { labelIds: draft.labelIds }),
  };
}
