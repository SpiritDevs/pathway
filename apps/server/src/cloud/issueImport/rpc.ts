import {
  ISSUE_IMPORT_ENTITY_KINDS,
  isPristineIssueImportTarget,
  IssueImportRpcError,
  type IssueImportExecuteResult,
  type IssueImportPreviewData,
  type IssueImportPreviewResult,
  type IssueImportRequest,
} from "@spiritdevs/contracts";
import { IssueKeyPrefix } from "@spiritdevs/contracts";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { makeSqliteSyncStore, SYNC_BOOTSTRAP_GENERATION } from "@spiritdevs/client-runtime/sync";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import { makeSyncSqliteExecutor } from "../syncSqliteExecutor.ts";
import { readCloudSyncLink, resolveCloudSyncConfig } from "../syncDaemon.ts";
import {
  IssueImportAttachmentError,
  IssueImportBackendError,
  IssueImportBatchError,
  IssueImportPlanningError,
  IssueImportPreflightError,
  IssueImportRunConflictError,
  IssueImportStartRequiredError,
  issueImportRunId,
  runConfiguredIssueImport,
  type IssueImportExecutionResult,
} from "./executor.ts";
import { planIssueImport, type IssueImportPlan } from "./plan.ts";
import type { IssueTrackerRepositoryError } from "../../persistence/Errors.ts";
import type { LocalIssueSnapshot } from "./snapshot.ts";

const isIssueImportRpcError = Schema.is(IssueImportRpcError);
const isIssueImportPreflightError = Schema.is(IssueImportPreflightError);
const isIssueImportStartRequiredError = Schema.is(IssueImportStartRequiredError);
const isIssueImportRunConflictError = Schema.is(IssueImportRunConflictError);
const isIssueImportPlanningError = Schema.is(IssueImportPlanningError);
const isIssueImportBatchError = Schema.is(IssueImportBatchError);
const isIssueImportBackendError = Schema.is(IssueImportBackendError);
const isIssueImportAttachmentError = Schema.is(IssueImportAttachmentError);

function normalizedPrefix(raw: string): IssueKeyPrefix | null {
  const value = raw.trim().toUpperCase();
  return /^[A-Z][A-Z0-9]{0,9}$/.test(value) ? IssueKeyPrefix.make(value) : null;
}

function previewData(plan: IssueImportPlan): IssueImportPreviewData {
  return {
    counts: plan.preview.counts,
    issueKeyPrefix: {
      source: plan.trackerConfig.sourcePrefix,
      selected: plan.trackerConfig.selectedPrefix,
    },
    issueKeyRange: plan.preview.issueKeyRange,
    nextIssueNumber: plan.preview.nextIssueNumber,
    attachments: plan.preview.attachments,
    rejected: plan.preview.rejected,
  };
}

function invalidPrefixError(): IssueImportRpcError {
  return new IssueImportRpcError({
    kind: "planning",
    code: "invalid-issue-key-prefix",
    message:
      "Choose an issue key prefix that starts with a letter and uses at most 10 letters or digits.",
    entityKind: "trackerConfig",
    entityId: null,
    attachmentIds: [],
  });
}

export function mapIssueImportRpcError(error: unknown): IssueImportRpcError {
  if (isIssueImportRpcError(error)) return error;
  if (isIssueImportPreflightError(error)) {
    return new IssueImportRpcError({
      kind: "preflight",
      code: error.reason,
      message: error.message,
      entityKind: null,
      entityId: null,
      attachmentIds: [],
    });
  }
  if (isIssueImportStartRequiredError(error)) {
    return new IssueImportRpcError({
      kind: "start-required",
      code: null,
      message: error.message,
      entityKind: null,
      entityId: null,
      attachmentIds: [],
    });
  }
  if (isIssueImportRunConflictError(error)) {
    return new IssueImportRpcError({
      kind: "run-conflict",
      code: null,
      message: error.message,
      entityKind: null,
      entityId: null,
      attachmentIds: [],
    });
  }
  if (isIssueImportPlanningError(error)) {
    return new IssueImportRpcError({
      kind: "planning",
      code: null,
      message: error.message,
      entityKind: null,
      entityId: error.entityIds[0] ?? null,
      attachmentIds: [],
    });
  }
  if (isIssueImportBatchError(error)) {
    return new IssueImportRpcError({
      kind: "batch",
      code: null,
      message: error.message,
      entityKind: error.entityKind,
      entityId: error.entityId,
      attachmentIds: [],
    });
  }
  if (isIssueImportBackendError(error)) {
    return new IssueImportRpcError({
      kind: "backend",
      code: error.operation,
      message: error.message,
      entityKind: null,
      entityId: null,
      attachmentIds: [],
    });
  }
  if (isIssueImportAttachmentError(error)) {
    return new IssueImportRpcError({
      kind: "attachment",
      code: error.reason,
      message: error.message,
      entityKind: "issueAttachment",
      entityId: error.attachmentIds[0] ?? null,
      attachmentIds: error.attachmentIds,
    });
  }
  return new IssueImportRpcError({
    kind: "unexpected",
    code: null,
    message: "The issue import failed unexpectedly. No credential or backend detail was returned.",
    entityKind: null,
    entityId: null,
    attachmentIds: [],
  });
}

function executionResult(result: IssueImportExecutionResult): IssueImportExecuteResult {
  return {
    runId: result.runId,
    resumed: result.resumed,
    preview: previewData(result.plan),
    counts: result.counts,
    rejects: result.rejects,
    attachmentUploads: result.attachmentUploads,
    finalRun: result.finalRun,
  };
}

export const previewConfiguredIssueImport = Effect.fn("cloud.issue_import.preview_configured")(
  function* (
    input: IssueImportRequest,
    snapshotEffect: Effect.Effect<LocalIssueSnapshot, IssueTrackerRepositoryError>,
  ) {
    const selectedIssueKeyPrefix = normalizedPrefix(input.selectedIssueKeyPrefix);
    if (selectedIssueKeyPrefix === null) return yield* invalidPrefixError();

    const companyId = CompanyId.make(input.companyId);
    const importingMembershipId = MembershipId.make(input.importingMembershipId);
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const config = yield* resolveCloudSyncConfig;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environmentLinked = (yield* readCloudSyncLink(secrets)) !== null;
    const cloudSyncConfigured = config._tag === "Configured";
    const companyMatches = cloudSyncConfigured && config.settings.companyId === companyId;

    let bootstrapReady = false;
    let targetCompanyEmpty: boolean | null = null;
    if (companyMatches) {
      const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
      const replica = yield* store.service.read(companyId);
      bootstrapReady =
        replica.checkpoint !== null &&
        replica.checkpoint.bootstrapped &&
        replica.checkpoint.bootstrapGeneration === SYNC_BOOTSTRAP_GENERATION &&
        replica.checkpoint.companyId === companyId;
      if (bootstrapReady) {
        targetCompanyEmpty = isPristineIssueImportTarget(replica.entities);
      }
    }

    const runId = issueImportRunId({ companyId, environmentId, selectedIssueKeyPrefix });
    const snapshot = yield* snapshotEffect.pipe(
      Effect.mapError(
        () =>
          new IssueImportPlanningError({
            message: "The local issue snapshot could not be read.",
            entityIds: [],
          }),
      ),
    );
    const plan = planIssueImport(snapshot, {
      companyId,
      importingMembershipId,
      sourceEnvironmentId: environmentId,
      importRunId: runId,
      selectedIssueKeyPrefix,
    });
    const reasons: IssueImportPreviewResult["preflight"]["reasons"][number][] = [];
    if (!cloudSyncConfigured)
      reasons.push({
        code: "cloud-sync-not-configured",
        message: "Cloud sync is not fully configured on this server.",
      });
    else if (!companyMatches)
      reasons.push({
        code: "company-mismatch",
        message: "The selected company is not this server's configured cloud company.",
      });
    if (!environmentLinked)
      reasons.push({
        code: "environment-not-linked",
        message: "Link this environment to the company before importing.",
      });
    if (!bootstrapReady)
      reasons.push({
        code: "bootstrap-identity-missing",
        message: "Wait for this company's cloud bootstrap to finish before importing.",
      });
    if (targetCompanyEmpty === false)
      reasons.push({
        code: "target-company-not-empty",
        message: "Empty-company import requires a target with no issue data or workflow edits.",
      });

    return {
      runId,
      sourceEnvironmentId: environmentId,
      selectedIssueKeyPrefix,
      preview: previewData(plan),
      fidelityGaps: plan.fidelityGaps,
      preflight: {
        passed:
          cloudSyncConfigured &&
          companyMatches &&
          environmentLinked &&
          bootstrapReady &&
          targetCompanyEmpty === true,
        cloudSyncConfigured,
        companyMatches,
        environmentLinked,
        bootstrapReady,
        targetCompanyEmpty,
        reasons,
      },
    } satisfies IssueImportPreviewResult;
  },
);

export interface IssueImportRpcBoundary {
  readonly preview: (
    input: IssueImportRequest,
  ) => Effect.Effect<IssueImportPreviewResult, IssueImportRpcError>;
  readonly execute: (
    input: IssueImportRequest,
  ) => Effect.Effect<IssueImportExecutionResult, IssueImportRpcError>;
}

export function makeIssueImportRpcHandlers(options: {
  readonly readSnapshot: Effect.Effect<LocalIssueSnapshot, IssueTrackerRepositoryError>;
  readonly preview?: IssueImportRpcBoundary["preview"];
  readonly execute?: IssueImportRpcBoundary["execute"];
}) {
  const readSnapshot = options.readSnapshot;
  const preview =
    options.preview ??
    ((input: IssueImportRequest) =>
      previewConfiguredIssueImport(input, readSnapshot).pipe(
        Effect.mapError(mapIssueImportRpcError),
      ));
  const execute =
    options.execute ??
    ((input: IssueImportRequest) => {
      const prefix = normalizedPrefix(input.selectedIssueKeyPrefix);
      if (prefix === null) return Effect.fail(invalidPrefixError());
      return runConfiguredIssueImport({
        companyId: CompanyId.make(input.companyId),
        importingMembershipId: MembershipId.make(input.importingMembershipId),
        selectedIssueKeyPrefix: prefix,
        readSnapshot,
      }).pipe(Effect.mapError(mapIssueImportRpcError));
    });
  return {
    preview,
    execute: (input: IssueImportRequest) =>
      Stream.fromEffect(execute(input).pipe(Effect.map(executionResult))),
  };
}
