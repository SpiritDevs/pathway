import { describe, expect, it } from "@effect/vitest";
import { issueCollectionProjectionFromReplica } from "@spiritdevs/backend/sync/issueLegacyProjection";
import {
  cloudEntityCodec,
  EMPTY_STORED_SYNC_STATE,
  issueCreateOperation,
  issueSyncDomainAdapter,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type CloudSyncEntity,
  type StoredSyncEntity,
  type StoredOutboxEntry,
  type StoredSyncState,
} from "@spiritdevs/client-runtime/sync";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { CloudUserId, CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncEntityKind,
} from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CloudSyncEngineRegistry,
  type CloudSyncEngineRegistryShape,
  type CloudSyncIssueEngineHandle,
} from "../cloud/CloudSyncEngineRegistry.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import {
  issueMemberActorFromStoredReplica,
  issueReadModelFromStoredReplica,
  makeIssueReplicaReader,
  routeReplicaIssueRead,
} from "./IssueReplicaReader.ts";

const COMPANY_ID = CompanyId.make("company-server-issue-reads");
const ENVIRONMENT_ID = EnvironmentId.make("environment-server-issue-reads");
const PROJECT_ID = ProjectId.make("project-server-issue-reads");

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: ENVIRONMENT_ID,
  threadId: ThreadId.make("thread-server-issue-reads"),
  projectId: PROJECT_ID,
  providerSessionId: "provider-session-server-issue-reads",
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerDriverKind: ProviderDriverKind.make("codex"),
  capabilities: new Set(McpInvocationContext.ALL_MCP_CAPABILITIES),
  issuedAt: 1,
};

function realCodecEntity(
  entityKind: SyncEntityKind,
  payload: Record<string, unknown>,
): StoredSyncEntity {
  const codec = cloudEntityCodec(entityKind);
  if (codec === null) throw new Error(`Missing codec for ${entityKind}.`);
  const decoded: CloudSyncEntity = Option.getOrThrow(codec.decode(payload));
  return {
    entityKind,
    entityId: SyncEntityId.make(payload["id"] as string),
    version: CompanyVersion.make(1),
    payload: codec.encode(decoded),
  };
}

function replica(overrides: Partial<StoredSyncState> = {}): StoredSyncState {
  return {
    ...EMPTY_STORED_SYNC_STATE,
    checkpoint: {
      schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
      bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
      companyId: COMPANY_ID,
      cursor: CompanyVersion.make(1),
      authorizationEpoch: AuthorizationEpoch.make(1),
      bootstrapped: true,
    },
    entities: [
      realCodecEntity("issueStatus", {
        id: "status-ready",
        scope: "company",
        teamId: null,
        baseStatusId: null,
        name: "Ready",
        color: "#123456",
        category: "unstarted",
        position: 0,
        hidden: false,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
      }),
      realCodecEntity("issue", {
        id: "issue-replica",
        key: "SYNC-7",
        keyNumber: 7,
        title: "Visible to the server",
        description: "From Convex",
        statusId: "status-ready",
        priority: "high",
        assignee: null,
        projectId: null,
        milestoneId: null,
        cycleId: null,
        parentId: null,
        sortOrder: "m",
        labelIds: [],
        dueDate: null,
        triage: false,
        slackSource: null,
        teamIds: [],
        workflowOwner: { kind: "company" },
        workModelSelection: null,
        automationAssignment: null,
        pullRequest: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_000_100,
      }),
    ],
    ...overrides,
  };
}

describe("issueReadModelFromStoredReplica", () => {
  it("decodes the durable rows with the production codec and projects legacy issue shapes", () => {
    const readModel = issueReadModelFromStoredReplica(replica());
    expect(readModel).not.toBeNull();
    const projected = issueCollectionProjectionFromReplica(readModel!);
    expect(projected.issues).toEqual([
      expect.objectContaining({
        id: "issue-replica",
        key: "SYNC-7",
        title: "Visible to the server",
        deletedAt: null,
        createdAt: "2023-11-14T22:13:20.000Z",
      }),
    ]);
    expect(projected.statuses).toEqual([
      expect.objectContaining({ id: "status-ready", name: "Ready", category: "unstarted" }),
    ]);
  });

  it("does not route a partial or obsolete bootstrap", () => {
    expect(
      issueReadModelFromStoredReplica(
        replica({ checkpoint: { ...replica().checkpoint!, bootstrapped: false } }),
      ),
    ).toBeNull();
    expect(
      issueReadModelFromStoredReplica(
        replica({ checkpoint: { ...replica().checkpoint!, bootstrapGeneration: 0 } }),
      ),
    ).toBeNull();
  });

  it("does not route an otherwise ready replica with an undecodable confirmed row", () => {
    const stored = replica();
    expect(
      issueReadModelFromStoredReplica({
        ...stored,
        entities: [{ ...stored.entities[0]!, payload: { id: "status-ready" } }],
      }),
    ).toBeNull();
  });

  it("folds a real-codec pending outbox operation into the routed read model", () => {
    const operation = issueCreateOperation(
      { title: "Queued on the server", statusId: "status-ready" as never },
      "issue-pending" as never,
    );
    const outbox: StoredOutboxEntry = {
      envelope: {
        protocolVersion: SYNC_PROTOCOL_VERSION,
        operationId: SyncOperationId.make("operation-pending"),
        companyId: COMPANY_ID,
        clientId: SyncClientId.make("server-reader-test"),
        environmentId: "environment-reader-test" as never,
        actor: { kind: "environment", environmentId: "environment-reader-test" as never },
        localSequence: LocalSequence.make(1),
        baseVersion: CompanyVersion.make(1),
        kind: operation.kind,
        entityId: operation.entityId,
        args: issueSyncDomainAdapter.operationCodec.encode(operation),
        dependsOn: [],
      },
      status: { _tag: "Pending" },
      occurredAt: 1_700_000_001_000,
    };

    const readModel = issueReadModelFromStoredReplica(replica({ outbox: [outbox] }));
    expect(readModel?.issues).toEqual([
      expect.objectContaining({
        id: "issue-pending",
        key: "Draft",
        title: "Queued on the server",
      }),
      expect.objectContaining({
        id: "issue-replica",
      }),
    ]);
  });
});

describe("issueMemberActorFromStoredReplica", () => {
  it("resolves only an active membership from a ready replica", () => {
    const active = realCodecEntity("membership", {
      id: "membership-active",
      userId: "user-active",
      state: "active",
      displayNameSnapshot: "Corey",
      emailSnapshot: "corey@example.com",
      invitedByMembershipId: null,
      joinedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const left = realCodecEntity("membership", {
      id: "membership-left",
      userId: "user-left",
      state: "left",
      displayNameSnapshot: "Grace",
      emailSnapshot: "grace@example.com",
      invitedByMembershipId: null,
      joinedAt: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const stored = replica({ entities: [...replica().entities, active, left] });
    expect(issueMemberActorFromStoredReplica(stored, "user-active")).toEqual({
      kind: "member",
      membershipId: "membership-active",
    });
    expect(issueMemberActorFromStoredReplica(stored, "user-left")).toBeNull();
  });
});

describe("routeReplicaIssueRead", () => {
  it.effect("keeps the company-less legacy RPC on local storage", () =>
    Effect.gen(function* () {
      const reader = yield* makeIssueReplicaReader();
      expect(yield* reader.companyId).toBeNull();
      expect(yield* reader.read).toBeNull();
      expect(yield* reader.memberActorForCloudUserId("cloud-user")).toBeNull();
    }),
  );

  it.effect("uses a ready replica without evaluating the legacy read", () =>
    Effect.gen(function* () {
      const readModel = issueReadModelFromStoredReplica(replica())!;
      let legacyReads = 0;
      const value = yield* routeReplicaIssueRead({
        replica: Effect.succeed(readModel),
        fromReplica: (model) => Effect.succeed(model.issues[0]!.key),
        fromLegacy: Effect.sync(() => {
          legacyReads += 1;
          return "legacy";
        }),
      });
      expect(value).toBe("SYNC-7");
      expect(legacyReads).toBe(0);
    }),
  );

  it.effect("falls back to the untouched legacy read when no ready replica exists", () =>
    Effect.gen(function* () {
      const value = yield* routeReplicaIssueRead({
        replica: Effect.succeed(null),
        fromReplica: () => Effect.succeed("replica"),
        fromLegacy: Effect.succeed("legacy"),
      });
      expect(value).toBe("legacy");
    }),
  );

  it.effect("routes an MCP invocation through its project-bound company engine", () =>
    Effect.gen(function* () {
      const readModel = issueReadModelFromStoredReplica(replica())!;
      const routedReadModel = {
        ...readModel,
        issues: readModel.issues.map((issue) => ({
          ...issue,
          projectId: CloudProjectId.make("cloud-project-server-issue-reads"),
        })),
        memberships: [
          {
            entityKind: "membership" as const,
            id: MembershipId.make("membership-active"),
            userId: CloudUserId.make("cloud-user"),
            state: "active" as const,
            displayNameSnapshot: "Corey",
            emailSnapshot: "corey@example.com",
            invitedByMembershipId: null,
            joinedAt: 1,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      };
      const handle = {
        companyId: COMPANY_ID,
        environmentId: ENVIRONMENT_ID,
        enqueue: () => Effect.die("unused"),
        sync: Effect.die("unused"),
        operationDisposition: () => Effect.die("unused"),
        readIssueSnapshot: Effect.succeed({
          readModel: routedReadModel,
          bootstrapped: true,
          quarantined: 0,
        }),
      } satisfies CloudSyncIssueEngineHandle;
      const registry = CloudSyncEngineRegistry.of({
        expectIssueRouting: () => Effect.void,
        registerIssueEngine: () => Effect.void,
        unregisterIssueEngine: () => Effect.void,
        withIssueEngine: (_input, use) => use,
        issueEngine: () => Effect.succeed(handle),
        issueEngineForProject: (input) => {
          expect(input).toEqual({
            environmentId: ENVIRONMENT_ID,
            localProjectId: PROJECT_ID,
          });
          return Effect.succeed({
            _tag: "Ready",
            engine: handle,
            readModel: routedReadModel,
            projectBindings: [
              {
                localProjectId: PROJECT_ID,
                cloudProjectId: CloudProjectId.make("cloud-project-server-issue-reads"),
              },
              {
                localProjectId: ProjectId.make("sibling-checkout"),
                cloudProjectId: CloudProjectId.make("cloud-project-server-issue-reads"),
              },
            ],
          });
        },
      } satisfies CloudSyncEngineRegistryShape);
      const reader = yield* makeIssueReplicaReader(registry);
      const provideInvocation = Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        invocation,
      );

      expect(yield* reader.companyId.pipe(provideInvocation)).toBe(COMPANY_ID);
      const routed = yield* reader.resolve.pipe(provideInvocation);
      expect(routed?.readModel.issues[0]?.key).toBe("SYNC-7");
      expect(routed?.readModel.issues[0]?.projectId).toBe(PROJECT_ID);
      expect(routed?.cloudProjectIdForLocal(PROJECT_ID)).toBe("cloud-project-server-issue-reads");
      expect(routed?.cloudProjectIdForLocal("sibling-checkout")).toBe(
        "cloud-project-server-issue-reads",
      );
      const firstRead = yield* routed!.read;
      const secondRead = yield* routed!.read;
      expect(secondRead).toBe(firstRead);
      expect(routed?.actor).toEqual({
        kind: "agent",
        provider: "codex",
        onBehalfOfMembershipId: null,
      });
      expect(yield* reader.memberActorForCloudUserId("cloud-user").pipe(provideInvocation)).toEqual(
        {
          kind: "member",
          membershipId: "membership-active",
        },
      );
    }),
  );

  it.effect("fails closed when cloud sync is active but the project has no company binding", () =>
    Effect.gen(function* () {
      const registry = CloudSyncEngineRegistry.of({
        expectIssueRouting: () => Effect.void,
        registerIssueEngine: () => Effect.void,
        unregisterIssueEngine: () => Effect.void,
        withIssueEngine: (_input, use) => use,
        issueEngine: () => Effect.succeed(null),
        issueEngineForProject: () => Effect.succeed({ _tag: "Unbound", companyIds: [COMPANY_ID] }),
      } satisfies CloudSyncEngineRegistryShape);
      const reader = yield* makeIssueReplicaReader(registry);
      const error = yield* reader.read.pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
        Effect.flip,
      );
      expect(error.reason).toBe("storage");
      expect(error.message).toContain("not bound to a ready company replica");
    }),
  );
});
