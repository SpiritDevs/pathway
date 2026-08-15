import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ISSUE_KEY_BLOCK_SIZE,
  ISSUE_KEY_DRAFT_PLACEHOLDER,
  ISSUE_KEY_REPLENISH_THRESHOLD,
  IssueKeyBlock,
  SYNC_ENTITY_KINDS,
  SYNC_MAX_CHANGES_PER_PAGE,
  SYNC_MAX_OPERATION_ARGS_BYTES,
  SYNC_MAX_OPERATIONS_PER_BATCH,
  SYNC_OPERATION_KINDS,
  SYNC_PROTOCOL_VERSION,
  SyncApplyOperationsRequest,
  SyncApplyOperationsResponse,
  SyncChangeEnvelope,
  SyncCompanyPayload,
  SyncCompanySettingsPayload,
  SyncEnvironmentCommandPayload,
  SyncListChangesResponse,
  SyncMembershipPayload,
  SyncOperation,
  SyncOperationEnvelope,
  SyncPresentation,
  SyncRoleAssignmentPayload,
  SyncRolePayload,
  SyncTeamMembershipPayload,
  SyncTeamPayload,
  grantedCompanyPermissions,
  isSyncOperationKind,
  shouldReplenishIssueKeys,
  teamMembershipSyncEntityId,
} from "./cloudSync.ts";
import { IssueActor, IssueAssignee } from "./issues.ts";

const header = {
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: "0191f0a0-0000-7000-8000-000000000001",
  companyId: "0191f0a0-0000-7000-8000-0000000000c0",
  clientId: "device-1",
  environmentId: null,
  actor: { kind: "member" as const, membershipId: "0191f0a0-0000-7000-8000-0000000000m1" },
  localSequence: 7,
  baseVersion: 12,
  entityId: "0191f0a0-0000-7000-8000-0000000000e1",
  dependsOn: [],
};

const decodeOperation = Schema.decodeUnknownSync(SyncOperation);
const decodeEnvelope = Schema.decodeUnknownSync(SyncOperationEnvelope);
const decodeChange = Schema.decodeUnknownSync(SyncChangeEnvelope);
const decodeListChanges = Schema.decodeUnknownSync(SyncListChangesResponse);
const decodeApplyRequest = Schema.decodeUnknownSync(SyncApplyOperationsRequest);
const decodeApplyResponse = Schema.decodeUnknownSync(SyncApplyOperationsResponse);
const decodeIssueKeyBlock = Schema.decodeUnknownSync(IssueKeyBlock);
const decodePresentation = Schema.decodeUnknownSync(SyncPresentation);
const decodeActor = Schema.decodeUnknownSync(IssueActor);
const decodeCompany = Schema.decodeUnknownSync(SyncCompanyPayload);
const decodeCompanySettings = Schema.decodeUnknownSync(SyncCompanySettingsPayload);
const decodeEnvironmentCommand = Schema.decodeUnknownSync(SyncEnvironmentCommandPayload);
const decodeMembership = Schema.decodeUnknownSync(SyncMembershipPayload);
const decodeTeam = Schema.decodeUnknownSync(SyncTeamPayload);
const decodeTeamMembership = Schema.decodeUnknownSync(SyncTeamMembershipPayload);
const decodeRole = Schema.decodeUnknownSync(SyncRolePayload);
const decodeRoleAssignment = Schema.decodeUnknownSync(SyncRoleAssignmentPayload);
const decodeAssignee = Schema.decodeUnknownSync(IssueAssignee);

describe("sync bounds", () => {
  it("matches the protocol the plan and the backend both enforce", () => {
    expect(SYNC_MAX_OPERATIONS_PER_BATCH).toBe(25);
    expect(SYNC_MAX_OPERATION_ARGS_BYTES).toBe(512 * 1024);
    expect(SYNC_MAX_CHANGES_PER_PAGE).toBe(100);
    expect(ISSUE_KEY_BLOCK_SIZE).toBe(25);
    expect(ISSUE_KEY_REPLENISH_THRESHOLD).toBe(5);
    expect(ISSUE_KEY_DRAFT_PLACEHOLDER).toBe("Draft");
  });

  it("replenishes at five remaining, not at zero", () => {
    expect(shouldReplenishIssueKeys(6)).toBe(false);
    expect(shouldReplenishIssueKeys(5)).toBe(true);
    expect(shouldReplenishIssueKeys(0)).toBe(true);
  });

  it("names every issue command as an operation kind and nothing else", () => {
    expect(new Set(SYNC_OPERATION_KINDS).size).toBe(SYNC_OPERATION_KINDS.length);
    expect(isSyncOperationKind("issue.create")).toBe(true);
    expect(isSyncOperationKind("membership.create")).toBe(false);
  });

  it("keeps entity kinds unique so a change is routed by exactly one codec", () => {
    expect(new Set(SYNC_ENTITY_KINDS).size).toBe(SYNC_ENTITY_KINDS.length);
  });
});

describe("SyncOperation", () => {
  it("decodes a create with its typed arguments", () => {
    const operation = decodeOperation({
      ...header,
      kind: "issue.create",
      args: { title: "Ship the sync engine", priority: "high", teamIds: ["team-1"] },
    });
    expect(operation.kind).toBe("issue.create");
  });

  it("decodes entity-only verbs with no arguments", () => {
    expect(decodeOperation({ ...header, kind: "issue.delete", args: {} }).kind).toBe(
      "issue.delete",
    );
    expect(decodeOperation({ ...header, kind: "issueComment.delete", args: {} }).kind).toBe(
      "issueComment.delete",
    );
  });

  it("refuses arguments that belong to another kind", () => {
    expect(() =>
      decodeOperation({ ...header, kind: "issue.setTeams", args: { title: "not a team list" } }),
    ).toThrow();
  });

  it("refuses an unknown kind rather than passing it through", () => {
    expect(() => decodeOperation({ ...header, kind: "issue.explode", args: {} })).toThrow();
  });

  it("stays decodable as an opaque envelope, which is all the outbox needs", () => {
    const envelope = decodeEnvelope({
      ...header,
      kind: "issueView.update",
      args: { name: "Mine" },
    });
    expect(envelope.operationId).toBe(header.operationId);
  });
});

describe("change delivery", () => {
  it("carries a tombstone with no payload", () => {
    const change = decodeChange({
      version: 41,
      entityKind: "issue",
      entityId: header.entityId,
      changeKind: "tombstone",
      payload: null,
    });
    expect(change.payload).toBeNull();
  });

  it("advances the cursor on an empty permission-filtered page", () => {
    const page = decodeListChanges({
      _tag: "Changes",
      changes: [],
      cursor: 90,
      hasMore: true,
      latestVersion: 120,
      authorizationEpoch: 3,
    });
    expect(page._tag === "Changes" && page.cursor).toBe(90);
  });

  it("tells an expired cursor apart from an empty page", () => {
    const expired = decodeListChanges({
      _tag: "CursorExpired",
      latestVersion: 900,
      authorizationEpoch: 3,
    });
    expect(expired._tag).toBe("CursorExpired");
  });
});

describe("applyOperations", () => {
  it("refuses a batch larger than the ceiling both sides enforce", () => {
    const operations = Array.from({ length: SYNC_MAX_OPERATIONS_PER_BATCH + 1 }, (_, index) => ({
      ...header,
      operationId: `0191f0a0-0000-7000-8000-00000000${String(index).padStart(4, "0")}`,
      kind: "issue.delete",
      args: {},
    }));
    expect(() =>
      decodeApplyRequest({
        companyId: header.companyId,
        operations,
      }),
    ).toThrow();
  });

  it("receipts a duplicate as a success and a rejection with an actionable code", () => {
    const response = decodeApplyResponse({
      receipts: [
        {
          operationId: header.operationId,
          status: "accepted",
          duplicate: true,
          firstVersion: 5,
          lastVersion: 6,
        },
        {
          operationId: "0191f0a0-0000-7000-8000-000000000002",
          status: "rejected",
          duplicate: false,
          code: "permission-denied",
          message: "Missing permission issues.update.",
        },
      ],
      versionFrom: 12,
      versionTo: 12,
      authorizationEpoch: 3,
    });
    expect(response.receipts).toHaveLength(2);
  });

  it("keeps the original rejection when a rejected operation is resent", () => {
    const response = decodeApplyResponse({
      receipts: [
        {
          operationId: header.operationId,
          status: "rejected",
          duplicate: true,
          code: "entity-deleted",
          message: "Issue PAT-12 was deleted.",
        },
      ],
      versionFrom: 12,
      versionTo: 12,
      authorizationEpoch: 3,
    });
    const receipt = response.receipts[0];
    expect(receipt?.status).toBe("rejected");
    expect(receipt?.duplicate).toBe(true);
  });

  it("has no receipt status that hides the outcome behind the resend", () => {
    expect(() =>
      decodeApplyResponse({
        receipts: [
          {
            operationId: header.operationId,
            status: "duplicate",
            firstVersion: 5,
            lastVersion: 6,
          },
        ],
        versionFrom: 12,
        versionTo: 12,
        authorizationEpoch: 3,
      }),
    ).toThrow();
  });
});

describe("company-domain change payloads", () => {
  const OWNER = "0191f0a0-0000-7000-8000-0000000000m1";
  const OTHER = "0191f0a0-0000-7000-8000-0000000000m2";
  const TEAM = "0191f0a0-0000-7000-8000-0000000000t1";
  const ROLE = "0191f0a0-0000-7000-8000-0000000000r1";

  it("carries the company with its owners embedded and its protocol columns left out", () => {
    const company = decodeCompany({
      id: header.companyId,
      name: "Spirit Devs",
      issueKeyPrefix: "PAT",
      lifecycleState: "active",
      deletionScheduledAt: null,
      purgeAfter: null,
      owners: [{ membershipId: OWNER, grantedByMembershipId: null, createdAt: 1_000 }],
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(company.owners.map((owner) => owner.membershipId)).toEqual([OWNER]);
    // `syncVersion`, `authorizationEpoch`, and `nextIssueNumber` are protocol and lease state, not
    // administered fields: they arrive on `sync.latestVersion` and would be stale here.
    expect(Object.keys(SyncCompanyPayload.fields).sort()).toEqual([
      "createdAt",
      "deletionScheduledAt",
      "id",
      "issueKeyPrefix",
      "lifecycleState",
      "name",
      "owners",
      "purgeAfter",
      "updatedAt",
    ]);
  });

  it("takes a company mid-deletion, and refuses a prefix that is not an issue-key prefix", () => {
    const scheduled = decodeCompany({
      id: header.companyId,
      name: "Spirit Devs",
      issueKeyPrefix: "PAT",
      lifecycleState: "deletionScheduled",
      deletionScheduledAt: 5_000,
      purgeAfter: 9_000,
      owners: [],
      createdAt: 1_000,
      updatedAt: 5_000,
    });
    expect(scheduled.purgeAfter).toBe(9_000);
    expect(() =>
      decodeCompany({
        id: header.companyId,
        name: "Spirit Devs",
        issueKeyPrefix: "pat-1",
        lifecycleState: "active",
        deletionScheduledAt: null,
        purgeAfter: null,
        owners: [],
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    ).toThrow();
  });

  it("keys the settings row by its company, because there is exactly one", () => {
    const settings = decodeCompanySettings({
      id: header.companyId,
      offlineAccessDays: 0,
      updatedByMembershipId: null,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(settings.id).toBe(header.companyId);
    expect(() =>
      decodeCompanySettings({
        id: header.companyId,
        offlineAccessDays: 91,
        updatedByMembershipId: null,
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    ).toThrow();
  });

  it("keeps the membership snapshots that outlive the person", () => {
    const membership = decodeMembership({
      id: OWNER,
      userId: "user-1",
      state: "left",
      displayNameSnapshot: "Ada Lovelace",
      emailSnapshot: "ada@example.com",
      invitedByMembershipId: OTHER,
      joinedAt: 1_000,
      createdAt: 1_000,
      updatedAt: 8_000,
    });
    expect(membership.state).toBe("left");
    expect(membership.displayNameSnapshot).toBe("Ada Lovelace");
  });

  it("treats an archived team as a live row with a timestamp", () => {
    expect(
      decodeTeam({
        id: TEAM,
        name: "Platform",
        description: "",
        archivedAt: 9_000,
        createdAt: 1_000,
        updatedAt: 9_000,
      }).archivedAt,
    ).toBe(9_000);
  });

  it("gives the join table a composite id both sides derive the same way", () => {
    const id = teamMembershipSyncEntityId(TEAM, OWNER);
    expect(id).toBe(`${TEAM}:${OWNER}`);
    expect(decodeTeamMembership({ id, teamId: TEAM, membershipId: OWNER, createdAt: 1 }).id).toBe(
      id,
    );
  });

  it("keeps a role readable when it names a switch this build does not know", () => {
    const role = decodeRole({
      id: ROLE,
      name: "Manager",
      description: "",
      permissions: ["issues.read", "warpDrive.engage"],
      seeded: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(role.permissions).toEqual(["issues.read", "warpDrive.engage"]);
    expect(grantedCompanyPermissions(role.permissions)).toEqual(["issues.read"]);
  });

  it("tags the assignment scope rather than splitting it the way storage does", () => {
    expect(
      decodeRoleAssignment({
        id: "0191f0a0-0000-7000-8000-0000000000a1",
        membershipId: OWNER,
        roleId: ROLE,
        scope: { kind: "company" },
        createdAt: 1_000,
      }).scope.kind,
    ).toBe("company");
    const scoped = decodeRoleAssignment({
      id: "0191f0a0-0000-7000-8000-0000000000a1",
      membershipId: OWNER,
      roleId: ROLE,
      scope: { kind: "team", teamId: TEAM },
      createdAt: 1_000,
    });
    expect(scoped.scope.kind === "team" && scoped.scope.teamId).toBe(TEAM);
    // A team-scoped grant with no team is what the storage split would let through; the wire shape
    // cannot express it.
    expect(() =>
      decodeRoleAssignment({
        id: "0191f0a0-0000-7000-8000-0000000000a1",
        membershipId: OWNER,
        roleId: ROLE,
        scope: { kind: "team" },
        createdAt: 1_000,
      }),
    ).toThrow();
  });

  it("carries executable command arguments and durable terminal outcomes", () => {
    const command = decodeEnvironmentCommand({
      id: "command-1",
      targetEnvironmentId: "environment-1",
      cloudProjectId: null,
      bindingId: null,
      kind: "sendMessage",
      args: { kind: "sendMessage", threadId: "thread-1", message: "Continue" },
      issuedByMembershipId: OWNER,
      onBehalfOfActor: { kind: "member", membershipId: OWNER },
      state: "succeeded",
      claimedByEnvironmentId: "environment-1",
      claimGeneration: 1,
      claimExpiresAt: null,
      expiresAt: 10_000,
      result: { kind: "sendMessage", threadId: "thread-1", turnId: "turn-1" },
      error: null,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
    expect(command.args).toMatchObject({ kind: "sendMessage", message: "Continue" });
    expect(command.result).toMatchObject({ kind: "sendMessage", turnId: "turn-1" });
  });

  it("names no field that would carry company scope or secret material", () => {
    const fields = [
      SyncCompanyPayload,
      SyncCompanySettingsPayload,
      SyncMembershipPayload,
      SyncTeamPayload,
      SyncTeamMembershipPayload,
      SyncRolePayload,
      SyncRoleAssignmentPayload,
      SyncEnvironmentCommandPayload,
    ].flatMap((payload) => Object.keys(payload.fields));
    for (const forbidden of ["companyId", "version", "deletedAt", "tokenHash", "token"]) {
      expect(fields).not.toContain(forbidden);
    }
  });
});

describe("issue keys and presentation", () => {
  it("leases an inclusive block with its first key spelled out", () => {
    const block = decodeIssueKeyBlock({
      prefix: "PAT",
      blockStart: 100,
      blockEnd: 124,
      firstKey: "PAT-100",
    });
    expect(block.blockEnd - block.blockStart + 1).toBe(ISSUE_KEY_BLOCK_SIZE);
  });

  it("carries the six statuses the UI shows", () => {
    const presentation = decodePresentation({
      status: "blocked",
      pendingCount: 3,
      blockedCount: 1,
      rejectedCount: 0,
      reason: "Waiting on a create that was refused.",
    });
    expect(presentation.status).toBe("blocked");
  });
});

describe("IssueActor", () => {
  it("keeps the anonymous environment-scoped user valid", () => {
    expect(decodeActor({ kind: "user" }).kind).toBe("user");
  });

  it("accepts a member naming its membership", () => {
    const actor = decodeActor({ kind: "member", membershipId: "membership-1" });
    expect(actor.kind === "member" && actor.membershipId).toBe("membership-1");
  });

  it("lets a company assignee be a specific person", () => {
    const assignee = decodeAssignee({
      kind: "member",
      membershipId: "membership-1",
    });
    expect(assignee.kind).toBe("member");
  });

  it("still refuses a member with no membership", () => {
    expect(() => decodeActor({ kind: "member" })).toThrow();
  });
});
