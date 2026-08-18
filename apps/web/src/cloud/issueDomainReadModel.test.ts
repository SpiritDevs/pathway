import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { cloudEntityCodec, type CloudSyncEntity } from "@spiritdevs/client-runtime/sync";
import { IssueId } from "@spiritdevs/contracts";
import type { SyncEntityKind } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_SYNCED_ISSUE_DOMAIN,
  issueDomainEntityCompanyIdsFromReplicas,
  issueDomainEntityCompanyKey,
  syncedIssueDetailById,
  syncedIssueDomainFromReplica,
  syncedIssueDomainFromReplicas,
} from "./issueDomainReadModel";

function decoded(entityKind: SyncEntityKind, payload: Record<string, unknown>): CloudSyncEntity {
  const codec = cloudEntityCodec(entityKind);
  if (codec === null) throw new Error(`Missing fixture codec for ${entityKind}.`);
  return Option.getOrThrow(codec.decode(payload));
}

function replica(
  ...entities: ReadonlyArray<CloudSyncEntity | unknown>
): CompanyRegistryReplicaState {
  return {
    view: new Map(entities.map((entity, index) => [`fixture:${index}`, entity])),
  };
}

function issue(id: string, keyNumber: number) {
  return decoded("issue", {
    id,
    key: `PAT-${keyNumber}`,
    keyNumber,
    title: `Issue ${keyNumber}`,
    description: "",
    statusId: "status-1",
    priority: "none",
    assignee: null,
    projectId: "project-1",
    milestoneId: null,
    cycleId: null,
    parentId: null,
    sortOrder: `issue-${keyNumber}`,
    labelIds: [],
    dueDate: null,
    triage: false,
    slackSource: null,
    teamIds: [],
    workflowOwner: { kind: "company" },
    workModelSelection: null,
    automationAssignment: null,
    pullRequest: null,
    createdAt: keyNumber,
    updatedAt: keyNumber,
  });
}

function comment(id: string, issueId: string, createdAt: number) {
  return decoded("issueComment", {
    id,
    issueId,
    body: id,
    author: null,
    attachmentIds: [],
    mentions: [],
    createdAt,
    updatedAt: createdAt,
  });
}

function todo(id: string, issueId: string, sortOrder: string) {
  return decoded("issueTodo", {
    id,
    issueId,
    text: id,
    done: false,
    sortOrder,
    createdAt: 1,
    updatedAt: 1,
  });
}

describe("syncedIssueDomainFromReplica", () => {
  it("returns the shared empty model without an active company replica", () => {
    expect(syncedIssueDomainFromReplica(null)).toBe(EMPTY_SYNCED_ISSUE_DOMAIN);
  });

  it("narrows and stably orders the active company's project and issue list entities", () => {
    const selected = syncedIssueDomainFromReplica(
      replica(
        issue("issue-2", 2),
        { entityKind: "futureEntity", id: "ignored" },
        decoded("issueCycle", {
          id: "cycle-1",
          teamId: null,
          name: "Cycle",
          startDate: "2026-08-01",
          endDate: "2026-08-14",
          completedAt: null,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueLabel", {
          id: "label-1",
          teamId: null,
          name: "Bug",
          color: "#ff0000",
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("cloudProject", {
          id: "project-1",
          name: "Pathway",
          description: "Agent client",
          teamIds: [],
          defaultWorkflowOwner: null,
          preferredBindingId: null,
          archivedAt: null,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueStatus", {
          id: "status-1",
          scope: "company",
          teamId: null,
          baseStatusId: null,
          name: "Open",
          color: "#00ff00",
          category: "unstarted",
          position: 1,
          hidden: false,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueMilestone", {
          id: "milestone-1",
          cloudProjectId: "project-1",
          name: "C1",
          description: null,
          startDate: null,
          targetDate: null,
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueView", {
          id: "view-b",
          ownerMembershipId: null,
          visibility: "company",
          teamIds: [],
          name: "B",
          config: {
            tab: "active",
            grouping: "status",
            sortMode: "manual",
            viewMode: "list",
          },
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueView", {
          id: "view-a",
          ownerMembershipId: null,
          visibility: "company",
          teamIds: [],
          name: "A",
          config: {
            tab: "active",
            grouping: "status",
            sortMode: "manual",
            viewMode: "list",
          },
          position: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueView", {
          id: "view-first",
          ownerMembershipId: null,
          visibility: "company",
          teamIds: [],
          name: "First",
          config: {
            tab: "active",
            grouping: "status",
            sortMode: "manual",
            viewMode: "list",
          },
          position: 0,
          createdAt: 1,
          updatedAt: 1,
        }),
        issue("issue-1", 1),
      ),
    );

    expect(selected.cloudProjects.map(({ id }) => id)).toEqual(["project-1"]);
    expect(selected.issues.map(({ id }) => id)).toEqual(["issue-1", "issue-2"]);
    expect(selected.issueStatuses.map(({ id }) => id)).toEqual(["status-1"]);
    expect(selected.issueLabels.map(({ id }) => id)).toEqual(["label-1"]);
    expect(selected.issueMilestones.map(({ id }) => id)).toEqual(["milestone-1"]);
    expect(selected.issueCycles.map(({ id }) => id)).toEqual(["cycle-1"]);
    expect(selected.issueViews.map(({ id }) => id)).toEqual(["view-first", "view-a", "view-b"]);
  });
});

describe("multi-company issue domain", () => {
  it("aggregates scoped replicas while retaining the company that owns each entity", () => {
    const companyA = CompanyId.make("company-a");
    const companyB = CompanyId.make("company-b");
    const replicas = new Map([
      [companyA, replica(issue("issue-a", 2))],
      [
        companyB,
        replica(
          issue("issue-b", 1),
          decoded("issueLabel", {
            id: "label-b",
            teamId: null,
            name: "Beta",
            color: "#ff0000",
            createdAt: 1,
            updatedAt: 1,
          }),
        ),
      ],
    ]);

    const domain = syncedIssueDomainFromReplicas(replicas);
    const companyIds = issueDomainEntityCompanyIdsFromReplicas(replicas);

    expect(domain.issues.map(({ id }) => id)).toEqual(["issue-b", "issue-a"]);
    expect(domain.issueLabels.map(({ id }) => id)).toEqual(["label-b"]);
    expect(companyIds.get(issueDomainEntityCompanyKey("issue", "issue-a"))).toEqual(
      new Set([companyA]),
    );
    expect(companyIds.get(issueDomainEntityCompanyKey("issue", "issue-b"))).toEqual(
      new Set([companyB]),
    );
    expect(companyIds.get(issueDomainEntityCompanyKey("issueLabel", "label-b"))).toEqual(
      new Set([companyB]),
    );
  });
});

describe("syncedIssueDetailById", () => {
  it("composes only the selected issue's tails, including incoming relations", () => {
    const selected = syncedIssueDomainFromReplica(
      replica(
        issue("issue-1", 1),
        issue("issue-2", 2),
        comment("comment-late", "issue-1", 2),
        comment("comment-early", "issue-1", 1),
        comment("comment-other", "issue-2", 1),
        todo("todo-late", "issue-1", "z"),
        todo("todo-early", "issue-1", "a"),
        todo("todo-other", "issue-2", "a"),
        decoded("issueRelation", {
          id: "relation-outgoing",
          issueId: "issue-1",
          relatedIssueId: "issue-2",
          kind: "blocks",
          createdAt: 1,
        }),
        decoded("issueRelation", {
          id: "relation-incoming",
          issueId: "issue-2",
          relatedIssueId: "issue-1",
          kind: "relates",
          createdAt: 2,
        }),
        decoded("issueRelation", {
          id: "relation-other",
          issueId: "issue-2",
          relatedIssueId: "issue-3",
          kind: "relates",
          createdAt: 3,
        }),
        decoded("issueAttachment", {
          id: "attachment-1",
          issueId: "issue-1",
          commentId: "comment-early",
          fileName: "trace.log",
          mimeType: "text/plain",
          byteSize: 10,
          checksum: "checksum",
          uploadedByMembershipId: null,
          state: "finalized",
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueAttachment", {
          id: "attachment-other",
          issueId: "issue-2",
          commentId: null,
          fileName: "other.log",
          mimeType: "text/plain",
          byteSize: 10,
          checksum: "checksum-other",
          uploadedByMembershipId: null,
          state: "finalized",
          createdAt: 1,
          updatedAt: 1,
        }),
        decoded("issueAuditEvent", {
          id: "audit-1",
          issueId: "issue-1",
          kind: "issue.updated",
          actor: { kind: "member", membershipId: "membership-1" },
          payload: {},
          operationId: null,
          createdAt: 1,
        }),
        decoded("issueAuditEvent", {
          id: "audit-other",
          issueId: "issue-2",
          kind: "issue.updated",
          actor: { kind: "member", membershipId: "membership-1" },
          payload: {},
          operationId: null,
          createdAt: 1,
        }),
        decoded("issueThreadLink", {
          id: "thread-link-1",
          issueId: "issue-1",
          environmentId: "environment-1",
          threadId: "thread-1",
          origin: "start-work",
          createdByMembershipId: null,
          createdAt: 1,
        }),
        decoded("issueThreadLink", {
          id: "thread-link-other",
          issueId: "issue-2",
          environmentId: "environment-1",
          threadId: "thread-2",
          origin: "start-work",
          createdByMembershipId: null,
          createdAt: 1,
        }),
      ),
    );

    const detail = syncedIssueDetailById(selected, IssueId.make("issue-1"));
    expect(detail?.issue.id).toBe("issue-1");
    expect(detail?.comments.map(({ id }) => id)).toEqual(["comment-early", "comment-late"]);
    expect(detail?.todos.map(({ id }) => id)).toEqual(["todo-early", "todo-late"]);
    expect(detail?.relations.map(({ id }) => id)).toEqual([
      "relation-outgoing",
      "relation-incoming",
    ]);
    expect(detail?.attachments.map(({ id }) => id)).toEqual(["attachment-1"]);
    expect(detail?.auditEvents.map(({ id }) => id)).toEqual(["audit-1"]);
    expect(detail?.threadLinks.map(({ id }) => id)).toEqual(["thread-link-1"]);
    expect(syncedIssueDetailById(selected, IssueId.make("missing"))).toBeNull();
  });
});
