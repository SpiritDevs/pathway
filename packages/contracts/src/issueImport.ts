import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const ISSUE_IMPORT_ENTITY_KINDS = [
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
] as const;

export const ISSUE_IMPORT_RESULT_KINDS = ["cloudProject", ...ISSUE_IMPORT_ENTITY_KINDS] as const;

/**
 * The workflow provisioned for a new cloud company. An empty-company import may replace exactly
 * this seed: it is scaffolding, not user data. Keep the semantic fields here aligned with company
 * provisioning; timestamps, company ids, and feed versions deliberately do not participate.
 */
export const DEFAULT_ISSUE_STATUSES = [
  { id: "backlog", name: "Backlog", color: "#95a2b3", category: "backlog", position: 1 },
  { id: "todo", name: "Todo", color: "#e2e2e2", category: "unstarted", position: 2 },
  { id: "in-progress", name: "In Progress", color: "#f2c94c", category: "started", position: 3 },
  { id: "in-review", name: "In Review", color: "#26b5ce", category: "started", position: 4 },
  { id: "done", name: "Done", color: "#5e6ad2", category: "completed", position: 5 },
  { id: "canceled", name: "Canceled", color: "#95a2b3", category: "canceled", position: 6 },
] as const;

function isDefaultIssueStatus(value: unknown): boolean {
  if (!Predicate.isObject(value)) return false;
  const expected = DEFAULT_ISSUE_STATUSES.find((status) => status.id === value["id"]);
  return (
    expected !== undefined &&
    value["scope"] === "company" &&
    value["teamId"] === null &&
    value["baseStatusId"] === null &&
    value["name"] === expected.name &&
    value["color"] === expected.color &&
    value["category"] === expected.category &&
    value["position"] === expected.position &&
    value["hidden"] === false &&
    (value["deletedAt"] === undefined || value["deletedAt"] === null)
  );
}

/** Whether rows are exactly the untouched workflow seed, in any order. */
export function isDefaultIssueStatusSet(values: readonly unknown[]): boolean {
  return (
    values.length === DEFAULT_ISSUE_STATUSES.length &&
    new Set(
      values.flatMap((value) =>
        Predicate.isObject(value) && typeof value["id"] === "string" ? [value["id"]] : [],
      ),
    ).size === DEFAULT_ISSUE_STATUSES.length &&
    values.every(isDefaultIssueStatus)
  );
}

/**
 * Empty-company import eligibility for a confirmed replica. A truly empty issue domain and the
 * untouched provisioned workflow are equivalent; any other issue-domain row is user data.
 */
export function isPristineIssueImportTarget(
  entities: readonly { readonly entityKind: string; readonly payload: unknown }[],
): boolean {
  const issueEntities = entities.filter((entity) =>
    (ISSUE_IMPORT_ENTITY_KINDS as readonly string[]).includes(entity.entityKind),
  );
  return (
    issueEntities.length === 0 ||
    (issueEntities.every((entity) => entity.entityKind === "issueStatus") &&
      isDefaultIssueStatusSet(issueEntities.map((entity) => entity.payload)))
  );
}

export const IssueImportEntityKind = Schema.Literals(ISSUE_IMPORT_ENTITY_KINDS);
export type IssueImportEntityKind = typeof IssueImportEntityKind.Type;

export const IssueImportResultKind = Schema.Literals(ISSUE_IMPORT_RESULT_KINDS);
export type IssueImportResultKind = typeof IssueImportResultKind.Type;

const issueImportCountsFields = Object.fromEntries(
  ISSUE_IMPORT_ENTITY_KINDS.map((kind) => [kind, Schema.Number]),
) as { readonly [K in IssueImportEntityKind]: typeof Schema.Number };

const IssueImportKindResult = Schema.Struct({
  applied: Schema.Number,
  alreadyApplied: Schema.Number,
  rejected: Schema.Number,
});

const issueImportResultFields = Object.fromEntries(
  ISSUE_IMPORT_RESULT_KINDS.map((kind) => [kind, IssueImportKindResult]),
) as { readonly [K in IssueImportResultKind]: typeof IssueImportKindResult };

export const IssueImportRunProgress = Schema.Struct({
  cloudProject: Schema.Number,
  ...issueImportCountsFields,
});
export type IssueImportRunProgress = typeof IssueImportRunProgress.Type;

export const IssueImportRun = Schema.Struct({
  id: Schema.String,
  companyId: Schema.String,
  sourceEnvironmentId: Schema.String,
  createdByMembershipId: Schema.String,
  importingMembershipId: Schema.String,
  selectedIssueKeyPrefix: Schema.String,
  mode: Schema.Literal("empty-company"),
  state: Schema.Literals(["created", "applying", "completed", "abandoned", "failed"]),
  progress: IssueImportRunProgress,
  trackerApplied: Schema.Boolean,
  trackerNextIssueNumber: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  completedAt: Schema.NullOr(Schema.Number),
  abandonedAt: Schema.NullOr(Schema.Number),
});
export type IssueImportRun = typeof IssueImportRun.Type;

export const IssueImportRequest = Schema.Struct({
  companyId: Schema.String,
  importingMembershipId: Schema.String,
  selectedIssueKeyPrefix: Schema.String,
});
export type IssueImportRequest = typeof IssueImportRequest.Type;

export const IssueImportRejectedRecord = Schema.Struct({
  entityKind: Schema.Union([IssueImportEntityKind, Schema.Literal("trackerConfig")]),
  entityId: Schema.String,
  reason: Schema.String,
});

export const IssueImportFidelityGap = Schema.Struct({
  entityKind: Schema.Union([IssueImportEntityKind, Schema.Literal("trackerConfig")]),
  verdict: Schema.Literals(["preserved", "partial", "not-supported"]),
  preserved: Schema.Array(Schema.String),
  gaps: Schema.Array(
    Schema.Struct({
      fields: Schema.Array(Schema.String),
      normalPushBehavior: Schema.String,
    }),
  ),
});

export const IssueImportPreviewData = Schema.Struct({
  counts: Schema.Struct(issueImportCountsFields),
  issueKeyPrefix: Schema.Struct({
    source: Schema.String,
    selected: Schema.String,
  }),
  issueKeyRange: Schema.Struct({
    first: Schema.NullOr(Schema.String),
    last: Schema.NullOr(Schema.String),
    lowestNumber: Schema.NullOr(Schema.Number),
    highestNumber: Schema.NullOr(Schema.Number),
  }),
  nextIssueNumber: Schema.Number,
  attachments: Schema.Struct({ count: Schema.Number, totalBytes: Schema.Number }),
  rejected: Schema.Array(IssueImportRejectedRecord),
});
export type IssueImportPreviewData = typeof IssueImportPreviewData.Type;

export const IssueImportPreflightReason = Schema.Struct({
  code: Schema.Literals([
    "cloud-sync-not-configured",
    "company-mismatch",
    "environment-not-linked",
    "bootstrap-identity-missing",
    "target-company-not-empty",
  ]),
  message: Schema.String,
});

export const IssueImportPreflightStatus = Schema.Struct({
  passed: Schema.Boolean,
  cloudSyncConfigured: Schema.Boolean,
  companyMatches: Schema.Boolean,
  environmentLinked: Schema.Boolean,
  bootstrapReady: Schema.Boolean,
  targetCompanyEmpty: Schema.NullOr(Schema.Boolean),
  reasons: Schema.Array(IssueImportPreflightReason),
});
export type IssueImportPreflightStatus = typeof IssueImportPreflightStatus.Type;

export const IssueImportPreviewResult = Schema.Struct({
  runId: Schema.String,
  sourceEnvironmentId: Schema.String,
  selectedIssueKeyPrefix: Schema.String,
  preview: IssueImportPreviewData,
  fidelityGaps: Schema.Array(IssueImportFidelityGap),
  preflight: IssueImportPreflightStatus,
});
export type IssueImportPreviewResult = typeof IssueImportPreviewResult.Type;

export const IssueImportReject = Schema.Struct({
  entityKind: Schema.String,
  entityId: Schema.String,
  code: Schema.String,
  message: Schema.String,
});

export const IssueImportAttachmentUpload = Schema.Struct({
  attachmentId: Schema.String,
  status: Schema.Literals(["finalized", "alreadyFinalized"]),
  byteSize: Schema.Number,
  checksum: Schema.String,
});

export const IssueImportExecuteResult = Schema.Struct({
  runId: Schema.String,
  resumed: Schema.Boolean,
  preview: IssueImportPreviewData,
  counts: Schema.Struct(issueImportResultFields),
  rejects: Schema.Array(IssueImportReject),
  attachmentUploads: Schema.Array(IssueImportAttachmentUpload),
  finalRun: IssueImportRun,
});
export type IssueImportExecuteResult = typeof IssueImportExecuteResult.Type;

export class IssueImportRpcError extends Schema.TaggedErrorClass<IssueImportRpcError>()(
  "IssueImportRpcError",
  {
    kind: Schema.Literals([
      "preflight",
      "start-required",
      "run-conflict",
      "planning",
      "batch",
      "backend",
      "attachment",
      "unexpected",
    ]),
    code: Schema.NullOr(Schema.String),
    message: Schema.String,
    entityKind: Schema.NullOr(Schema.String),
    entityId: Schema.NullOr(Schema.String),
    attachmentIds: Schema.Array(Schema.String),
  },
) {}
