// @effect-diagnostics nodeBuiltinImport:off -- attachment import streams files and hashes bytes with Node primitives.
// @effect-diagnostics anyUnknownInErrorContext:off -- provider boundaries are sanitized into tagged executor errors.
// @effect-diagnostics unknownInEffectCatch:off -- provider failures are deliberately erased at the boundary.
/**
 * Resumable server-side executor for the dedicated Convex issue-import surface.
 *
 * A member starts the run, while the source environment applies it. The member boundary is an
 * injected callback because the server's durable credential is deliberately unable to impersonate
 * a member. Every environment mutation is safe to replay through M2a's provenance ledger.
 *
 * @module cloud/issueImport/executor
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeStream from "node:stream";

import { api } from "@spiritdevs/backend/convexApi";
import {
  EnvironmentId,
  IssueKeyPrefix,
  type Project,
  type ProjectSnapshot,
} from "@spiritdevs/contracts";
import {
  SYNC_BOOTSTRAP_GENERATION,
  makeSqliteSyncStore,
  type IssueSyncEntity,
} from "@spiritdevs/client-runtime/sync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { ConvexHttpClient } from "convex/browser";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { convexErrorCode, type ConvexServiceTokenProvider } from "../convexServiceToken.ts";
import { type ConvexClientLike } from "../convexSyncTransport.ts";
import {
  makeCloudSyncTokenProvider,
  readCloudSyncLink,
  resolveCloudSyncConfig,
} from "../syncDaemon.ts";
import { makeSyncSqliteExecutor } from "../syncSqliteExecutor.ts";
import {
  planIssueImport,
  type IssueImportPlan,
  type IssueImportRejectedRecord,
  type PlannedIssueAttachmentUpload,
} from "./plan.ts";
import { readLocalIssueSnapshot, type LocalIssueSnapshot } from "./snapshot.ts";

export const ISSUE_IMPORT_MAX_ENTITIES_PER_BATCH = 25;
export const ISSUE_IMPORT_MAX_BATCH_BYTES = 512 * 1024;

type ImportEntity = FunctionArgs<typeof api.issueImport.applyEntities>["entities"][number];
type ProjectEntity = FunctionArgs<typeof api.issueImport.applyProjects>["projects"][number];
type ImportRun = NonNullable<FunctionReturnType<typeof api.issueImport.get>>;
type ApplyBatchResult = FunctionReturnType<typeof api.issueImport.applyEntities>;
type EntityOutcome = ApplyBatchResult["outcomes"][number];
type ImportProgress = ImportRun["progress"];
type ImportEntityKind = keyof ImportProgress;
type StartArgs = FunctionArgs<typeof api.issueImport.start>;
type StorageId = FunctionArgs<typeof api.issueImport.finalizeAttachment>["storageId"];

const IMPORT_ENTITY_KINDS = [
  "cloudProject",
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
] as const satisfies ReadonlyArray<ImportEntityKind>;

export class IssueImportPreflightError extends Schema.TaggedErrorClass<IssueImportPreflightError>()(
  "IssueImportPreflightError",
  {
    reason: Schema.Literals([
      "cloud-sync-not-configured",
      "company-mismatch",
      "environment-not-linked",
      "bootstrap-identity-missing",
    ]),
    message: Schema.String,
  },
) {}

export class IssueImportStartRequiredError extends Schema.TaggedErrorClass<IssueImportStartRequiredError>()(
  "IssueImportStartRequiredError",
  { message: Schema.String },
) {}

export class IssueImportRunConflictError extends Schema.TaggedErrorClass<IssueImportRunConflictError>()(
  "IssueImportRunConflictError",
  { message: Schema.String },
) {}

export class IssueImportPlanningError extends Schema.TaggedErrorClass<IssueImportPlanningError>()(
  "IssueImportPlanningError",
  { message: Schema.String, entityIds: Schema.Array(Schema.String) },
) {}

export class IssueImportBatchError extends Schema.TaggedErrorClass<IssueImportBatchError>()(
  "IssueImportBatchError",
  { message: Schema.String, entityKind: Schema.String, entityId: Schema.String },
) {}

const isIssueImportBatchError = Schema.is(IssueImportBatchError);

export class IssueImportBackendError extends Schema.TaggedErrorClass<IssueImportBackendError>()(
  "IssueImportBackendError",
  { operation: Schema.String, message: Schema.String },
) {}

export class IssueImportAttachmentError extends Schema.TaggedErrorClass<IssueImportAttachmentError>()(
  "IssueImportAttachmentError",
  {
    reason: Schema.Literals(["missing-file", "upload-failed", "invalid-upload-response"]),
    attachmentIds: Schema.Array(Schema.String),
    message: Schema.String,
  },
) {}

export interface IssueImportBackend {
  readonly get: (args: {
    readonly companyId: string;
    readonly runId: string;
  }) => Effect.Effect<ImportRun | null, unknown>;
  readonly list: (args: {
    readonly companyId: string;
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ImportRun>, unknown>;
  readonly applyProjects: (args: {
    readonly companyId: string;
    readonly runId: string;
    readonly projects: Array<ProjectEntity>;
  }) => Effect.Effect<ApplyBatchResult, unknown>;
  readonly applyTrackerConfig: (
    args: FunctionArgs<typeof api.issueImport.applyTrackerConfig>,
  ) => Effect.Effect<FunctionReturnType<typeof api.issueImport.applyTrackerConfig>, unknown>;
  readonly applyEntities: (args: {
    readonly companyId: string;
    readonly runId: string;
    readonly entities: Array<ImportEntity>;
  }) => Effect.Effect<ApplyBatchResult, unknown>;
  readonly generateAttachmentUploadUrl: (
    args: FunctionArgs<typeof api.issueImport.generateAttachmentUploadUrl>,
  ) => Effect.Effect<string, unknown>;
  readonly finalizeAttachment: (
    args: FunctionArgs<typeof api.issueImport.finalizeAttachment>,
  ) => Effect.Effect<FunctionReturnType<typeof api.issueImport.finalizeAttachment>, unknown>;
  readonly complete: (
    args: FunctionArgs<typeof api.issueImport.complete>,
  ) => Effect.Effect<ImportRun, unknown>;
}

export interface IssueImportMemberStarter {
  readonly start: (args: StartArgs) => Effect.Effect<ImportRun, unknown>;
}

export interface AttachmentUploadResult {
  readonly attachmentId: string;
  readonly status: "finalized" | "alreadyFinalized";
  readonly byteSize: number;
  readonly checksum: string;
}

export interface IssueImportKindResult {
  applied: number;
  alreadyApplied: number;
  rejected: number;
}

export interface IssueImportReject {
  readonly entityKind: string;
  readonly entityId: string;
  readonly code: string;
  readonly message: string;
}

export interface IssueImportExecutionResult {
  readonly runId: string;
  readonly resumed: boolean;
  readonly plan: IssueImportPlan;
  readonly counts: Readonly<Record<ImportEntityKind, IssueImportKindResult>>;
  readonly rejects: ReadonlyArray<IssueImportReject>;
  readonly attachmentUploads: ReadonlyArray<AttachmentUploadResult>;
  readonly finalRun: ImportRun;
}

export interface IssueImportAttachmentTransport {
  readonly upload: (input: {
    readonly attachmentId: string;
    readonly uploadUrl: string;
    readonly filePath: string;
    readonly mimeType: string;
  }) => Effect.Effect<
    { readonly storageId: string; readonly byteSize: number; readonly checksum: string },
    IssueImportAttachmentError
  >;
}

export interface IssueImportExecutorRuntime {
  /** Required and executed first. No backend call or local snapshot read precedes it. */
  readonly preflight: Effect.Effect<void, IssueImportPreflightError>;
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly importingMembershipId: MembershipId;
  readonly selectedIssueKeyPrefix: IssueKeyPrefix;
  readonly backend: IssueImportBackend;
  readonly memberStarter?: IssueImportMemberStarter;
  /** A member-created run may be handed directly to the environment executor. */
  readonly runRecord?: ImportRun;
  readonly readSnapshot: Effect.Effect<LocalIssueSnapshot, unknown>;
  readonly readProjects: Effect.Effect<ProjectSnapshot, unknown>;
  readonly attachmentTransport?: IssueImportAttachmentTransport;
}

interface IssueImportActionClient extends ConvexClientLike {
  readonly action: <Reference extends FunctionReference<"action">>(
    reference: Reference,
    args: FunctionArgs<Reference>,
  ) => Promise<FunctionReturnType<Reference>>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthorizationFailure(error: unknown): boolean {
  const code = convexErrorCode(error);
  return (
    code === "not-authenticated" ||
    code === "environment-not-registered" ||
    code === "environment-key-mismatch" ||
    errorText(error).includes("401") ||
    errorText(error).includes("403")
  );
}

/** Authenticated environment boundary with the same serialized token refresh used by sync. */
export const makeIssueImportBackend = Effect.fn("cloud.issue_import.backend")(function* (input: {
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: IssueImportActionClient;
}) {
  const client =
    input.client ??
    (() => {
      const convex = new ConvexHttpClient(input.convexUrl);
      return {
        setAuth: (token: string) => convex.setAuth(token),
        query: (reference, args) => convex.query(reference, args),
        mutation: (reference, args) => convex.mutation(reference, args),
        action: (reference, args) => convex.action(reference, args),
      } satisfies IssueImportActionClient;
    })();
  const lock = yield* Semaphore.make(1);
  const issue = <A>(token: string, call: (convex: IssueImportActionClient) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.sync(() => client.setAuth(token)).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => call(client), catch: (error) => error })),
      ),
    );
  const authorized = <A>(
    call: (convex: IssueImportActionClient) => Promise<A>,
  ): Effect.Effect<A, unknown> =>
    input.tokens.token.pipe(
      Effect.flatMap((token) =>
        issue(token, call).pipe(
          Effect.catchIf(isAuthorizationFailure, () =>
            input.tokens.invalidate(token).pipe(
              Effect.andThen(input.tokens.token),
              Effect.flatMap((fresh) => issue(fresh, call)),
            ),
          ),
        ),
      ),
    );

  return {
    get: (args) => authorized((convex) => convex.query(api.issueImport.get, args)),
    list: (args) => authorized((convex) => convex.query(api.issueImport.list, args)),
    applyProjects: (args) =>
      authorized((convex) => convex.mutation(api.issueImport.applyProjects, args)),
    applyTrackerConfig: (args) =>
      authorized((convex) => convex.mutation(api.issueImport.applyTrackerConfig, args)),
    applyEntities: (args) =>
      authorized((convex) => convex.mutation(api.issueImport.applyEntities, args)),
    generateAttachmentUploadUrl: (args) =>
      authorized((convex) => convex.action(api.issueImport.generateAttachmentUploadUrl, args)),
    finalizeAttachment: (args) =>
      authorized((convex) => convex.mutation(api.issueImport.finalizeAttachment, args)),
    complete: (args) => authorized((convex) => convex.mutation(api.issueImport.complete, args)),
  } satisfies IssueImportBackend;
});

function uuidFromParts(parts: ReadonlyArray<string>): string {
  const bytes = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(parts))
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function issueImportRunId(input: {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly selectedIssueKeyPrefix: IssueKeyPrefix;
}): string {
  return uuidFromParts([
    "pathway-issue-import-v1",
    input.companyId,
    input.environmentId,
    input.selectedIssueKeyPrefix,
  ]);
}

function bindingId(environmentId: EnvironmentId, projectId: string): string {
  return uuidFromParts(["pathway-issue-import-binding-v1", environmentId, projectId]);
}

function epoch(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

const projectEntities = Effect.fn("cloud.issue_import.plan_projects")(function* (
  projects: ProjectSnapshot,
  environmentId: EnvironmentId,
): Effect.fn.Return<ReadonlyArray<ProjectEntity>, IssueImportPlanningError> {
  const entities: ProjectEntity[] = [];
  for (const project of projects.projects as ReadonlyArray<Project>) {
    if (project.workspaceRoot === null) {
      return yield* new IssueImportPlanningError({
        message: "Every imported project needs a workspace root for its environment binding.",
        entityIds: [project.id],
      });
    }
    const createdAt = epoch(project.createdAt);
    const updatedAt = epoch(project.updatedAt);
    if (createdAt === null || updatedAt === null) {
      return yield* new IssueImportPlanningError({
        message: "An imported project has an invalid timestamp.",
        entityIds: [project.id],
      });
    }
    entities.push({
      entityKind: "cloudProject",
      id: project.id,
      name: project.title,
      description: "",
      teamIds: [],
      defaultWorkflowOwner: { kind: "company" },
      preferredBindingId: null,
      archivedAt: null,
      createdAt,
      updatedAt,
      binding: {
        id: bindingId(environmentId, project.id),
        localProjectId: project.id,
        localWorkspaceRoot: project.workspaceRoot,
        lastSeenAt: updatedAt,
        createdAt,
        updatedAt,
      },
    } satisfies ProjectEntity);
  }
  return entities;
});

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** Batches against M2a's exact entity-count and serialized-array byte ceilings. */
export function batchIssueImportEntities<
  T extends { readonly entityKind: string; readonly id: string },
>(entities: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const entity of entities) {
    const candidate = [...current, entity];
    if (
      candidate.length > ISSUE_IMPORT_MAX_ENTITIES_PER_BATCH ||
      serializedBytes(candidate) > ISSUE_IMPORT_MAX_BATCH_BYTES
    ) {
      if (current.length > 0) batches.push(current);
      current = [entity];
      if (serializedBytes(current) > ISSUE_IMPORT_MAX_BATCH_BYTES) {
        throw new IssueImportBatchError({
          message: "One import entity exceeds the Convex serialized batch limit.",
          entityKind: entity.entityKind,
          entityId: entity.id,
        });
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function batchIssueImportEntitiesEffect<
  T extends { readonly entityKind: string; readonly id: string },
>(entities: ReadonlyArray<T>) {
  return Effect.try({
    try: () => batchIssueImportEntities(entities),
    catch: (error) =>
      isIssueImportBatchError(error)
        ? error
        : new IssueImportBatchError({
            message: "Import entities could not be divided into bounded batches.",
            entityKind: "unknown",
            entityId: "unknown",
          }),
  });
}

function sourceDeletedAt(snapshot: LocalIssueSnapshot): ReadonlyMap<string, number> {
  const deleted = new Map<string, number>();
  for (const issue of snapshot.issues) {
    if (issue.deletedAt === null) continue;
    const deletedAt = epoch(issue.deletedAt);
    if (deletedAt !== null) deleted.set(`issue\u0000${issue.id}`, deletedAt);
  }
  return deleted;
}

function importEntities(plan: IssueImportPlan, snapshot: LocalIssueSnapshot): ImportEntity[] {
  const planRejects = new Set(
    plan.preview.rejected.map((reject) => `${reject.entityKind}\u0000${reject.entityId}`),
  );
  const deleted = sourceDeletedAt(snapshot);
  return plan.entities.flatMap((entity: IssueSyncEntity) => {
    const key = `${entity.entityKind}\u0000${entity.id}`;
    if (planRejects.has(key)) return [];
    const deletedAt = deleted.get(key);
    return [(deletedAt === undefined ? entity : { ...entity, deletedAt }) as ImportEntity];
  });
}

function emptyCounts(): Record<ImportEntityKind, IssueImportKindResult> {
  return Object.fromEntries(
    IMPORT_ENTITY_KINDS.map((kind) => [kind, { applied: 0, alreadyApplied: 0, rejected: 0 }]),
  ) as Record<ImportEntityKind, IssueImportKindResult>;
}

function planReject(reject: IssueImportRejectedRecord): IssueImportReject {
  return {
    entityKind: reject.entityKind,
    entityId: reject.entityId,
    code: "plan-rejected",
    message: reject.reason,
  };
}

function backendCall<A>(operation: string, effect: Effect.Effect<A, unknown>) {
  return effect.pipe(
    Effect.mapError(
      () =>
        new IssueImportBackendError({
          operation,
          message: `The Convex issue-import ${operation} call failed.`,
        }),
    ),
  );
}

const assertRunMatches = Effect.fn("cloud.issue_import.assert_run_matches")(function* (
  runtime: IssueImportExecutorRuntime,
  run: ImportRun,
) {
  if (
    run.companyId !== runtime.companyId ||
    run.sourceEnvironmentId !== runtime.environmentId ||
    run.importingMembershipId !== runtime.importingMembershipId ||
    run.selectedIssueKeyPrefix !== runtime.selectedIssueKeyPrefix
  ) {
    return yield* new IssueImportRunConflictError({
      message:
        "The selected import run does not match this company, environment, member, and prefix.",
    });
  }
});

const locateRun = Effect.fn("cloud.issue_import.locate_run")(function* (
  runtime: IssueImportExecutorRuntime,
  deterministicId: string,
) {
  if (runtime.runRecord !== undefined) {
    yield* assertRunMatches(runtime, runtime.runRecord);
    return runtime.runRecord;
  }
  const exact = yield* backendCall(
    "get",
    runtime.backend.get({ companyId: runtime.companyId, runId: deterministicId }),
  );
  if (exact !== null) {
    yield* assertRunMatches(runtime, exact);
    return exact;
  }
  const runs = yield* backendCall(
    "list",
    runtime.backend.list({ companyId: runtime.companyId, limit: 100 }),
  );
  const live = runs.find(
    (run) =>
      (run.state === "created" || run.state === "applying") &&
      run.sourceEnvironmentId === runtime.environmentId,
  );
  if (live !== undefined) yield* assertRunMatches(runtime, live);
  return live ?? null;
});

const validateAttachmentFiles = Effect.fn("cloud.issue_import.validate_attachment_files")(
  function* (snapshot: LocalIssueSnapshot, uploads: ReadonlyArray<PlannedIssueAttachmentUpload>) {
    const missing = new Set(
      snapshot.attachments
        .filter((attachment) => attachment.filePath === null || attachment.byteSize === null)
        .map((attachment) => attachment.id),
    );
    yield* Effect.forEach(
      uploads,
      (upload) =>
        Effect.tryPromise({
          try: () => NodeFSP.stat(upload.filePath),
          catch: () =>
            new IssueImportAttachmentError({
              reason: "missing-file",
              attachmentIds: [upload.sourceEntity.id],
              message: `Attachment ${upload.sourceEntity.id} is missing.`,
            }),
        }).pipe(
          Effect.orElseSucceed(() => null),
          Effect.tap((info) =>
            Effect.sync(() => {
              if (info === null || !info.isFile()) missing.add(upload.sourceEntity.id);
            }),
          ),
        ),
      { concurrency: 8, discard: true },
    );
    if (missing.size > 0) {
      return yield* new IssueImportAttachmentError({
        reason: "missing-file",
        attachmentIds: [...missing],
        message:
          "One or more attachment files are missing. The import was not started because M2a cannot finalize an attachment as absent.",
      });
    }
  },
);

/** Streams a file through SHA-256 into the one-use Convex upload URL. */
export function makeIssueImportAttachmentTransport(
  fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
): IssueImportAttachmentTransport {
  return {
    upload: (input) =>
      Effect.tryPromise({
        try: async () => {
          const hash = NodeCrypto.createHash("sha256");
          let byteSize = 0;
          const source = NodeFS.createReadStream(input.filePath);
          const hashing = new NodeStream.Transform({
            transform(chunk: Buffer, _encoding, callback) {
              hash.update(chunk);
              byteSize += chunk.byteLength;
              callback(null, chunk);
            },
          });
          source.pipe(hashing);
          const response = await fetchImplementation(input.uploadUrl, {
            method: "POST",
            headers: { "Content-Type": input.mimeType },
            body: hashing,
            duplex: "half",
          } as RequestInit & { readonly duplex: "half" });
          if (!response.ok) throw new Error("upload-refused");
          const body: unknown = await response.json();
          if (
            typeof body !== "object" ||
            body === null ||
            typeof (body as { storageId?: unknown }).storageId !== "string"
          ) {
            throw new Error("invalid-upload-response");
          }
          return {
            storageId: (body as { storageId: string }).storageId,
            byteSize,
            checksum: `sha256:${hash.digest("hex")}`,
          };
        },
        catch: (cause) =>
          new IssueImportAttachmentError({
            reason:
              cause instanceof Error && cause.message === "invalid-upload-response"
                ? "invalid-upload-response"
                : "upload-failed",
            attachmentIds: [input.attachmentId],
            message: `Attachment ${input.attachmentId} could not be uploaded.`,
          }),
      }),
  };
}

function stageEntities(entities: ReadonlyArray<ImportEntity>) {
  const kinds = (...accepted: ReadonlyArray<ImportEntity["entityKind"]>) =>
    entities.filter((entity) => accepted.includes(entity.entityKind));
  return [
    kinds("issueStatus", "issueLabel", "issueCycle"),
    kinds("issueMilestone"),
    kinds("issue"),
    kinds("issueAttachment"),
    kinds("issueComment", "issueTodo", "issueRelation", "issueView", "issueThreadLink"),
    kinds("issueAuditEvent"),
  ] as const;
}

function expectedCounts(
  counts: Readonly<Record<ImportEntityKind, IssueImportKindResult>>,
): FunctionArgs<typeof api.issueImport.complete>["expectedCounts"] {
  const successful = (kind: ImportEntityKind) => counts[kind].applied + counts[kind].alreadyApplied;
  return {
    cloudProject: successful("cloudProject"),
    issue: successful("issue"),
    issueStatus: successful("issueStatus"),
    issueLabel: successful("issueLabel"),
    issueMilestone: successful("issueMilestone"),
    issueCycle: successful("issueCycle"),
    issueTodo: successful("issueTodo"),
    issueRelation: successful("issueRelation"),
    issueComment: successful("issueComment"),
    issueAttachment: successful("issueAttachment"),
    issueView: successful("issueView"),
    issueAuditEvent: successful("issueAuditEvent"),
    issueThreadLink: successful("issueThreadLink"),
  };
}

/** Executes one complete import or resumes the environment's live run. */
export const runIssueImportExecutor = Effect.fn("cloud.issue_import.execute")(function* (
  runtime: IssueImportExecutorRuntime,
) {
  yield* runtime.preflight;

  const deterministicId = issueImportRunId(runtime);
  const located = yield* locateRun(runtime, deterministicId);
  const runId = located?.id ?? deterministicId;
  const [snapshot, projects] = yield* Effect.all(
    [runtime.readSnapshot, runtime.readProjects] as const,
    { concurrency: 2 },
  ).pipe(
    Effect.mapError(
      () =>
        new IssueImportPlanningError({
          message: "The local issue or project snapshot could not be read.",
          entityIds: [],
        }),
    ),
  );
  const plan = planIssueImport(snapshot, {
    companyId: runtime.companyId,
    importingMembershipId: runtime.importingMembershipId,
    sourceEnvironmentId: runtime.environmentId,
    importRunId: runId,
    selectedIssueKeyPrefix: runtime.selectedIssueKeyPrefix,
  });
  const projectsToApply = yield* projectEntities(projects, runtime.environmentId);
  yield* validateAttachmentFiles(snapshot, plan.attachmentUploads);

  let run = located;
  let resumed = located !== null;
  if (run === null) {
    if (runtime.memberStarter === undefined) {
      return yield* new IssueImportStartRequiredError({
        message:
          "No live import exists. A company.manage member must start it and hand the run to this environment executor.",
      });
    }
    run = yield* backendCall(
      "start",
      runtime.memberStarter.start({
        companyId: runtime.companyId,
        id: runId,
        sourceEnvironmentId: runtime.environmentId,
        selectedIssueKeyPrefix: runtime.selectedIssueKeyPrefix,
      }),
    );
    yield* assertRunMatches(runtime, run);
    resumed = false;
  }

  const counts = emptyCounts();
  const rejects: IssueImportReject[] = plan.preview.rejected.map(planReject);
  for (const reject of rejects) {
    if (reject.entityKind in counts) counts[reject.entityKind as ImportEntityKind].rejected += 1;
  }
  const attachmentUploads: AttachmentUploadResult[] = [];

  if (run.state === "completed") {
    for (const kind of IMPORT_ENTITY_KINDS) {
      counts[kind].alreadyApplied = run.progress[kind];
    }
    return { runId, resumed: true, plan, counts, rejects, attachmentUploads, finalRun: run };
  }
  if (run.state !== "created" && run.state !== "applying") {
    return yield* new IssueImportRunConflictError({
      message: `Import ${run.id} is ${run.state} and cannot be resumed.`,
    });
  }

  const successfulAttachmentIds = new Set<string>();
  const recordOutcomes = (outcomes: ReadonlyArray<EntityOutcome>) => {
    for (const outcome of outcomes) {
      const kind = outcome.entityKind as ImportEntityKind;
      if (!(kind in counts)) continue;
      if (outcome.status === "applied") counts[kind].applied += 1;
      else if (outcome.status === "alreadyApplied") counts[kind].alreadyApplied += 1;
      else {
        counts[kind].rejected += 1;
        rejects.push({
          entityKind: outcome.entityKind,
          entityId: outcome.entityId,
          code: outcome.code,
          message: outcome.message,
        });
      }
      if (
        kind === "issueAttachment" &&
        (outcome.status === "applied" || outcome.status === "alreadyApplied")
      ) {
        successfulAttachmentIds.add(outcome.entityId);
      }
    }
  };

  const applyProjects = Effect.fn("cloud.issue_import.apply_projects")(function* () {
    const batches = yield* batchIssueImportEntitiesEffect(projectsToApply);
    for (const batch of batches) {
      const result = yield* backendCall(
        "applyProjects",
        runtime.backend.applyProjects({
          companyId: runtime.companyId,
          runId,
          projects: [...batch],
        }),
      );
      recordOutcomes(result.outcomes);
    }
  });
  const applyEntities = Effect.fn("cloud.issue_import.apply_entities")(function* (
    entities: ReadonlyArray<ImportEntity>,
  ) {
    const batches = yield* batchIssueImportEntitiesEffect(entities);
    for (const batch of batches) {
      const result = yield* backendCall(
        "applyEntities",
        runtime.backend.applyEntities({
          companyId: runtime.companyId,
          runId,
          entities: [...batch],
        }),
      );
      recordOutcomes(result.outcomes);
    }
  });

  yield* applyProjects();
  yield* backendCall(
    "applyTrackerConfig",
    runtime.backend.applyTrackerConfig({
      companyId: runtime.companyId,
      runId,
      issueKeyPrefix: plan.trackerConfig.selectedPrefix,
      nextIssueNumber: plan.trackerConfig.nextIssueNumber,
    }),
  );

  const stages = stageEntities(importEntities(plan, snapshot));
  yield* applyEntities(stages[0]);
  yield* applyEntities(stages[1]);
  yield* applyEntities(stages[2]);
  yield* applyEntities(stages[3]);

  const uploader = runtime.attachmentTransport ?? makeIssueImportAttachmentTransport();
  for (const upload of plan.attachmentUploads) {
    if (!successfulAttachmentIds.has(upload.sourceEntity.id)) continue;
    const uploadUrl = yield* backendCall(
      "generateAttachmentUploadUrl",
      runtime.backend.generateAttachmentUploadUrl({
        companyId: runtime.companyId,
        runId,
        attachmentId: upload.sourceEntity.id,
      }),
    );
    const stored = yield* uploader.upload({
      attachmentId: upload.sourceEntity.id,
      uploadUrl,
      filePath: upload.filePath,
      mimeType: upload.sourceEntity.mimeType,
    });
    const finalized = yield* backendCall(
      "finalizeAttachment",
      runtime.backend.finalizeAttachment({
        companyId: runtime.companyId,
        runId,
        attachmentId: upload.sourceEntity.id,
        storageId: stored.storageId as StorageId,
        checksum: stored.checksum,
        byteSize: stored.byteSize,
      }),
    );
    attachmentUploads.push({
      attachmentId: upload.sourceEntity.id,
      status: finalized.status,
      byteSize: stored.byteSize,
      checksum: stored.checksum,
    });
  }

  yield* applyEntities(stages[4]);
  yield* applyEntities(stages[5]);
  const finalRun = yield* backendCall(
    "complete",
    runtime.backend.complete({
      companyId: runtime.companyId,
      runId,
      expectedCounts: expectedCounts(counts),
    }),
  );
  return { runId, resumed, plan, counts, rejects, attachmentUploads, finalRun };
});

/**
 * Production runner. It fails before snapshot/project reads unless config, link, environment
 * identity, and the matching generation-3 bootstrap checkpoint are all present.
 */
export const runConfiguredIssueImport = Effect.fn("cloud.issue_import.run_configured")(
  function* (input: {
    readonly companyId: CompanyId;
    readonly importingMembershipId: MembershipId;
    readonly selectedIssueKeyPrefix: IssueKeyPrefix;
    readonly memberStarter?: IssueImportMemberStarter;
    readonly runRecord?: ImportRun;
  }) {
    const config = yield* resolveCloudSyncConfig;
    if (config._tag !== "Configured") {
      return yield* new IssueImportPreflightError({
        reason: "cloud-sync-not-configured",
        message: "Cloud sync must be fully configured before an issue import can run.",
      });
    }
    if (config.settings.companyId !== input.companyId) {
      return yield* new IssueImportPreflightError({
        reason: "company-mismatch",
        message: "The requested import company is not this server's configured cloud company.",
      });
    }
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    if ((yield* readCloudSyncLink(secrets)) === null) {
      return yield* new IssueImportPreflightError({
        reason: "environment-not-linked",
        message: "This environment must be linked before an issue import can run.",
      });
    }
    const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
    const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
    const replica = yield* store.service.read(input.companyId);
    if (
      replica.checkpoint === null ||
      !replica.checkpoint.bootstrapped ||
      replica.checkpoint.bootstrapGeneration !== SYNC_BOOTSTRAP_GENERATION ||
      replica.checkpoint.companyId !== input.companyId
    ) {
      return yield* new IssueImportPreflightError({
        reason: "bootstrap-identity-missing",
        message: "The configured company's cloud bootstrap identity is not ready for import.",
      });
    }
    const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets });
    const backend = yield* makeIssueImportBackend({
      convexUrl: config.settings.convexUrl,
      tokens,
    });
    const projects = yield* ProjectService.ProjectService;
    const [snapshot, projectSnapshot] = yield* Effect.all(
      [readLocalIssueSnapshot(), projects.snapshot] as const,
      { concurrency: 2 },
    );
    return yield* runIssueImportExecutor({
      preflight: Effect.void,
      companyId: input.companyId,
      environmentId,
      importingMembershipId: input.importingMembershipId,
      selectedIssueKeyPrefix: input.selectedIssueKeyPrefix,
      backend,
      ...(input.memberStarter === undefined ? {} : { memberStarter: input.memberStarter }),
      ...(input.runRecord === undefined ? {} : { runRecord: input.runRecord }),
      readSnapshot: Effect.succeed(snapshot),
      readProjects: Effect.succeed(projectSnapshot),
    });
  },
);
