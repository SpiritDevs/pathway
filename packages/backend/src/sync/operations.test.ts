import { describe, expect, it } from "vite-plus/test";

import {
  acceptedVersionRange,
  assignVersions,
  measureBatchArgsBytes,
  partitionByExistingReceipts,
  replayStoredReceipt,
  SYNC_MAX_ID_CHARS,
  validateOperationBatch,
  type SyncOperationEnvelope,
} from "./operations.ts";
import { SYNC_MAX_OPERATIONS_PER_BATCH, SYNC_PROTOCOL_VERSION } from "./protocol.ts";

const COMPANY = "company-1";

function operation(overrides: Partial<SyncOperationEnvelope> = {}): SyncOperationEnvelope {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: "op-1",
    companyId: COMPANY,
    clientId: "client-1",
    environmentId: null,
    actor: { kind: "member", membershipId: "membership-1" },
    localSequence: 1,
    baseVersion: 0,
    kind: "issue.update",
    entityId: "issue-1",
    args: { title: "Ship it" },
    dependsOn: [],
    ...overrides,
  };
}

describe("validateOperationBatch", () => {
  it("accepts a well-formed batch", () => {
    expect(validateOperationBatch([operation()], COMPANY)).toEqual({ ok: true });
  });

  it("rejects an empty batch", () => {
    const result = validateOperationBatch([], COMPANY);
    expect(result).toMatchObject({ ok: false, code: "batch-empty" });
  });

  it("rejects more than the batch ceiling", () => {
    const operations = Array.from({ length: SYNC_MAX_OPERATIONS_PER_BATCH + 1 }, (_, index) =>
      operation({ operationId: `op-${index}` }),
    );
    expect(validateOperationBatch(operations, COMPANY)).toMatchObject({
      ok: false,
      code: "batch-too-large",
    });
  });

  it("rejects arguments past the byte ceiling", () => {
    const huge = operation({ args: { description: "x".repeat(600_000) } });
    expect(validateOperationBatch([huge], COMPANY)).toMatchObject({
      ok: false,
      code: "batch-args-too-large",
    });
  });

  it("rejects an operation id repeated inside one batch", () => {
    expect(validateOperationBatch([operation(), operation()], COMPANY)).toMatchObject({
      ok: false,
      code: "batch-duplicate-operation-id",
    });
  });

  it("rejects an operation aimed at another company", () => {
    expect(validateOperationBatch([operation({ companyId: "company-2" })], COMPANY)).toMatchObject({
      ok: false,
      code: "company-mismatch",
    });
  });

  it("tells a client from the future to upgrade", () => {
    expect(
      validateOperationBatch([operation({ protocolVersion: SYNC_PROTOCOL_VERSION + 1 })], COMPANY),
    ).toMatchObject({ ok: false, code: "upgrade-required" });
  });

  // The contract brands both ids as trimmed non-empty strings and Convex's `v.string()` cannot say
  // so. An empty entity id is the damaging one: the row it writes sorts below every bootstrap page,
  // which pages ascending from an exclusive `""`, so a fresh device would never be seeded with it.
  it.each([
    ["an empty entity id", { entityId: "" }],
    ["a padded entity id", { entityId: " issue-1 " }],
    ["an entity id past the character ceiling", { entityId: "x".repeat(SYNC_MAX_ID_CHARS + 1) }],
    ["an empty operation id", { operationId: "" }],
    ["a padded operation id", { operationId: "op-1\n" }],
    ["an operation id past the character ceiling", { operationId: "o".repeat(129) }],
  ])("refuses the whole batch for %s", (_label, overrides) => {
    expect(validateOperationBatch([operation(overrides)], COMPANY)).toMatchObject({
      ok: false,
      code: "invalid-arguments",
    });
  });

  it("accepts ids sitting exactly on the ceiling", () => {
    const edge = operation({
      operationId: "o".repeat(SYNC_MAX_ID_CHARS),
      entityId: "e".repeat(SYNC_MAX_ID_CHARS),
    });
    expect(validateOperationBatch([edge], COMPANY)).toEqual({ ok: true });
  });
});

describe("measureBatchArgsBytes", () => {
  it("counts encoded bytes rather than characters", () => {
    expect(measureBatchArgsBytes([operation({ args: "é" })])).toBe(4);
  });
});

describe("partitionByExistingReceipts", () => {
  it("splits already-applied operations from fresh ones, preserving order", () => {
    const operations = [
      operation({ operationId: "op-1" }),
      operation({ operationId: "op-2" }),
      operation({ operationId: "op-3" }),
    ];

    const partition = partitionByExistingReceipts(operations, new Set(["op-2"]));

    expect(partition.duplicates.map((op) => op.operationId)).toEqual(["op-2"]);
    expect(partition.fresh.map((op) => op.operationId)).toEqual(["op-1", "op-3"]);
  });

  it("applies a wholly-resubmitted batch exactly zero further times", () => {
    const operations = [operation({ operationId: "op-1" }), operation({ operationId: "op-2" })];
    const partition = partitionByExistingReceipts(operations, new Set(["op-1", "op-2"]));

    expect(partition.fresh).toEqual([]);
    expect(assignVersions(7, partition.fresh.length).nextHead).toBe(7);
  });
});

describe("assignVersions", () => {
  it("assigns a contiguous run starting one past the head", () => {
    const assignment = assignVersions(10, 3);

    expect(assignment.versions).toEqual([11, 12, 13]);
    expect(assignment.firstVersion).toBe(11);
    expect(assignment.lastVersion).toBe(13);
    expect(assignment.nextHead).toBe(13);
  });

  it("leaves the head alone when nothing changed", () => {
    const assignment = assignVersions(10, 0);

    expect(assignment.versions).toEqual([]);
    expect(assignment.firstVersion).toBe(10);
    expect(assignment.lastVersion).toBe(10);
    expect(assignment.nextHead).toBe(10);
  });

  it("never skips a version across consecutive batches", () => {
    const first = assignVersions(0, 2);
    const second = assignVersions(first.nextHead, 2);

    expect([...first.versions, ...second.versions]).toEqual([1, 2, 3, 4]);
  });
});

describe("acceptedVersionRange", () => {
  it("covers accepted and duplicate receipts and ignores rejections", () => {
    const range = acceptedVersionRange(5, [
      {
        operationId: "op-1",
        status: "accepted",
        duplicate: false,
        firstVersion: 6,
        lastVersion: 7,
      },
      {
        operationId: "op-2",
        status: "rejected",
        duplicate: false,
        code: "permission-denied",
        message: "no",
      },
      { operationId: "op-3", status: "accepted", duplicate: true, firstVersion: 3, lastVersion: 3 },
    ]);

    expect(range).toEqual({ from: 5, to: 7 });
  });

  it("reports the unchanged head when every operation was rejected", () => {
    const range = acceptedVersionRange(5, [
      {
        operationId: "op-1",
        status: "rejected",
        duplicate: false,
        code: "unknown-operation",
        message: "no",
      },
    ]);

    expect(range).toEqual({ from: 5, to: 5 });
  });

  it("ignores a replayed rejection, which produced no versions the first time either", () => {
    const range = acceptedVersionRange(5, [
      {
        operationId: "op-1",
        status: "rejected",
        duplicate: true,
        code: "entity-deleted",
        message: "gone",
      },
    ]);

    expect(range).toEqual({ from: 5, to: 5 });
  });
});

describe("replayStoredReceipt", () => {
  it("replays a stored rejection as a rejection, keeping its code and message", () => {
    const receipt = replayStoredReceipt({
      operationId: "op-1",
      headVersion: 12,
      stored: {
        status: "rejected",
        firstVersion: null,
        lastVersion: null,
        rejectionCode: "entity-deleted",
        rejectionMessage: "Issue PAT-9 was deleted.",
      },
    });

    expect(receipt).toEqual({
      operationId: "op-1",
      status: "rejected",
      duplicate: true,
      code: "entity-deleted",
      message: "Issue PAT-9 was deleted.",
    });
  });

  it("keeps an unrecognized stored code refused rather than turning it into a success", () => {
    const receipt = replayStoredReceipt({
      operationId: "op-1",
      headVersion: 12,
      stored: {
        status: "rejected",
        firstVersion: null,
        lastVersion: null,
        rejectionCode: "code-from-a-newer-deployment",
        rejectionMessage: "Refused.",
      },
    });

    expect(receipt.status).toBe("rejected");
    expect(receipt).toMatchObject({ duplicate: true, message: "Refused." });
  });

  it("replays a stored acceptance with the versions it produced", () => {
    const receipt = replayStoredReceipt({
      operationId: "op-2",
      headVersion: 12,
      stored: {
        status: "accepted",
        firstVersion: 4,
        lastVersion: 6,
        rejectionCode: null,
        rejectionMessage: null,
      },
    });

    expect(receipt).toEqual({
      operationId: "op-2",
      status: "accepted",
      duplicate: true,
      firstVersion: 4,
      lastVersion: 6,
    });
  });

  it("falls back to the current head for an acceptance that wrote no changes", () => {
    const receipt = replayStoredReceipt({
      operationId: "op-3",
      headVersion: 12,
      stored: {
        status: "accepted",
        firstVersion: null,
        lastVersion: null,
        rejectionCode: null,
        rejectionMessage: null,
      },
    });

    expect(receipt).toMatchObject({ firstVersion: 12, lastVersion: 12 });
  });
});
