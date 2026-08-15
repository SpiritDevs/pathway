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
import { CompanyId } from "@spiritdevs/contracts/company";
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

import { issueReadModelFromStoredReplica, routeReplicaIssueRead } from "./IssueReplicaReader.ts";

const COMPANY_ID = CompanyId.make("company-server-issue-reads");

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

describe("routeReplicaIssueRead", () => {
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
});
