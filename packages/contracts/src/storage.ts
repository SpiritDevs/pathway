import * as Schema from "effect/Schema";
import { NonNegativeInt } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";

export const StoragePressure = Schema.Literals(["healthy", "warning", "critical", "unknown"]);
export type StoragePressure = typeof StoragePressure.Type;
export const StoragePolicy = Schema.Struct({
  enabled: Schema.Boolean,
  autoSettleAfterDays: Schema.optional(Schema.NullOr(NonNegativeInt)),
  afterDays: Schema.Literals([7, 14, 30, 60]),
  warningBytes: NonNegativeInt,
  criticalBytes: NonNegativeInt,
  warningPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  criticalPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
});
export type StoragePolicy = typeof StoragePolicy.Type;
export const DEFAULT_STORAGE_POLICY: StoragePolicy = {
  enabled: false,
  autoSettleAfterDays: 3,
  afterDays: 30,
  warningBytes: 20_000_000_000,
  criticalBytes: 10_000_000_000,
  warningPercent: 10,
  criticalPercent: 5,
};
export const StorageVolume = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  totalBytes: NonNegativeInt,
  availableBytes: NonNegativeInt,
  sampledAt: Schema.String,
  pressure: StoragePressure,
});
export const StorageThread = Schema.Struct({
  hasMessages: Schema.optional(Schema.Boolean),
  threadId: ThreadId,
  title: Schema.String,
  conversationCompanyId: Schema.optional(Schema.NullOr(Schema.String)),
  projectId: Schema.NullOr(Schema.String),
  worktreeId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["active", "archived", "settled", "snoozed"]),
  keepWorktree: Schema.Boolean,
  temporary: Schema.optional(Schema.Boolean),
  threadDataBytes: Schema.NullOr(NonNegativeInt),
  threadDataMeasuredAt: Schema.optional(Schema.NullOr(Schema.String)),
  eligibleSince: Schema.NullOr(Schema.String),
  reclaimedAt: Schema.NullOr(Schema.String),
});
export const StorageWorktree = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  projectRoot: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  volumeId: Schema.NullOr(Schema.String),
  threadIds: Schema.Array(ThreadId),
  estimatedBytes: Schema.NullOr(NonNegativeInt),
  measuredAt: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["worktree", "conversation", "orphan"]),
  blockers: Schema.Array(Schema.String),
  removed: Schema.Boolean,
});
export const StorageCleanupInput = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
  worktreeIds: Schema.Array(Schema.String),
  mode: Schema.Literals(["manual", "emergency", "scheduled"]),
});
export type StorageCleanupInput = typeof StorageCleanupInput.Type;
export const StoragePreviewItem = Schema.Struct({
  gitStatus: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  worktreeId: Schema.String,
  path: Schema.String,
  threadIds: Schema.Array(ThreadId),
  estimatedBytes: Schema.NullOr(NonNegativeInt),
  eligible: Schema.Boolean,
  blockers: Schema.Array(Schema.String),
});
export const StoragePreview = Schema.Struct({
  items: Schema.Array(StoragePreviewItem),
  estimatedBytes: NonNegativeInt,
});
export type StoragePreview = typeof StoragePreview.Type;
export const StorageJobItem = Schema.Struct({
  projectRoot: Schema.optional(Schema.NullOr(Schema.String)),
  worktreeId: Schema.String,
  status: Schema.Literals(["pending", "removed", "skipped", "failed"]),
  message: Schema.NullOr(Schema.String),
  estimatedBytes: NonNegativeInt,
  actualFreeDeltaBytes: Schema.NullOr(Schema.Number),
});
export const StorageJob = Schema.Struct({
  force: Schema.optional(Schema.Boolean),
  id: Schema.String,
  mode: StorageCleanupInput.fields.mode,
  status: Schema.Literals(["running", "completed", "cancelled", "failed"]),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  items: Schema.Array(StorageJobItem),
});
export type StorageJob = typeof StorageJob.Type;
export const StorageSnapshot = Schema.Struct({
  sampledAt: Schema.String,
  volumes: Schema.Array(StorageVolume),
  worktrees: Schema.Array(StorageWorktree),
  threads: Schema.Array(StorageThread),
  policy: StoragePolicy,
  jobs: Schema.Array(StorageJob),
  scanError: Schema.NullOr(Schema.String),
});
export type StorageSnapshot = typeof StorageSnapshot.Type;
export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  message: Schema.String,
}) {}
