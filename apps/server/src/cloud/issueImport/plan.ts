// @effect-diagnostics nodeBuiltinImport:off -- deterministic import ids use the platform SHA-256 implementation.
/**
 * Pure issue-import planner for an empty target company.
 *
 * The plan keeps two views of the import side by side:
 *
 * - `entities` is the complete issue-domain state the migration promises to preserve. It retains
 *   historical ids, timestamps, actors, and audit payloads for a dedicated import mutation if M2
 *   needs one.
 * - `operationBatches` contains only normal sync operations, all built with
 *   `issueSyncOperation`. Comparing these operations with `entities` is the fidelity research
 *   deliverable: the normal handlers are command handlers, not historical row upserts.
 *
 * Dependency order follows the real checks in `convex/lib/issueApply.ts`: tracker configuration
 * and cloud projects are prerequisites; catalog rows precede issues; issues precede their todos,
 * relations, comments, attachments, and thread links; issue tombstones are delayed until all live
 * child creates have run; audit history is last. Attachments must actually upload and finalize
 * before comments name them, even though neither upload nor audit insertion has a normal sync
 * operation. Views are placed with dependents after the catalog their filters may name.
 *
 * ## Normal-push fidelity verdict
 *
 * Normal create handlers preserve domain ids and the command fields their argument schemas carry,
 * but universally stamp `createdAt`/`updatedAt` from `Date.now()`. The envelope's asserted actor is
 * ignored for authority and attribution; `sync.applyOperations` derives the actor from the token.
 * Issue mutations generate new audit events at import time rather than accepting old history.
 * Attachments and audit events have no operation kind at all. The exported
 * `NORMAL_PUSH_FIDELITY` table records the per-kind details used to decide M2's write path.
 *
 * @module cloud/issueImport/plan
 */
import * as NodeCrypto from "node:crypto";

import {
  EnvironmentId,
  IssueEventId,
  IssueKeyPrefix,
  type IssueActor,
  type IssueAssignee,
} from "@spiritdevs/contracts";
import { SyncEntityId, SyncOperationId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import {
  ISSUE_SYNC_ENTITY_KINDS,
  issueSyncOperation,
  type IssueAttachmentEntity,
  type IssueAuditEventEntity,
  type IssueCommentEntity,
  type IssueCycleEntity,
  type IssueEntity,
  type IssueLabelEntity,
  type IssueMilestoneEntity,
  type IssueRelationEntity,
  type IssueStatusEntity,
  type IssueSyncEntity,
  type IssueSyncEntityKind,
  type IssueSyncOperation,
  type IssueThreadLinkEntity,
  type IssueTodoEntity,
  type IssueViewEntity,
} from "@spiritdevs/client-runtime/sync";

import type { LocalIssueSnapshot, LocalIssueSnapshotAttachment } from "./snapshot.ts";

export interface IssueImportPlanConfig {
  readonly companyId: CompanyId;
  readonly importingMembershipId: MembershipId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly importRunId: string;
  readonly selectedIssueKeyPrefix: IssueKeyPrefix;
}

export type IssueImportBatchStage =
  | "trackerConfig"
  | "catalog"
  | "issues"
  | "attachments"
  | "dependents"
  | "tombstones"
  | "history";

export interface PlannedIssueImportOperation {
  readonly operationId: SyncOperationId;
  readonly entityKind: IssueSyncEntityKind;
  readonly sourceEntity: IssueSyncEntity;
  readonly operation: IssueSyncOperation;
}

export interface IssueImportOperationBatch {
  readonly stage: IssueImportBatchStage;
  readonly operations: ReadonlyArray<PlannedIssueImportOperation>;
}

/** Upload descriptor only; M1 never opens the file or sends bytes. */
export interface PlannedIssueAttachmentUpload {
  readonly sourceEntity: IssueAttachmentEntity;
  readonly filePath: string;
}

export interface IssueImportRejectedRecord {
  readonly entityKind: IssueSyncEntityKind | "trackerConfig";
  readonly entityId: string;
  readonly reason: string;
}

export type IssueImportFidelitySubject = IssueSyncEntityKind | "trackerConfig";

export interface IssueImportFidelityVerdict {
  readonly entityKind: IssueImportFidelitySubject;
  readonly verdict: "preserved" | "partial" | "not-supported";
  readonly preserved: ReadonlyArray<string>;
  readonly gaps: ReadonlyArray<{
    readonly fields: ReadonlyArray<string>;
    readonly normalPushBehavior: string;
  }>;
}

/**
 * Field-by-field result of tracing `sync.applyOperations` into `lib/issueApply.ts`.
 *
 * This is static because it describes the protocol implementation, not one snapshot. Every plan
 * returns the same list so a dry-run consumer does not need source-code knowledge to warn before
 * confirmation.
 */
export const NORMAL_PUSH_FIDELITY: ReadonlyArray<IssueImportFidelityVerdict> = [
  {
    entityKind: "trackerConfig",
    verdict: "not-supported",
    preserved: [],
    gaps: [
      {
        fields: ["issueKeyPrefix", "nextIssueNumber"],
        normalPushBehavior:
          "There is no issue-domain operation for company key configuration. issue.create validates the existing company prefix/range and only advances the counter after an accepted key.",
      },
    ],
  },
  {
    entityKind: "issueStatus",
    verdict: "partial",
    preserved: [
      "id",
      "scope",
      "teamId",
      "baseStatusId",
      "name",
      "color",
      "category",
      "position",
      "hidden",
    ],
    gaps: [
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueStatus.create stamps both fields with the mutation clock.",
      },
    ],
  },
  {
    entityKind: "issueLabel",
    verdict: "partial",
    preserved: ["id", "teamId", "name", "color"],
    gaps: [
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueLabel.create stamps both fields with the mutation clock.",
      },
    ],
  },
  {
    entityKind: "issueMilestone",
    verdict: "partial",
    preserved: [
      "id",
      "cloudProjectId",
      "name",
      "description",
      "startDate",
      "targetDate",
      "position",
    ],
    gaps: [
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueMilestone.create stamps both fields with the mutation clock.",
      },
      {
        fields: ["cloudProjectId"],
        normalPushBehavior:
          "The referenced cloud project must already exist and be permission-visible; project creation is not an issue-domain operation.",
      },
    ],
  },
  {
    entityKind: "issueCycle",
    verdict: "partial",
    preserved: ["id", "teamId", "name", "startDate", "endDate"],
    gaps: [
      {
        fields: ["completedAt"],
        normalPushBehavior:
          "issueCycle.create always initializes completedAt to null and no sync operation can set it.",
      },
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueCycle.create stamps both fields with the mutation clock.",
      },
    ],
  },
  {
    entityKind: "issue",
    verdict: "partial",
    preserved: [
      "id",
      "key (only when the target prefix and accepted range already permit it)",
      "title",
      "description",
      "statusId",
      "priority",
      "assignee",
      "projectId",
      "milestoneId",
      "cycleId",
      "parentId",
      "sortOrder",
      "labelIds",
      "dueDate",
      "triage",
      "teamIds",
      "workflowOwner",
      "workModelSelection",
    ],
    gaps: [
      {
        fields: ["createdAt", "updatedAt", "deletedAt"],
        normalPushBehavior:
          "Create and delete stamp the mutation clock; the historical deletion time is not accepted.",
      },
      {
        fields: ["slackSource", "automationAssignment", "pullRequest"],
        normalPushBehavior:
          "issue.create ignores source values and initializes these fields to null.",
      },
      {
        fields: ["audit actor", "audit history"],
        normalPushBehavior:
          "The handler appends a new import-time created event using the authenticated token actor.",
      },
      {
        fields: ["key"],
        normalPushBehavior:
          "A preserved key with another prefix or outside nextIssueNumber plus the lease block is rejected before insertion.",
      },
    ],
  },
  {
    entityKind: "issueTodo",
    verdict: "partial",
    preserved: ["id", "issueId", "text", "sortOrder", "done (through a dependent update)"],
    gaps: [
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior:
          "Create/update stamp the mutation clock; local todo rows do not carry historical timestamps to restore.",
      },
    ],
  },
  {
    entityKind: "issueRelation",
    verdict: "partial",
    preserved: ["id", "issueId", "relatedIssueId", "kind"],
    gaps: [
      {
        fields: ["createdAt"],
        normalPushBehavior:
          "issueRelation.create stamps createdAt with the mutation clock; local relation rows do not carry a source timestamp.",
      },
    ],
  },
  {
    entityKind: "issueAttachment",
    verdict: "not-supported",
    preserved: [],
    gaps: [
      {
        fields: [
          "id",
          "issueId",
          "commentId",
          "fileName",
          "mimeType",
          "byteSize",
          "checksum",
          "uploadedByMembershipId",
          "state",
          "createdAt",
          "updatedAt",
        ],
        normalPushBehavior:
          "There is no issueAttachment operation. A separate upload/finalize API must create the row before a comment can reference it.",
      },
    ],
  },
  {
    entityKind: "issueComment",
    verdict: "partial",
    preserved: ["id", "issueId", "body", "attachmentIds (only after separate finalized uploads)"],
    gaps: [
      {
        fields: ["author"],
        normalPushBehavior:
          "issueComment.create overwrites the source author with the authenticated token actor.",
      },
      {
        fields: ["mentions"],
        normalPushBehavior: "issueComment.create initializes mentions to an empty array.",
      },
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueComment.create stamps both fields with the mutation clock.",
      },
    ],
  },
  {
    entityKind: "issueThreadLink",
    verdict: "partial",
    preserved: ["id", "issueId", "environmentId", "threadId", "origin"],
    gaps: [
      {
        fields: ["createdByMembershipId"],
        normalPushBehavior:
          "The handler derives this from the authenticated member, or stores null for a service actor.",
      },
      {
        fields: ["createdAt"],
        normalPushBehavior: "issueThreadLink.create stamps createdAt with the mutation clock.",
      },
      {
        fields: ["environmentId"],
        normalPushBehavior:
          "The stamped source environment must already have an active target-company registration visible to the actor.",
      },
    ],
  },
  {
    entityKind: "issueView",
    verdict: "partial",
    preserved: ["id", "visibility", "teamIds", "name", "config", "position"],
    gaps: [
      {
        fields: ["ownerMembershipId"],
        normalPushBehavior:
          "issueView.create always owns the view with the authenticated member; it matches only when that member is the importer.",
      },
      {
        fields: ["createdAt", "updatedAt"],
        normalPushBehavior: "issueView.create stamps both fields with the mutation clock.",
      },
    ],
  },
  {
    entityKind: "issueAuditEvent",
    verdict: "not-supported",
    preserved: [],
    gaps: [
      {
        fields: ["id", "issueId", "kind", "actor", "payload", "operationId", "createdAt"],
        normalPushBehavior:
          "There is no issueAuditEvent operation. Normal issue mutations generate different events with import-time ids, actor, payload, and timestamps.",
      },
    ],
  },
];

export interface IssueImportPreview {
  readonly counts: Readonly<Record<IssueSyncEntityKind, number>>;
  readonly issueKeyRange: {
    readonly first: string | null;
    readonly last: string | null;
    readonly lowestNumber: number | null;
    readonly highestNumber: number | null;
  };
  readonly nextIssueNumber: number;
  readonly attachments: { readonly count: number; readonly totalBytes: number };
  readonly rejected: ReadonlyArray<IssueImportRejectedRecord>;
}

export interface IssueImportPlan {
  readonly mode: "empty-company";
  readonly companyId: CompanyId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly importRunId: string;
  readonly trackerConfig: {
    readonly sourcePrefix: IssueKeyPrefix;
    readonly selectedPrefix: IssueKeyPrefix;
    readonly sourceNextNumber: number;
    readonly nextIssueNumber: number;
  };
  readonly entities: ReadonlyArray<IssueSyncEntity>;
  readonly attachmentUploads: ReadonlyArray<PlannedIssueAttachmentUpload>;
  readonly operationBatches: ReadonlyArray<IssueImportOperationBatch>;
  readonly preview: IssueImportPreview;
  readonly fidelityGaps: ReadonlyArray<IssueImportFidelityVerdict>;
}

/** RFC-4122 name-based UUID layout over a SHA-256 digest. */
function uuidFromDigest(digest: string): string {
  const bytes = Buffer.from(digest.slice(0, 32), "hex");
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableUuid(parts: ReadonlyArray<string>): string {
  return uuidFromDigest(
    NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex"),
  );
}

/**
 * Stable exactly-once key. The operation-kind discriminator is needed only because a source entity
 * can require more than one command (a completed todo or a soft-deleted issue); entity kind remains
 * in the hash so equal domain ids in different tables cannot collide.
 */
export function issueImportOperationId(
  config: Pick<IssueImportPlanConfig, "sourceEnvironmentId" | "importRunId">,
  entityKind: IssueSyncEntityKind,
  entityId: string,
  operationKind: IssueSyncOperation["kind"],
): SyncOperationId {
  return SyncOperationId.make(
    stableUuid([
      config.sourceEnvironmentId,
      config.importRunId,
      entityKind,
      entityId,
      operationKind,
    ]),
  );
}

function threadLinkEntityId(sourceEnvironmentId: EnvironmentId, issueId: string, threadId: string) {
  return SyncEntityId.make(stableUuid(["issueThreadLink", sourceEnvironmentId, issueId, threadId]));
}

function issueIdentityEventId(config: IssueImportPlanConfig, issueId: string): IssueEventId {
  return IssueEventId.make(
    stableUuid(["issueKeyIdentity", config.sourceEnvironmentId, config.importRunId, issueId]),
  );
}

function epoch(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function issueNumber(key: string): number | null {
  const match = /^(.*)-(\d+)$/.exec(key);
  if (match === null) return null;
  const value = Number(match[2]);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function issuePrefix(key: string): string | null {
  const split = key.lastIndexOf("-");
  return split > 0 ? key.slice(0, split) : null;
}

function mapAssignee(
  assignee: IssueAssignee | null,
  importingMembershipId: MembershipId,
): IssueAssignee | null {
  return assignee?.kind === "user"
    ? { kind: "member", membershipId: importingMembershipId }
    : assignee;
}

function mapActor(actor: IssueActor, importingMembershipId: MembershipId): SyncActor {
  switch (actor.kind) {
    case "user":
      return { kind: "member", membershipId: importingMembershipId };
    case "member":
      return actor;
    case "agent":
      return { ...actor, onBehalfOfMembershipId: importingMembershipId };
    case "system":
      return actor;
  }
}

function todoSortOrder(position: number): string {
  const whole = Math.max(0, Math.trunc(position));
  return whole.toString().padStart(16, "0");
}

function issuesParentFirst(
  issues: LocalIssueSnapshot["issues"],
): ReadonlyArray<LocalIssueSnapshot["issues"][number]> {
  const remaining = [...issues];
  const ordered: Array<LocalIssueSnapshot["issues"][number]> = [];
  const emitted = new Set<string>();
  while (remaining.length > 0) {
    const before = remaining.length;
    for (let index = 0; index < remaining.length; ) {
      const issue = remaining[index];
      if (issue === undefined) break;
      if (issue.parentId !== null && !emitted.has(issue.parentId)) {
        index += 1;
        continue;
      }
      ordered.push(issue);
      emitted.add(issue.id);
      remaining.splice(index, 1);
    }
    // Local validation normally makes this impossible. Retaining the remaining stable order lets
    // the reference check below surface the corrupt cycle/missing parent instead of hanging M1.
    if (remaining.length === before) {
      ordered.push(...remaining);
      break;
    }
  }
  return ordered;
}

function emptyCounts(): Record<IssueSyncEntityKind, number> {
  return Object.fromEntries(ISSUE_SYNC_ENTITY_KINDS.map((kind) => [kind, 0])) as Record<
    IssueSyncEntityKind,
    number
  >;
}

function attachmentSourceEntity(
  attachment: LocalIssueSnapshotAttachment,
  config: IssueImportPlanConfig,
): IssueAttachmentEntity | null {
  const createdAt = epoch(attachment.createdAt);
  const updatedAt = epoch(attachment.updatedAt);
  if (attachment.byteSize === null || createdAt === null || updatedAt === null) return null;
  return {
    entityKind: "issueAttachment",
    id: attachment.id,
    issueId: attachment.issueId,
    commentId: attachment.commentId,
    fileName: attachment.fileName,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    // M1 intentionally does not read bytes. M2 replaces this planning sentinel while streaming the
    // upload and only then finalizes the authoritative attachment row.
    checksum: "deferred-to-upload",
    uploadedByMembershipId: config.importingMembershipId,
    state: "pending",
    createdAt,
    updatedAt,
  };
}

/** Builds a deterministic, dry-run-only import plan for an empty target company. */
export function planIssueImport(
  snapshot: LocalIssueSnapshot,
  config: IssueImportPlanConfig,
): IssueImportPlan {
  const entities: IssueSyncEntity[] = [];
  const rejected: IssueImportRejectedRecord[] = [];
  const attachmentUploads: PlannedIssueAttachmentUpload[] = [];
  const issueIdentityEvents: IssueAuditEventEntity[] = [];
  const batches: Record<IssueImportBatchStage, PlannedIssueImportOperation[]> = {
    trackerConfig: [],
    catalog: [],
    issues: [],
    attachments: [],
    dependents: [],
    tombstones: [],
    history: [],
  };
  const createIdByEntity = new Map<string, SyncOperationId>();

  const addOperation = (
    stage: IssueImportBatchStage,
    entity: IssueSyncEntity,
    operation: IssueSyncOperation,
  ): SyncOperationId => {
    const operationId = issueImportOperationId(
      config,
      entity.entityKind,
      entity.id,
      operation.kind,
    );
    batches[stage].push({
      operationId,
      entityKind: entity.entityKind,
      sourceEntity: entity,
      operation,
    });
    if (operation.kind.endsWith(".create")) {
      createIdByEntity.set(`${entity.entityKind}\u0000${entity.id}`, operationId);
    }
    return operationId;
  };

  const dependencies = (...keys: ReadonlyArray<readonly [IssueSyncEntityKind, string | null]>) =>
    keys.flatMap(([kind, id]) => {
      if (id === null || id === "") return [];
      const operationId = createIdByEntity.get(`${kind}\u0000${id}`);
      return operationId === undefined ? [] : [operationId];
    });

  for (const status of snapshot.statuses) {
    const createdAt = epoch(status.createdAt);
    const updatedAt = epoch(status.updatedAt);
    if (createdAt === null || updatedAt === null) {
      rejected.push({
        entityKind: "issueStatus",
        entityId: status.id,
        reason: "Invalid status timestamp.",
      });
      continue;
    }
    const entity: IssueStatusEntity = {
      entityKind: "issueStatus",
      id: status.id,
      scope: "company",
      teamId: null,
      baseStatusId: null,
      name: status.name,
      color: status.color,
      category: status.category,
      position: status.position,
      hidden: false,
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    addOperation(
      "catalog",
      entity,
      issueSyncOperation({
        kind: "issueStatus.create",
        entityId: SyncEntityId.make(status.id),
        args: {
          scope: "company",
          teamId: null,
          baseStatusId: null,
          name: status.name,
          color: status.color,
          category: status.category,
          position: status.position,
          hidden: false,
        },
      }),
    );
  }

  for (const label of snapshot.labels) {
    const createdAt = epoch(label.createdAt);
    if (createdAt === null) {
      rejected.push({
        entityKind: "issueLabel",
        entityId: label.id,
        reason: "Invalid label timestamp.",
      });
      continue;
    }
    const entity: IssueLabelEntity = {
      entityKind: "issueLabel",
      id: label.id,
      teamId: null,
      name: label.name,
      color: label.color,
      createdAt,
      updatedAt: createdAt,
    };
    entities.push(entity);
    addOperation(
      "catalog",
      entity,
      issueSyncOperation({
        kind: "issueLabel.create",
        entityId: SyncEntityId.make(label.id),
        args: { name: label.name, color: label.color, teamId: null },
      }),
    );
  }

  for (const milestone of snapshot.milestones) {
    const createdAt = epoch(milestone.createdAt);
    const updatedAt = epoch(milestone.updatedAt);
    if (createdAt === null || updatedAt === null) {
      rejected.push({
        entityKind: "issueMilestone",
        entityId: milestone.id,
        reason: "Invalid milestone timestamp.",
      });
      continue;
    }
    const cloudProjectId = CloudProjectId.make(milestone.projectId);
    const entity: IssueMilestoneEntity = {
      entityKind: "issueMilestone",
      id: milestone.id,
      cloudProjectId,
      name: milestone.name,
      description: milestone.description,
      startDate: milestone.startDate,
      targetDate: milestone.targetDate,
      position: milestone.position,
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    addOperation(
      "catalog",
      entity,
      issueSyncOperation({
        kind: "issueMilestone.create",
        entityId: SyncEntityId.make(milestone.id),
        args: {
          cloudProjectId,
          name: milestone.name,
          description: milestone.description ?? undefined,
          startDate: milestone.startDate ?? undefined,
          targetDate: milestone.targetDate ?? undefined,
          position: milestone.position,
        },
      }),
    );
  }

  for (const cycle of snapshot.cycles) {
    const createdAt = epoch(cycle.createdAt);
    const updatedAt = epoch(cycle.updatedAt);
    const completedAt = cycle.completedAt === null ? null : epoch(cycle.completedAt);
    if (
      createdAt === null ||
      updatedAt === null ||
      (cycle.completedAt !== null && completedAt === null)
    ) {
      rejected.push({
        entityKind: "issueCycle",
        entityId: cycle.id,
        reason: "Invalid cycle timestamp.",
      });
      continue;
    }
    const entity: IssueCycleEntity = {
      entityKind: "issueCycle",
      id: cycle.id,
      teamId: null,
      name: cycle.name,
      startDate: cycle.startDate,
      endDate: cycle.endDate,
      completedAt,
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    addOperation(
      "catalog",
      entity,
      issueSyncOperation({
        kind: "issueCycle.create",
        entityId: SyncEntityId.make(cycle.id),
        args: {
          name: cycle.name,
          startDate: cycle.startDate,
          endDate: cycle.endDate,
          teamId: null,
        },
      }),
    );
  }

  const issueEntities = new Map<string, IssueEntity>();
  // Parent references may point forward in repository order. Pre-register every issue create id so
  // dependency construction is independent of row order; the actual operation is still emitted in
  // the deterministic snapshot order below.
  for (const issue of snapshot.issues) {
    if (
      issueNumber(issue.key) !== null &&
      epoch(issue.createdAt) !== null &&
      epoch(issue.updatedAt) !== null &&
      issuePrefix(issue.key) === config.selectedIssueKeyPrefix
    ) {
      createIdByEntity.set(
        `issue\u0000${issue.id}`,
        issueImportOperationId(config, "issue", issue.id, "issue.create"),
      );
    }
  }
  for (const issue of issuesParentFirst(snapshot.issues)) {
    const keyNumber = issueNumber(issue.key);
    const createdAt = epoch(issue.createdAt);
    const updatedAt = epoch(issue.updatedAt);
    if (keyNumber === null || createdAt === null || updatedAt === null) {
      rejected.push({
        entityKind: "issue",
        entityId: issue.id,
        reason: "Invalid issue key or timestamp.",
      });
      continue;
    }
    const entity: IssueEntity = {
      entityKind: "issue",
      id: issue.id,
      key: issue.key,
      keyNumber,
      title: issue.title,
      description: issue.description,
      statusId: issue.statusId,
      priority: issue.priority,
      assignee: mapAssignee(issue.assignee, config.importingMembershipId),
      projectId: issue.projectId === null ? null : CloudProjectId.make(issue.projectId),
      milestoneId: issue.milestoneId,
      cycleId: issue.cycleId,
      parentId: issue.parentId,
      sortOrder: issue.sortOrder,
      labelIds: [...issue.labelIds],
      dueDate: issue.dueDate,
      triage: issue.triage,
      slackSource: issue.slackSource,
      teamIds: [],
      workflowOwner: { kind: "company" },
      workModelSelection: issue.workModelSelection ?? null,
      automationAssignment: issue.automationAssignment ?? null,
      pullRequest: issue.pullRequest ?? null,
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    issueEntities.set(issue.id, entity);

    if (issuePrefix(issue.key) !== config.selectedIssueKeyPrefix) {
      rejected.push({
        entityKind: "issue",
        entityId: issue.id,
        reason: `Preserved key ${issue.key} does not match selected prefix ${config.selectedIssueKeyPrefix}; the normal create path would reject it.`,
      });
      continue;
    }
    const missingReference = [
      ...(issue.statusId === "" ? [] : [["issueStatus", issue.statusId] as const]),
      ...issue.labelIds.map((id) => ["issueLabel", id] as const),
      ...(issue.milestoneId === null ? [] : [["issueMilestone", issue.milestoneId] as const]),
      ...(issue.cycleId === null ? [] : [["issueCycle", issue.cycleId] as const]),
      ...(issue.parentId === null ? [] : [["issue", issue.parentId] as const]),
    ].find(([kind, id]) =>
      kind === "issue"
        ? !snapshot.issues.some((candidate) => candidate.id === id)
        : !entities.some((candidate) => candidate.entityKind === kind && candidate.id === id),
    );
    if (missingReference !== undefined) {
      rejected.push({
        entityKind: "issue",
        entityId: issue.id,
        reason: `Missing ${missingReference[0]} dependency ${missingReference[1]}.`,
      });
      createIdByEntity.delete(`issue\u0000${issue.id}`);
      continue;
    }
    const dependencyIds = dependencies(
      ["issueStatus", issue.statusId],
      ...issue.labelIds.map((id) => ["issueLabel", id] as const),
      ["issueMilestone", issue.milestoneId],
      ["issueCycle", issue.cycleId],
      ["issue", issue.parentId],
    );
    const createId = addOperation(
      "issues",
      entity,
      issueSyncOperation({
        kind: "issue.create",
        entityId: SyncEntityId.make(issue.id),
        dependsOn: dependencyIds,
        args: {
          key: issue.key,
          title: issue.title,
          description: issue.description,
          statusId: issue.statusId,
          priority: issue.priority,
          assignee: entity.assignee ?? undefined,
          projectId: entity.projectId ?? undefined,
          milestoneId: issue.milestoneId ?? undefined,
          cycleId: issue.cycleId ?? undefined,
          parentId: issue.parentId ?? undefined,
          labelIds: [...issue.labelIds],
          dueDate: issue.dueDate ?? undefined,
          triage: issue.triage,
          sortOrder: issue.sortOrder,
          teamIds: [],
          workflowOwner: { kind: "company" },
          workModelSelection: issue.workModelSelection ?? null,
        },
      }),
    );
    issueIdentityEvents.push({
      entityKind: "issueAuditEvent",
      id: issueIdentityEventId(config, issue.id),
      issueId: issue.id,
      kind: "imported",
      actor: { kind: "system", source: "import" },
      payload: { key: issue.key },
      operationId: null,
      createdAt,
    });
    if (issue.deletedAt !== null) {
      addOperation(
        "tombstones",
        entity,
        issueSyncOperation({
          kind: "issue.delete",
          entityId: SyncEntityId.make(issue.id),
          dependsOn: [createId],
          args: {},
        }),
      );
    }
  }

  for (const todo of snapshot.todos) {
    const entity: IssueTodoEntity = {
      entityKind: "issueTodo",
      id: todo.id,
      issueId: todo.issueId,
      text: todo.text,
      done: todo.done,
      sortOrder: todoSortOrder(todo.position),
      createdAt: snapshot.capturedAt,
      updatedAt: snapshot.capturedAt,
    };
    entities.push(entity);
    const issueDependency = dependencies(["issue", todo.issueId]);
    if (!issueEntities.has(todo.issueId)) {
      rejected.push({
        entityKind: "issueTodo",
        entityId: todo.id,
        reason: `Missing parent issue ${todo.issueId}.`,
      });
      continue;
    }
    const createId = addOperation(
      "dependents",
      entity,
      issueSyncOperation({
        kind: "issueTodo.create",
        entityId: SyncEntityId.make(todo.id),
        dependsOn: issueDependency,
        args: { issueId: todo.issueId, text: todo.text, sortOrder: entity.sortOrder },
      }),
    );
    if (todo.done) {
      addOperation(
        "dependents",
        entity,
        issueSyncOperation({
          kind: "issueTodo.update",
          entityId: SyncEntityId.make(todo.id),
          dependsOn: [createId],
          args: { done: true },
        }),
      );
    }
  }

  for (const relation of snapshot.relations) {
    const entity: IssueRelationEntity = {
      entityKind: "issueRelation",
      id: relation.id,
      issueId: relation.issueId,
      relatedIssueId: relation.relatedIssueId,
      kind: relation.kind,
      createdAt: snapshot.capturedAt,
    };
    entities.push(entity);
    if (!issueEntities.has(relation.issueId) || !issueEntities.has(relation.relatedIssueId)) {
      rejected.push({
        entityKind: "issueRelation",
        entityId: relation.id,
        reason: "A related issue is missing from the snapshot.",
      });
      continue;
    }
    addOperation(
      "dependents",
      entity,
      issueSyncOperation({
        kind: "issueRelation.create",
        entityId: SyncEntityId.make(relation.id),
        dependsOn: dependencies(["issue", relation.issueId], ["issue", relation.relatedIssueId]),
        args: {
          issueId: relation.issueId,
          relatedIssueId: relation.relatedIssueId,
          kind: relation.kind,
        },
      }),
    );
  }

  const uploadableAttachmentIds = new Set<string>();
  for (const attachment of snapshot.attachments) {
    const entity = attachmentSourceEntity(attachment, config);
    if (entity === null || attachment.filePath === null) {
      rejected.push({
        entityKind: "issueAttachment",
        entityId: attachment.id,
        reason: "The attachment file is missing, unreadable, or has invalid timestamps.",
      });
      continue;
    }
    entities.push(entity);
    uploadableAttachmentIds.add(attachment.id);
    attachmentUploads.push({ sourceEntity: entity, filePath: attachment.filePath });
  }

  for (const comment of snapshot.comments) {
    const createdAt = epoch(comment.createdAt);
    const updatedAt = epoch(comment.editedAt ?? comment.createdAt);
    if (createdAt === null || updatedAt === null) {
      rejected.push({
        entityKind: "issueComment",
        entityId: comment.id,
        reason: "Invalid comment timestamp.",
      });
      continue;
    }
    const attachmentIds = comment.attachmentIds.filter((id) => uploadableAttachmentIds.has(id));
    const entity: IssueCommentEntity = {
      entityKind: "issueComment",
      id: comment.id,
      issueId: comment.issueId,
      body: comment.body,
      author: mapActor(comment.author, config.importingMembershipId),
      attachmentIds,
      mentions: [...comment.mentions],
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    if (!issueEntities.has(comment.issueId)) {
      rejected.push({
        entityKind: "issueComment",
        entityId: comment.id,
        reason: `Missing parent issue ${comment.issueId}.`,
      });
      continue;
    }
    addOperation(
      "dependents",
      entity,
      issueSyncOperation({
        kind: "issueComment.create",
        entityId: SyncEntityId.make(comment.id),
        dependsOn: dependencies(["issue", comment.issueId]),
        args: {
          issueId: comment.issueId,
          body: comment.body,
          attachmentIds,
        },
      }),
    );
  }

  for (const link of snapshot.threadLinks) {
    const createdAt = epoch(link.createdAt);
    const id = threadLinkEntityId(config.sourceEnvironmentId, link.issueId, link.threadId);
    if (createdAt === null) {
      rejected.push({
        entityKind: "issueThreadLink",
        entityId: id,
        reason: "Invalid thread-link timestamp.",
      });
      continue;
    }
    const entity: IssueThreadLinkEntity = {
      entityKind: "issueThreadLink",
      id,
      issueId: link.issueId,
      environmentId: config.sourceEnvironmentId,
      threadId: link.threadId,
      origin: link.origin,
      createdByMembershipId: config.importingMembershipId,
      createdAt,
    };
    entities.push(entity);
    if (!issueEntities.has(link.issueId)) {
      rejected.push({
        entityKind: "issueThreadLink",
        entityId: id,
        reason: `Missing parent issue ${link.issueId}.`,
      });
      continue;
    }
    addOperation(
      "dependents",
      entity,
      issueSyncOperation({
        kind: "issueThreadLink.create",
        entityId: id,
        dependsOn: dependencies(["issue", link.issueId]),
        args: {
          issueId: link.issueId,
          environmentId: config.sourceEnvironmentId,
          threadId: link.threadId,
          origin: link.origin,
        },
      }),
    );
  }

  for (const view of snapshot.views) {
    const createdAt = epoch(view.createdAt);
    const updatedAt = epoch(view.updatedAt);
    if (createdAt === null || updatedAt === null) {
      rejected.push({
        entityKind: "issueView",
        entityId: view.id,
        reason: "Invalid view timestamp.",
      });
      continue;
    }
    const entity: IssueViewEntity = {
      entityKind: "issueView",
      id: view.id,
      ownerMembershipId: config.importingMembershipId,
      visibility: "company",
      teamIds: [],
      name: view.name,
      config: view.config,
      position: view.position,
      createdAt,
      updatedAt,
    };
    entities.push(entity);
    addOperation(
      "dependents",
      entity,
      issueSyncOperation({
        kind: "issueView.create",
        entityId: SyncEntityId.make(view.id),
        args: {
          name: view.name,
          config: view.config,
          visibility: "company",
          teamIds: [],
          position: view.position,
        },
      }),
    );
  }

  for (const event of snapshot.auditEvents) {
    const createdAt = epoch(event.createdAt);
    if (createdAt === null) {
      rejected.push({
        entityKind: "issueAuditEvent",
        entityId: event.id,
        reason: "Invalid audit-event timestamp.",
      });
      continue;
    }
    const entity: IssueAuditEventEntity = {
      entityKind: "issueAuditEvent",
      id: IssueEventId.make(event.id),
      issueId: event.issueId,
      kind: event.kind,
      actor: mapActor(event.actor, config.importingMembershipId),
      payload: { field: event.field, before: event.before, after: event.after },
      operationId: null,
      createdAt,
    };
    entities.push(entity);
  }
  entities.push(...issueIdentityEvents);

  const counts = emptyCounts();
  counts.issue = snapshot.issues.length;
  counts.issueStatus = snapshot.statuses.length;
  counts.issueLabel = snapshot.labels.length;
  counts.issueMilestone = snapshot.milestones.length;
  counts.issueCycle = snapshot.cycles.length;
  counts.issueTodo = snapshot.todos.length;
  counts.issueRelation = snapshot.relations.length;
  counts.issueComment = snapshot.comments.length;
  counts.issueAttachment = snapshot.attachments.length;
  counts.issueView = snapshot.views.length;
  counts.issueAuditEvent = snapshot.auditEvents.length + issueIdentityEvents.length;
  counts.issueThreadLink = snapshot.threadLinks.length;

  const keyed = snapshot.issues
    .flatMap((issue) => {
      const number = issueNumber(issue.key);
      return number === null ? [] : [{ key: issue.key, number }];
    })
    .sort((left, right) => left.number - right.number || left.key.localeCompare(right.key));
  const highestNumber = keyed.at(-1)?.number ?? null;
  const nextIssueNumber = Math.max(
    snapshot.trackerConfig.nextNumber,
    highestNumber === null ? 1 : highestNumber + 1,
  );

  const stageOrder: ReadonlyArray<IssueImportBatchStage> = [
    "trackerConfig",
    "catalog",
    "issues",
    "attachments",
    "dependents",
    "tombstones",
    "history",
  ];

  return {
    mode: "empty-company",
    companyId: config.companyId,
    sourceEnvironmentId: config.sourceEnvironmentId,
    importRunId: config.importRunId,
    trackerConfig: {
      sourcePrefix: snapshot.trackerConfig.keyPrefix,
      selectedPrefix: config.selectedIssueKeyPrefix,
      sourceNextNumber: snapshot.trackerConfig.nextNumber,
      nextIssueNumber,
    },
    entities,
    attachmentUploads,
    operationBatches: stageOrder.map((stage) => ({ stage, operations: batches[stage] })),
    preview: {
      counts,
      issueKeyRange: {
        first: keyed.at(0)?.key ?? null,
        last: keyed.at(-1)?.key ?? null,
        lowestNumber: keyed.at(0)?.number ?? null,
        highestNumber,
      },
      nextIssueNumber,
      attachments: {
        count: snapshot.attachments.length,
        totalBytes: snapshot.attachments.reduce(
          (total, attachment) => total + (attachment.byteSize ?? 0),
          0,
        ),
      },
      rejected,
    },
    fidelityGaps: NORMAL_PUSH_FIDELITY,
  };
}
