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
  SyncListChangesResponse,
  SyncOperation,
  SyncOperationEnvelope,
  SyncPresentation,
  isSyncOperationKind,
  shouldReplenishIssueKeys,
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
