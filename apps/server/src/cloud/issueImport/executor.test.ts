// @effect-diagnostics nodeBuiltinImport:off -- attachment fixtures exercise the real streaming uploader.
// @effect-diagnostics anyUnknownInErrorContext:off -- the harness intentionally mocks an unknown-error backend port.
// @effect-diagnostics globalErrorInEffectCatch:off -- temporary fixture setup errors are test-only.
// @effect-diagnostics globalErrorInEffectFailure:off -- temporary fixture setup errors are test-only.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  EnvironmentId,
  IssueCommentId,
  IssueId,
  IssueKey,
  IssueKeyPrefix,
  IssueStatusId,
  ProjectId,
  type ProjectSnapshot,
} from "@spiritdevs/contracts";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { LocalIssueSnapshot } from "./snapshot.ts";
import {
  ISSUE_IMPORT_MAX_BATCH_BYTES,
  ISSUE_IMPORT_MAX_ENTITIES_PER_BATCH,
  IssueImportPreflightError,
  batchIssueImportEntities,
  issueImportRunId,
  makeIssueImportAttachmentTransport,
  runIssueImportExecutor,
  type IssueImportBackend,
  type IssueImportExecutorRuntime,
} from "./executor.ts";

const COMPANY_ID = CompanyId.make("company-import-executor");
const ENVIRONMENT_ID = EnvironmentId.make("environment-import-executor");
const MEMBERSHIP_ID = MembershipId.make("membership-import-executor");
const PREFIX = IssueKeyPrefix.make("PAT");
const CREATED = "2026-01-02T03:04:05.000Z";
const UPDATED = "2026-02-03T04:05:06.000Z";

const emptyProgress = () => ({
  cloudProject: 0,
  issue: 0,
  issueStatus: 0,
  issueLabel: 0,
  issueMilestone: 0,
  issueCycle: 0,
  issueTodo: 0,
  issueRelation: 0,
  issueComment: 0,
  issueAttachment: 0,
  issueView: 0,
  issueAuditEvent: 0,
  issueThreadLink: 0,
});

type Progress = ReturnType<typeof emptyProgress>;

function runRecord(
  state: "created" | "applying" | "completed" = "created",
  progress: Progress = emptyProgress(),
) {
  return {
    id: issueImportRunId({
      companyId: COMPANY_ID,
      environmentId: ENVIRONMENT_ID,
      selectedIssueKeyPrefix: PREFIX,
    }),
    companyId: COMPANY_ID,
    sourceEnvironmentId: ENVIRONMENT_ID,
    createdByMembershipId: MEMBERSHIP_ID,
    importingMembershipId: MEMBERSHIP_ID,
    selectedIssueKeyPrefix: PREFIX,
    mode: "empty-company" as const,
    state,
    progress,
    trackerApplied: state !== "created",
    trackerNextIssueNumber: state === "created" ? null : 1,
    createdAt: 1,
    updatedAt: 1,
    completedAt: state === "completed" ? 2 : null,
    abandonedAt: null,
  };
}

const projects: ProjectSnapshot = { projects: [], updatedAt: UPDATED };

function snapshot(statusCount = 1): LocalIssueSnapshot {
  return {
    capturedAt: Date.parse(UPDATED),
    statuses: Array.from({ length: statusCount }, (_, index) => ({
      id: IssueStatusId.make(`status-${index}`),
      name: `Status ${index}`,
      color: "#888888",
      category: "unstarted" as const,
      position: index,
      createdAt: CREATED,
      updatedAt: UPDATED,
    })),
    labels: [],
    labelAssignments: [],
    milestones: [],
    cycles: [],
    issues: [],
    todos: [],
    relations: [],
    comments: [],
    attachments: [],
    auditEvents: [],
    threadLinks: [],
    views: [],
    trackerConfig: { keyPrefix: PREFIX, nextNumber: 1 },
  };
}

interface BackendHarnessOptions {
  readonly existing?: ReturnType<typeof runRecord> | null;
  readonly outcome?: "applied" | "alreadyApplied";
  readonly rejectEntityId?: string;
}

function backendHarness(options: BackendHarnessOptions = {}) {
  const calls = {
    order: [] as string[],
    get: 0,
    list: 0,
    applyProjects: [] as Array<ReadonlyArray<{ readonly entityKind: string; readonly id: string }>>,
    applyEntities: [] as Array<ReadonlyArray<{ readonly entityKind: string; readonly id: string }>>,
    tracker: 0,
    uploadUrls: [] as string[],
    finalizes: [] as Array<{
      readonly attachmentId: string;
      readonly storageId: string;
      readonly checksum: string;
      readonly byteSize: number;
    }>,
    complete: [] as Array<Record<string, number | undefined>>,
  };
  let progress = { ...(options.existing?.progress ?? emptyProgress()) };
  const outcomes = (
    entities: ReadonlyArray<{ readonly entityKind: string; readonly id: string }>,
  ) =>
    entities.map((entity) => {
      if (entity.id === options.rejectEntityId) {
        return {
          entityKind: entity.entityKind,
          entityId: entity.id,
          status: "rejected" as const,
          code: "fixture-rejected",
          message: "Rejected by the fixture.",
        };
      }
      const status = options.outcome ?? "applied";
      if (status === "applied") {
        const kind = entity.entityKind as keyof Progress;
        progress = { ...progress, [kind]: progress[kind] + 1 };
      }
      return { entityKind: entity.entityKind, entityId: entity.id, status };
    });
  const result = (
    entities: ReadonlyArray<{ readonly entityKind: string; readonly id: string }>,
  ) => ({
    outcomes: outcomes(entities),
    progress,
    version: 1,
  });
  const backend: IssueImportBackend = {
    get: () =>
      Effect.sync(() => {
        calls.order.push("get");
        calls.get += 1;
        return options.existing ?? null;
      }) as never,
    list: () =>
      Effect.sync(() => {
        calls.order.push("list");
        calls.list += 1;
        return [];
      }) as never,
    applyProjects: (args) =>
      Effect.sync(() => {
        calls.order.push("applyProjects");
        calls.applyProjects.push(args.projects);
        return result(args.projects);
      }) as never,
    applyTrackerConfig: () =>
      Effect.sync(() => {
        calls.order.push("applyTrackerConfig");
        calls.tracker += 1;
        return { status: "applied" as const, issueKeyPrefix: PREFIX, nextIssueNumber: 1 };
      }),
    applyEntities: (args) =>
      Effect.sync(() => {
        calls.order.push("applyEntities");
        calls.applyEntities.push(args.entities);
        return result(args.entities);
      }) as never,
    generateAttachmentUploadUrl: (args) =>
      Effect.sync(() => {
        calls.order.push("generateAttachmentUploadUrl");
        calls.uploadUrls.push(args.attachmentId);
        return "https://upload.invalid/one-use-token";
      }),
    finalizeAttachment: (args) =>
      Effect.sync(() => {
        calls.order.push("finalizeAttachment");
        calls.finalizes.push({
          attachmentId: args.attachmentId,
          storageId: args.storageId,
          checksum: args.checksum,
          byteSize: args.byteSize,
        });
        return { status: "finalized" as const };
      }),
    complete: (args) =>
      Effect.sync(() => {
        calls.order.push("complete");
        calls.complete.push(args.expectedCounts);
        return runRecord("completed", progress);
      }) as never,
  };
  return { backend, calls };
}

function runtime(
  backend: IssueImportBackend,
  source: LocalIssueSnapshot,
  overrides: Partial<IssueImportExecutorRuntime> = {},
): IssueImportExecutorRuntime {
  return {
    preflight: Effect.void,
    companyId: COMPANY_ID,
    environmentId: ENVIRONMENT_ID,
    importingMembershipId: MEMBERSHIP_ID,
    selectedIssueKeyPrefix: PREFIX,
    backend,
    memberStarter: { start: () => Effect.succeed(runRecord()) as never },
    readSnapshot: Effect.succeed(source),
    readProjects: Effect.succeed(projects),
    ...overrides,
  };
}

function attachmentSnapshot(filePath: string | null): LocalIssueSnapshot {
  const source = snapshot();
  const issueId = IssueId.make("issue-attachment");
  const commentId = IssueCommentId.make("comment-attachment");
  const attachmentId = ChatAttachmentId.make(
    "iss_issue-attachment-00000000-0000-4000-8000-000000000001",
  );
  return {
    ...source,
    issues: [
      {
        id: issueId,
        key: IssueKey.make("PAT-1"),
        title: "Issue with proof",
        description: "",
        statusId: source.statuses[0]!.id,
        priority: "none",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "a0",
        dueDate: null,
        triage: false,
        slackSource: null,
        createdAt: CREATED,
        updatedAt: UPDATED,
        deletedAt: null,
        labelIds: [],
      },
    ],
    comments: [
      {
        id: commentId,
        issueId,
        author: { kind: "user" },
        body: "proof",
        attachmentIds: [attachmentId],
        mentions: [],
        createdAt: CREATED,
        editedAt: UPDATED,
      },
    ],
    attachments: [
      {
        id: attachmentId,
        issueId,
        commentId,
        filePath,
        fileName: "proof.txt",
        mimeType: "text/plain",
        byteSize: 11,
        createdAt: CREATED,
        updatedAt: UPDATED,
      },
    ],
  };
}

describe("issue import executor", () => {
  it("splits batches at both the entity and serialized-byte limits", () => {
    const entities = Array.from({ length: 26 }, (_, index) => ({
      entityKind: "issueStatus",
      id: `status-${index}`,
      value: "small",
    }));
    const countBatches = batchIssueImportEntities(entities);
    expect(countBatches.map((batch) => batch.length)).toEqual([
      ISSUE_IMPORT_MAX_ENTITIES_PER_BATCH,
      1,
    ]);

    const byteBatches = batchIssueImportEntities([
      { entityKind: "issueStatus", id: "large-a", value: "a".repeat(300_000) },
      { entityKind: "issueStatus", id: "large-b", value: "b".repeat(300_000) },
    ]);
    expect(byteBatches).toHaveLength(2);
    for (const batch of byteBatches) {
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(
        ISSUE_IMPORT_MAX_BATCH_BYTES,
      );
    }
  });

  it.effect("sends bounded executor batches and preserves source deletedAt", () =>
    Effect.gen(function* () {
      const source = snapshot(26);
      const withDeleted: LocalIssueSnapshot = {
        ...source,
        issues: [
          ...source.issues,
          {
            id: IssueId.make("deleted-issue"),
            key: IssueKey.make("PAT-1"),
            title: "Deleted",
            description: "",
            statusId: source.statuses[0]!.id,
            priority: "none",
            assignee: null,
            projectId: null,
            milestoneId: null,
            cycleId: null,
            parentId: null,
            sortOrder: "a0",
            dueDate: null,
            triage: false,
            slackSource: null,
            createdAt: CREATED,
            updatedAt: UPDATED,
            deletedAt: UPDATED,
            labelIds: [],
          },
        ],
      };
      const harness = backendHarness();
      const result = yield* runIssueImportExecutor(runtime(harness.backend, withDeleted));

      const statusBatches = harness.calls.applyEntities.filter(
        (batch) => batch[0]?.entityKind === "issueStatus",
      );
      assert.deepEqual(
        statusBatches.map((batch) => batch.length),
        [25, 1],
      );
      const deleted = harness.calls.applyEntities
        .flat()
        .find((entity) => entity.entityKind === "issue" && entity.id === "deleted-issue");
      expect(deleted).toMatchObject({ deletedAt: Date.parse(UPDATED) });
      assert.equal(result.finalRun.state, "completed");
    }),
  );

  it.effect("derives cloud projects and pending environment bindings before tracker config", () =>
    Effect.gen(function* () {
      const harness = backendHarness();
      const projectId = ProjectId.make("project-imported");
      const projectSnapshot: ProjectSnapshot = {
        projects: [
          {
            id: projectId,
            title: "Imported project",
            workspaceRoot: "/workspace/imported",
            repositoryIdentity: null,
            faviconPath: null,
            defaultModelSelection: null,
            scripts: [],
            createdAt: CREATED,
            updatedAt: UPDATED,
            deletedAt: null,
          },
        ],
        updatedAt: UPDATED,
      };
      const result = yield* runIssueImportExecutor(
        runtime(harness.backend, snapshot(), {
          readProjects: Effect.succeed(projectSnapshot),
        }),
      );

      const imported = harness.calls.applyProjects[0]?.[0];
      expect(imported).toMatchObject({
        entityKind: "cloudProject",
        id: projectId,
        name: "Imported project",
        binding: {
          localProjectId: projectId,
          localWorkspaceRoot: "/workspace/imported",
        },
      });
      assert.isBelow(
        harness.calls.order.indexOf("applyProjects"),
        harness.calls.order.indexOf("applyTrackerConfig"),
      );
      assert.equal(result.counts.cloudProject.applied, 1);
    }),
  );

  it.effect("resumes a live run, re-sends entities, and counts alreadyApplied as success", () =>
    Effect.gen(function* () {
      const progress = emptyProgress();
      progress.issueStatus = 1;
      const existing = runRecord("applying", progress);
      const harness = backendHarness({ existing, outcome: "alreadyApplied" });
      const prepared = runtime(harness.backend, snapshot());
      const { memberStarter: _memberStarter, ...withoutStarter } = prepared;
      const result = yield* runIssueImportExecutor(withoutStarter);

      assert.isTrue(result.resumed);
      assert.equal(result.counts.issueStatus.alreadyApplied, 1);
      assert.equal(harness.calls.applyEntities.flat().length, 1);
      assert.equal(harness.calls.complete[0]?.issueStatus, 1);
    }),
  );

  it.effect("excludes rejected rows from expectedCounts and reports their backend details", () =>
    Effect.gen(function* () {
      const harness = backendHarness({ rejectEntityId: "status-1" });
      const result = yield* runIssueImportExecutor(runtime(harness.backend, snapshot(2)));

      assert.equal(result.counts.issueStatus.applied, 1);
      assert.equal(result.counts.issueStatus.rejected, 1);
      assert.equal(harness.calls.complete[0]?.issueStatus, 1);
      expect(result.rejects).toContainEqual({
        entityKind: "issueStatus",
        entityId: "status-1",
        code: "fixture-rejected",
        message: "Rejected by the fixture.",
      });
    }),
  );

  it.effect("streams attachment bytes with content type, hashes them, and finalizes", () =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-import-")),
        catch: () => new Error("fixture-create-failed"),
      }),
      (directory) =>
        Effect.gen(function* () {
          const filePath = NodePath.join(directory, "proof.txt");
          yield* Effect.tryPromise({
            try: () => NodeFSP.writeFile(filePath, "hello world"),
            catch: () => new Error("fixture-write-failed"),
          });
          let uploaded = "";
          let contentType = "";
          const transport = makeIssueImportAttachmentTransport((async (_url, init) => {
            contentType = new Headers(init?.headers).get("Content-Type") ?? "";
            const chunks: Buffer[] = [];
            const body = init?.body;
            if (body === undefined || body === null) throw new Error("fixture-body-missing");
            for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
              chunks.push(Buffer.from(chunk));
            }
            uploaded = Buffer.concat(chunks).toString("utf8");
            return {
              ok: true,
              json: async () => ({ storageId: "storage-proof" }),
            } as Response;
          }) as typeof globalThis.fetch);
          const harness = backendHarness();
          const result = yield* runIssueImportExecutor(
            runtime(harness.backend, attachmentSnapshot(filePath), {
              attachmentTransport: transport,
            }),
          );

          assert.equal(uploaded, "hello world");
          assert.equal(contentType, "text/plain");
          assert.equal(harness.calls.finalizes[0]?.byteSize, 11);
          assert.equal(
            harness.calls.finalizes[0]?.checksum,
            "sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
          );
          assert.equal(result.attachmentUploads[0]?.status, "finalized");
        }),
      (directory) =>
        Effect.tryPromise({
          try: () => NodeFSP.rm(directory, { recursive: true, force: true }),
          catch: () => new Error("fixture-cleanup-failed"),
        }).pipe(Effect.orElseSucceed(() => undefined)),
    ),
  );

  it.effect("fails before start/apply for null and stale attachment paths", () =>
    Effect.gen(function* () {
      for (const filePath of [null, "/missing/pathway-proof.txt"] as const) {
        const harness = backendHarness();
        const exit = yield* Effect.exit(
          runIssueImportExecutor(runtime(harness.backend, attachmentSnapshot(filePath))),
        );

        assert.isTrue(Exit.isFailure(exit));
        if (Exit.isFailure(exit)) {
          expect(Cause.pretty(exit.cause)).toContain("IssueImportAttachmentError");
        }
        assert.equal(harness.calls.tracker, 0);
        assert.equal(harness.calls.applyEntities.length, 0);
        assert.equal(harness.calls.complete.length, 0);
      }
    }),
  );

  it.effect("fails closed on missing cloud-sync configuration before reads or backend calls", () =>
    Effect.gen(function* () {
      let snapshotReads = 0;
      const harness = backendHarness();
      const exit = yield* Effect.exit(
        runIssueImportExecutor(
          runtime(harness.backend, snapshot(), {
            preflight: new IssueImportPreflightError({
              reason: "cloud-sync-not-configured",
              message: "Cloud sync is not configured.",
            }),
            readSnapshot: Effect.sync(() => {
              snapshotReads += 1;
              return snapshot();
            }),
          }),
        ),
      );

      assert.isTrue(Exit.isFailure(exit));
      assert.equal(snapshotReads, 0);
      assert.equal(harness.calls.get, 0);
      assert.equal(harness.calls.list, 0);
      assert.equal(harness.calls.tracker, 0);
    }),
  );
});
