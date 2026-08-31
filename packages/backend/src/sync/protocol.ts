/**
 * Wire-level constants and vocabulary for the Convex sync protocol.
 *
 * **`packages/contracts/src/cloudSync.ts` is the source of truth.** Every constant, literal set,
 * and union below mirrors it exactly. The duplication exists because `packages/backend` deploys to
 * Convex and cannot depend on Effect Schema; when the two disagree, the contract wins and this file
 * is what changes.
 *
 * Bounds live here rather than at each call site because a client has to respect the same numbers
 * the server enforces — an outbox that batches 50 operations only discovers the limit by being
 * rejected.
 *
 * @module sync/protocol
 */

export const SYNC_PROTOCOL_VERSION = 1;
/** Oldest protocol a current deployment still accepts; older clients get `upgrade-required`. */
export const SYNC_PROTOCOL_MIN_SUPPORTED_VERSION = 1;

export const SYNC_MAX_OPERATIONS_PER_BATCH = 25;
export const SYNC_MAX_OPERATION_ARGS_BYTES = 512 * 1024;

export const SYNC_MAX_CHANGES_PER_PAGE = 100;
/** Byte ceiling for one `listChanges` response, well under the Convex read/transaction limits. */
export const SYNC_MAX_CHANGE_PAGE_BYTES = 1024 * 1024;

/** Change feed and operation receipts are pruned at 90 days; audit history is not. */
export const SYNC_FEED_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export const SYNC_BOOTSTRAP_PAGE_SIZE = 200;

/** The version a company starts at; the first accepted operation writes version 1. */
export const SYNC_INITIAL_VERSION = 0;

/**
 * Entities that travel through the change feed. One kind per authoritative table so a change is
 * always a whole entity or a tombstone — never a field-level patch a client would have to replay.
 */
export const SYNC_ENTITY_KINDS = [
  "company",
  "companySettings",
  "membership",
  "team",
  "teamMembership",
  "role",
  "roleAssignment",
  "cloudProject",
  "environmentRegistration",
  "environmentBinding",
  "environmentCommand",
  "agentThread",
  "capturedEmail",
  "emailTag",
  "trustedEmailSender",
  "issue",
  "issueStatus",
  "issueLabel",
  "issueMilestone",
  "issueCycle",
  "issueTodo",
  "issueRelation",
  "issueComment",
  "issueAttachment",
  "issueView",
  "issueAuditEvent",
  "issueThreadLink",
  "calendarAccount",
  "calendar",
  "calendarEvent",
  "calendarEventLink",
] as const;
export type SyncEntityKind = (typeof SYNC_ENTITY_KINDS)[number];

export const SYNC_CHANGE_KINDS = ["upsert", "tombstone"] as const;
export type SyncChangeKind = (typeof SYNC_CHANGE_KINDS)[number];

/** Sources a `system` actor can name. `cycles` is the one write nobody asked for. */
export const SYNC_SYSTEM_ACTOR_SOURCES = ["import", "cycles", "slack", "automation"] as const;
export type SyncSystemActorSource = (typeof SYNC_SYSTEM_ACTOR_SOURCES)[number];

/**
 * Who performed a cloud write. Mirrors `SyncActor` in the contracts, and deliberately excludes the
 * environment-local anonymous `{kind: "user"}` actor: a cloud operation always arrives with an
 * authenticated identity, and a membership tombstone keeps the attribution readable afterwards.
 */
export type SyncActor =
  | { readonly kind: "member"; readonly membershipId: string }
  | {
      readonly kind: "agent";
      readonly provider: string;
      readonly onBehalfOfMembershipId: string | null;
    }
  | { readonly kind: "system"; readonly source: SyncSystemActorSource }
  | { readonly kind: "environment"; readonly environmentId: string };

/**
 * Operation kinds mirror the existing issue commands one-for-one. Company administration is not
 * here on purpose: it is online-only and goes through its own mutations.
 */
export const SYNC_OPERATION_KINDS = [
  "issue.create",
  "issue.update",
  "issue.delete",
  "issue.triageReject",
  "issue.restore",
  "issue.setSortOrder",
  "issue.setWorkflowOwner",
  "issue.setTeams",
  "issueStatus.create",
  "issueStatus.update",
  "issueStatus.delete",
  "issueStatus.reorder",
  "issueLabel.create",
  "issueLabel.update",
  "issueLabel.delete",
  "issueMilestone.create",
  "issueMilestone.update",
  "issueMilestone.delete",
  "issueCycle.create",
  "issueCycle.update",
  "issueCycle.delete",
  "issueTodo.create",
  "issueTodo.update",
  "issueTodo.delete",
  "issueRelation.create",
  "issueRelation.delete",
  "issueComment.create",
  "issueComment.update",
  "issueComment.delete",
  "issueView.create",
  "issueView.update",
  "issueView.delete",
  "issueThreadLink.create",
  "issueThreadLink.delete",
] as const;
export type SyncOperationKind = (typeof SYNC_OPERATION_KINDS)[number];

const OPERATION_KIND_SET: ReadonlySet<string> = new Set(SYNC_OPERATION_KINDS);
export function isSyncOperationKind(value: string): value is SyncOperationKind {
  return OPERATION_KIND_SET.has(value);
}

/**
 * Why an operation was refused. A client shows these in the rejected-changes panel, so each one
 * has to be actionable on its own.
 */
export const SYNC_REJECTION_CODES = [
  "batch-empty",
  "batch-too-large",
  "batch-args-too-large",
  "batch-duplicate-operation-id",
  "upgrade-required",
  "company-mismatch",
  "not-authenticated",
  "not-a-member",
  "permission-denied",
  "company-unavailable",
  "unknown-operation",
  "entity-not-found",
  "entity-deleted",
  "invalid-arguments",
  "dependency-blocked",
] as const;
export type SyncRejectionCode = (typeof SYNC_REJECTION_CODES)[number];

const REJECTION_CODE_SET: ReadonlySet<string> = new Set(SYNC_REJECTION_CODES);
export function isSyncRejectionCode(value: string): value is SyncRejectionCode {
  return REJECTION_CODE_SET.has(value);
}

/**
 * The two outcomes an operation can have. Whether the answer replayed a stored receipt travels
 * beside the status as `duplicate`, so a resend of a rejected operation can never read as a
 * success.
 */
export const SYNC_OPERATION_RESULT_STATUSES = ["accepted", "rejected"] as const;
export type SyncOperationResultStatus = (typeof SYNC_OPERATION_RESULT_STATUSES)[number];
