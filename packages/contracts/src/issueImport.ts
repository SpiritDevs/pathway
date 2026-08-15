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
