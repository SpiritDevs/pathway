import { describe, expect, it } from "@effect/vitest";
import {
  CompanyVersion,
  SYNC_ENTITY_KINDS,
  SYNC_OPERATION_KINDS,
  SyncEntityId,
  teamMembershipSyncEntityId,
  type SyncChangeEnvelope,
  type SyncEntityKind,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import * as Option from "effect/Option";

import type { SyncDomainAdapter } from "./adapter.ts";
import {
  COMPANY_SYNC_ENTITY_KINDS,
  companyEntityCodec,
  isCompanySyncEntityKind,
  type CompanySyncEntity,
  type CompanySyncEntityKind,
} from "./companyDomain.ts";
import {
  ISSUE_SYNC_ENTITY_KINDS,
  cloudEntityCodec,
  decodeIssueSyncOperation,
  issueEntityCodec,
  issueSyncDomainAdapter,
  makeIssueSyncAdapter,
  type CloudSyncEntity,
  type IssueSyncOperation,
} from "./issueDomain.ts";
import { SYNC_INITIAL_EPOCH, syncEntityKey } from "./model.ts";
import { applyConfirmedChanges, emptyConfirmedReplica } from "./replica.ts";

const COMPANY_ID = "0191f0a0-0000-7000-8000-0000000000c0";
const MEMBERSHIP_ID = "0191f0a0-0000-7000-8000-0000000000m1";
const OTHER_MEMBERSHIP_ID = "0191f0a0-0000-7000-8000-0000000000m2";
const TEAM_ID = "0191f0a0-0000-7000-8000-0000000000t1";
const ROLE_ID = "0191f0a0-0000-7000-8000-0000000000r1";
const ASSIGNMENT_ID = "0191f0a0-0000-7000-8000-0000000000a1";
const CLOUD_PROJECT_ID = "0191f0a0-0000-7000-8000-0000000000p1";
const ENVIRONMENT_BINDING_ID = "0191f0a0-0000-7000-8000-0000000000b1";
const ENVIRONMENT_REGISTRATION_ID = "0191f0a0-0000-7000-8000-0000000000e1";
const ENVIRONMENT_ID = "environment-1";
const THREAD_ID = "0191f0a0-0000-7000-8000-0000000000d1";

/**
 * One representative payload per kind, exactly as Convex would append it: no `companyId`, no
 * `version`, no `deletedAt`. Nullable fields are exercised in both directions across the set —
 * `company.deletionScheduledAt` and `membership.invitedByMembershipId` are null here while
 * `companySettings.updatedByMembershipId` and `team.archivedAt` are set — so a schema that
 * accidentally required one would fail on this table alone.
 */
const ENTITY_PAYLOADS: Record<CompanySyncEntityKind, Record<string, unknown>> = {
  company: {
    id: COMPANY_ID,
    name: "Spirit Devs",
    issueKeyPrefix: "PAT",
    lifecycleState: "active",
    deletionScheduledAt: null,
    purgeAfter: null,
    owners: [
      { membershipId: MEMBERSHIP_ID, grantedByMembershipId: null, createdAt: 1_000 },
      {
        membershipId: OTHER_MEMBERSHIP_ID,
        grantedByMembershipId: MEMBERSHIP_ID,
        createdAt: 2_000,
      },
    ],
    createdAt: 1_000,
    updatedAt: 3_000,
  },
  companySettings: {
    id: COMPANY_ID,
    offlineAccessDays: 30,
    updatedByMembershipId: MEMBERSHIP_ID,
    createdAt: 1_000,
    updatedAt: 2_000,
  },
  membership: {
    id: MEMBERSHIP_ID,
    userId: "user-1",
    state: "active",
    displayNameSnapshot: "Ada Lovelace",
    emailSnapshot: "ada@example.com",
    invitedByMembershipId: null,
    joinedAt: 1_000,
    createdAt: 1_000,
    updatedAt: 1_500,
  },
  team: {
    id: TEAM_ID,
    name: "Platform",
    description: "",
    archivedAt: 9_000,
    createdAt: 1_000,
    updatedAt: 9_000,
  },
  teamMembership: {
    id: `${TEAM_ID}:${MEMBERSHIP_ID}`,
    teamId: TEAM_ID,
    membershipId: MEMBERSHIP_ID,
    createdAt: 1_000,
  },
  role: {
    id: ROLE_ID,
    name: "Manager",
    description: "Runs a team",
    permissions: ["issues.read", "issues.update", "teams.read"],
    seeded: true,
    createdAt: 1_000,
    updatedAt: 1_000,
  },
  roleAssignment: {
    id: ASSIGNMENT_ID,
    membershipId: MEMBERSHIP_ID,
    roleId: ROLE_ID,
    scope: { kind: "team", teamId: TEAM_ID },
    createdAt: 1_000,
  },
  environmentRegistration: {
    id: ENVIRONMENT_REGISTRATION_ID,
    environmentId: ENVIRONMENT_ID,
    publicKeyThumbprint: "thumbprint",
    descriptor: {
      environmentId: ENVIRONMENT_ID,
      label: "Build machine",
      platform: { os: "linux", arch: "x64" },
      serverVersion: "2026.8.0",
      capabilities: { repositoryIdentity: true },
    },
    relayLinkState: "linked",
    managedEndpointAvailable: true,
    lastSeenAt: 2_000,
    serviceRoleIds: [ROLE_ID],
    teamIds: [TEAM_ID],
    state: "active",
    registeredByMembershipId: MEMBERSHIP_ID,
    createdAt: 1_000,
    updatedAt: 2_000,
  },
  environmentBinding: {
    id: ENVIRONMENT_BINDING_ID,
    cloudProjectId: CLOUD_PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    localProjectId: CLOUD_PROJECT_ID,
    localWorkspaceRoot: "/workspace/pathway",
    status: "active",
    lastSeenAt: 2_000,
    createdAt: 1_000,
    updatedAt: 2_000,
  },
  cloudProject: {
    id: CLOUD_PROJECT_ID,
    name: "Pathway",
    description: "The agent client",
    teamIds: [TEAM_ID],
    defaultWorkflowOwner: { kind: "team", teamId: TEAM_ID },
    preferredBindingId: ENVIRONMENT_BINDING_ID,
    archivedAt: null,
    createdAt: 1_000,
    updatedAt: 2_000,
  },
  agentThread: {
    id: `${ENVIRONMENT_ID}:${THREAD_ID}`,
    environmentId: ENVIRONMENT_ID,
    cloudProjectId: CLOUD_PROJECT_ID,
    shell: {
      createdBy: "user",
      creationSource: "web",
      id: THREAD_ID,
      projectId: CLOUD_PROJECT_ID,
      title: "Remote thread",
      providerInstanceId: "codex",
      modelSelection: { instanceId: "codex", model: "gpt-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: THREAD_ID,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      pendingBackgroundTasks: [],
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
    },
    updatedAt: 2_000,
  },
};

// ---------------------------------------------------------------------------
// Entity kinds
// ---------------------------------------------------------------------------

describe("company entity kinds", () => {
  it("covers the protocol's company read-domain tables and no issue table", () => {
    expect([...COMPANY_SYNC_ENTITY_KINDS].sort()).toEqual(
      [
        "company",
        "companySettings",
        "cloudProject",
        "agentThread",
        "environmentBinding",
        "environmentRegistration",
        "membership",
        "role",
        "roleAssignment",
        "team",
        "teamMembership",
      ].sort(),
    );
    for (const kind of COMPANY_SYNC_ENTITY_KINDS) {
      expect(SYNC_ENTITY_KINDS).toContain(kind);
      expect(ISSUE_SYNC_ENTITY_KINDS).not.toContain(kind);
    }
  });

  it("is disjoint from the issue domain, so the adapter's dispatch cannot be ambiguous", () => {
    for (const kind of ISSUE_SYNC_ENTITY_KINDS) {
      expect(isCompanySyncEntityKind(kind)).toBe(false);
    }
    // Invitations are query-only: they never became a wire kind, so nothing can route one.
    expect(isCompanySyncEntityKind("companyInvitation")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Entity codecs
// ---------------------------------------------------------------------------

describe("company entity codecs", () => {
  it.each([...COMPANY_SYNC_ENTITY_KINDS])("round-trips a %s payload", (kind) => {
    const codec = companyEntityCodec(kind);
    expect(codec).not.toBeNull();
    const decoded = codec?.decode(ENTITY_PAYLOADS[kind]);
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    const entity = Option.getOrThrow(decoded ?? Option.none<CompanySyncEntity>());
    expect(entity.entityKind).toBe(kind);
    // The tag is local; what goes back out is the payload the server would have sent.
    expect(codec?.encode(entity)).toEqual(ENTITY_PAYLOADS[kind]);
  });

  it("takes a company-wide role assignment as readily as a team-scoped one", () => {
    const codec = companyEntityCodec("roleAssignment");
    const payload = { ...ENTITY_PAYLOADS["roleAssignment"], scope: { kind: "company" } };
    const decoded = codec?.decode(payload);
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    expect(codec?.encode(Option.getOrThrow(decoded ?? Option.none()))).toEqual(payload);
  });

  it("refuses a team-scoped assignment with no team, the way the tagged scope promises", () => {
    const codec = companyEntityCodec("roleAssignment");
    expect(
      codec?.decode({ ...ENTITY_PAYLOADS["roleAssignment"], scope: { kind: "team" } }),
    ).toStrictEqual(Option.none());
  });

  it("keeps a company with no owners decodable, and one with many", () => {
    const codec = companyEntityCodec("company");
    for (const owners of [[], (ENTITY_PAYLOADS["company"] as { owners: unknown[] }).owners]) {
      const decoded = codec?.decode({ ...ENTITY_PAYLOADS["company"], owners });
      expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    }
  });

  it("accepts both nullable cloud-project owner and binding fields", () => {
    const codec = companyEntityCodec("cloudProject");
    const payload = {
      ...ENTITY_PAYLOADS["cloudProject"],
      defaultWorkflowOwner: null,
      preferredBindingId: null,
      archivedAt: 9_000,
    };
    const decoded = codec?.decode(payload);
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    expect(codec?.encode(Option.getOrThrow(decoded ?? Option.none()))).toEqual(payload);
  });

  it("survives a permission this build does not know rather than losing the role", () => {
    // The `roles` table stores permissions as open strings precisely so a role written by a newer
    // deployment survives a rollback; quarantining it would take the whole role list with it.
    const codec = companyEntityCodec("role");
    const decoded = codec?.decode({
      ...ENTITY_PAYLOADS["role"],
      permissions: ["issues.read", "warpDrive.engage"],
    });
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
  });

  it("ignores the company scope the wire carries and the replica does not need", () => {
    const codec = companyEntityCodec("membership");
    const decoded = codec?.decode({ ...ENTITY_PAYLOADS["membership"], companyId: COMPANY_ID });
    expect(decoded !== undefined && Option.isSome(decoded)).toBe(true);
    expect(codec?.encode(Option.getOrThrow(decoded ?? Option.none()))).toEqual(
      ENTITY_PAYLOADS["membership"],
    );
  });

  it("quarantines a payload this build cannot read", () => {
    const codec = companyEntityCodec("membership");
    expect(codec?.decode({ id: MEMBERSHIP_ID })).toStrictEqual(Option.none());
    expect(codec?.decode({ ...ENTITY_PAYLOADS["membership"], state: "furloughed" })).toStrictEqual(
      Option.none(),
    );
    expect(
      companyEntityCodec("companySettings")?.decode({
        ...ENTITY_PAYLOADS["companySettings"],
        offlineAccessDays: 400,
      }),
    ).toStrictEqual(Option.none());
  });

  it("answers null for a table this domain does not replicate", () => {
    for (const kind of SYNC_ENTITY_KINDS) {
      const expected = isCompanySyncEntityKind(kind) ? "codec" : "none";
      expect(companyEntityCodec(kind) === null ? "none" : "codec").toBe(expected);
    }
    expect(companyEntityCodec("issue" satisfies SyncEntityKind)).toBeNull();
  });

  it("derives one team-membership id both sides can agree on", () => {
    expect(teamMembershipSyncEntityId(TEAM_ID, MEMBERSHIP_ID)).toBe(`${TEAM_ID}:${MEMBERSHIP_ID}`);
    expect(teamMembershipSyncEntityId(TEAM_ID, MEMBERSHIP_ID)).not.toBe(
      teamMembershipSyncEntityId(TEAM_ID, OTHER_MEMBERSHIP_ID),
    );
  });
});

// ---------------------------------------------------------------------------
// Adapter dispatch
// ---------------------------------------------------------------------------

describe("the widened adapter", () => {
  const adapter = makeIssueSyncAdapter();

  it("routes every kind of both domains and nothing else", () => {
    for (const kind of SYNC_ENTITY_KINDS) {
      const known =
        isCompanySyncEntityKind(kind) || ISSUE_SYNC_ENTITY_KINDS.includes(kind as never);
      expect(adapter.entityCodec(kind) === null ? "none" : "codec").toBe(known ? "codec" : "none");
    }
    expect(adapter.entityCodec("cloudProject")).not.toBeNull();
    expect(adapter.entityCodec("futureEntity" as SyncEntityKind)).toBeNull();
  });

  it("decodes a company row through the company codec and an issue row through the issue one", () => {
    const membership = adapter.entityCodec("membership")?.decode(ENTITY_PAYLOADS["membership"]);
    expect(membership !== undefined && Option.isSome(membership)).toBe(true);
    expect(Option.getOrThrow(membership ?? Option.none()).entityKind).toBe("membership");
    // The issue side is untouched: `issueEntityCodec` still owns exactly the twelve issue tables.
    expect(issueEntityCodec("membership")).toBeNull();
    expect(cloudEntityCodec("membership")).not.toBeNull();
  });

  it("names no company verb as an operation kind", () => {
    // Plan line 322: company administration is online-only. If a company kind ever gained an
    // operation, the outbox would be holding a write no server mutation accepts.
    for (const kind of SYNC_OPERATION_KINDS) {
      expect(isCompanySyncEntityKind(kind.slice(0, kind.indexOf(".")))).toBe(false);
    }
  });

  it("rejects an operation envelope naming a company kind instead of applying it", () => {
    const envelope = {
      protocolVersion: 1,
      operationId: "0191f0a0-0000-7000-8000-0000000000o1",
      companyId: COMPANY_ID,
      clientId: "device-1",
      environmentId: null,
      actor: { kind: "member", membershipId: MEMBERSHIP_ID },
      localSequence: 1,
      baseVersion: 0,
      entityId: MEMBERSHIP_ID,
      dependsOn: [],
      kind: "membership.setState",
      args: { state: "locked" },
    } as unknown as SyncOperationEnvelope;

    expect(decodeIssueSyncOperation(envelope)).toStrictEqual(Option.none());
    expect(adapter.decodeOperation?.(envelope)).toStrictEqual(Option.none());
    // The arguments codec never guesses a kind either, so there is no second way in.
    expect(adapter.operationCodec.decode(envelope.args)).toStrictEqual(Option.none());
  });

  it("keeps the operation domain issues-only", () => {
    expect(adapter.domain).toBe("issues");
    expect(issueSyncDomainAdapter.entityCodec("team")).not.toBeNull();
  });

  it("lets the confirmed row win outright for a read cache", () => {
    // No `mergeConfirmed`: a company entity has no locally derived field to keep alive, so the
    // engine's default replacement is the whole conflict rule.
    expect(adapter.mergeConfirmed).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The confirmed replica
// ---------------------------------------------------------------------------

const change = (input: {
  readonly version: number;
  readonly entityKind: SyncEntityKind;
  readonly entityId: string;
  readonly payload: unknown;
}): SyncChangeEnvelope => ({
  version: CompanyVersion.make(input.version),
  entityKind: input.entityKind,
  entityId: SyncEntityId.make(input.entityId),
  changeKind: "upsert",
  payload: input.payload,
});

const foldInto = (
  adapter: SyncDomainAdapter<CloudSyncEntity, IssueSyncOperation>,
  changes: ReadonlyArray<SyncChangeEnvelope>,
) =>
  applyConfirmedChanges({
    replica: emptyConfirmedReplica<CloudSyncEntity>({
      cursor: CompanyVersion.make(0),
      authorizationEpoch: SYNC_INITIAL_EPOCH,
    }),
    adapter,
    changes,
    cursor: CompanyVersion.make(changes.length),
    authorizationEpoch: SYNC_INITIAL_EPOCH,
  });

describe("company rows in the confirmed replica", () => {
  const adapter = makeIssueSyncAdapter();
  const membershipChange = change({
    version: 1,
    entityKind: "membership",
    entityId: MEMBERSHIP_ID,
    payload: ENTITY_PAYLOADS["membership"],
  });

  it("folds a membership feed row into the replica instead of quarantining it", () => {
    const result = foldInto(adapter, [membershipChange]);
    expect(result.quarantined).toBe(0);
    const stored = result.replica.entities.get(
      syncEntityKey({ entityKind: "membership", entityId: SyncEntityId.make(MEMBERSHIP_ID) }),
    );
    expect(stored?.entity.entityKind).toBe("membership");
    expect(stored?.entity).toMatchObject({ displayNameSnapshot: "Ada Lovelace", state: "active" });
    // The row is persisted with the payload exactly as it arrived, so a reload decodes the same.
    expect(result.upserts).toEqual([
      {
        entityKind: "membership",
        entityId: MEMBERSHIP_ID,
        version: CompanyVersion.make(1),
        payload: ENTITY_PAYLOADS["membership"],
      },
    ]);
  });

  it("materializes a cloud-project feed row instead of quarantine-skipping it", () => {
    const result = foldInto(adapter, [
      change({
        version: 1,
        entityKind: "cloudProject",
        entityId: CLOUD_PROJECT_ID,
        payload: ENTITY_PAYLOADS["cloudProject"],
      }),
    ]);
    expect(result.quarantined).toBe(0);
    expect(
      result.replica.entities.get(
        syncEntityKey({
          entityKind: "cloudProject",
          entityId: SyncEntityId.make(CLOUD_PROJECT_ID),
        }),
      )?.entity,
    ).toMatchObject({
      entityKind: "cloudProject",
      id: CLOUD_PROJECT_ID,
      preferredBindingId: ENVIRONMENT_BINDING_ID,
    });
  });

  it("is exactly what the issue-only adapter used to do differently", () => {
    // The same row through an adapter that knows only the issue tables: quarantined, not folded.
    // This is the behaviour phase 4 replaced, kept here so a regression is loud.
    const issuesOnly = {
      ...adapter,
      entityCodec: issueEntityCodec,
    } as unknown as SyncDomainAdapter<CloudSyncEntity, IssueSyncOperation>;
    const result = foldInto(issuesOnly, [membershipChange]);
    expect(result.quarantined).toBe(1);
    expect(result.replica.entities.size).toBe(0);
  });

  it("lets the later confirmed row replace the earlier one", () => {
    const result = foldInto(adapter, [
      membershipChange,
      change({
        version: 2,
        entityKind: "membership",
        entityId: MEMBERSHIP_ID,
        payload: { ...ENTITY_PAYLOADS["membership"], state: "locked", updatedAt: 4_000 },
      }),
    ]);
    const stored = result.replica.entities.get(
      syncEntityKey({ entityKind: "membership", entityId: SyncEntityId.make(MEMBERSHIP_ID) }),
    );
    expect(stored?.entity).toMatchObject({ state: "locked", updatedAt: 4_000 });
    expect(stored?.version).toBe(2);
  });

  it("removes a team membership on its tombstone, matching the composite id", () => {
    const entityId = teamMembershipSyncEntityId(TEAM_ID, MEMBERSHIP_ID);
    const result = foldInto(adapter, [
      change({
        version: 1,
        entityKind: "teamMembership",
        entityId,
        payload: ENTITY_PAYLOADS["teamMembership"],
      }),
      {
        version: CompanyVersion.make(2),
        entityKind: "teamMembership",
        entityId,
        changeKind: "tombstone",
        payload: null,
      },
    ]);
    expect(result.quarantined).toBe(0);
    expect(result.replica.entities.size).toBe(0);
    expect(result.deletes).toEqual([{ entityKind: "teamMembership", entityId }]);
  });

  it("carries a company row with its owners embedded, so ownership cannot half-arrive", () => {
    const result = foldInto(adapter, [
      change({
        version: 1,
        entityKind: "company",
        entityId: COMPANY_ID,
        payload: ENTITY_PAYLOADS["company"],
      }),
    ]);
    const stored = result.replica.entities.get(
      syncEntityKey({ entityKind: "company", entityId: SyncEntityId.make(COMPANY_ID) }),
    );
    expect(stored?.entity.entityKind).toBe("company");
    expect(stored?.entity).toMatchObject({
      owners: [
        { membershipId: MEMBERSHIP_ID, grantedByMembershipId: null, createdAt: 1_000 },
        {
          membershipId: OTHER_MEMBERSHIP_ID,
          grantedByMembershipId: MEMBERSHIP_ID,
          createdAt: 2_000,
        },
      ],
    });
  });
});
