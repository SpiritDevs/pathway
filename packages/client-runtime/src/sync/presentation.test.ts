import { describe, expect, it } from "@effect/vitest";
import {
  CompanyVersion,
  LocalSequence,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  SYNC_PROTOCOL_VERSION,
} from "@t3tools/contracts/cloudSync";
import { CompanyId } from "@t3tools/contracts/company";

import type { PendingSyncOperation, PendingSyncStatus } from "./model.ts";
import { presentSyncState, syncStatusText } from "./presentation.ts";
import { SyncTransportError } from "./transport.ts";

const pendingOperation = (
  id: string,
  status: PendingSyncStatus,
): PendingSyncOperation<unknown> => ({
  operation: {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    operationId: SyncOperationId.make(id),
    companyId: CompanyId.make("company"),
    clientId: SyncClientId.make("client"),
    localSequence: LocalSequence.make(1),
    baseVersion: CompanyVersion.make(0),
    kind: "issue.update",
    entityId: SyncEntityId.make("note-a"),
    dependsOn: [],
    operation: null,
  },
  status,
});

const offlineError = new SyncTransportError({ reason: "offline", message: "No connection." });

describe("presentSyncState", () => {
  it("reports live only once nothing is pending", () => {
    expect(
      presentSyncState({ phase: "ready", pending: [], rejectedCount: 0, error: null }),
    ).toEqual({
      status: "live",
      pendingCount: 0,
      blockedCount: 0,
      rejectedCount: 0,
      reason: null,
    });
  });

  it("shows initializing before any state exists, even with work queued", () => {
    const presentation = presentSyncState({
      phase: "initializing",
      pending: [pendingOperation("op-1", { _tag: "Pending" })],
      rejectedCount: 2,
      error: offlineError,
    });

    expect(presentation.status).toBe("initializing");
    expect(presentation.pendingCount).toBe(1);
    expect(presentation.rejectedCount).toBe(2);
  });

  it("prefers the actionable blocked reason over the offline spinner", () => {
    const presentation = presentSyncState({
      phase: "ready",
      pending: [
        pendingOperation("op-1", { _tag: "Pending" }),
        pendingOperation("op-2", { _tag: "Blocked", reason: "The note was deleted." }),
      ],
      rejectedCount: 1,
      error: null,
    });

    expect(presentation.status).toBe("blocked");
    expect(presentation.blockedCount).toBe(1);
    expect(presentation.reason).toBe("The note was deleted.");
    expect(syncStatusText(presentation)).toBe("The note was deleted.");
  });

  it("keeps a disconnected engine offline while its work waits", () => {
    const presentation = presentSyncState({
      phase: "disconnected",
      pending: [pendingOperation("op-1", { _tag: "Pending" })],
      rejectedCount: 0,
      error: offlineError,
    });

    expect(presentation.status).toBe("offline");
    expect(presentation.reason).toBe("No connection.");
    expect(syncStatusText(presentation)).toBe("Offline. 1 change waiting to sync");
  });

  it("reports an unauthorized answer as an error, not as offline", () => {
    const presentation = presentSyncState({
      phase: "failed",
      pending: [],
      rejectedCount: 0,
      error: new SyncTransportError({
        reason: "unauthorized",
        message: "You no longer have access to this company.",
      }),
    });

    expect(presentation.status).toBe("error");
    expect(syncStatusText(presentation)).toBe("You no longer have access to this company.");
  });

  it("counts acknowledged work as still syncing until the feed confirms it", () => {
    const presentation = presentSyncState({
      phase: "ready",
      pending: [
        pendingOperation("op-1", { _tag: "Acknowledged", version: CompanyVersion.make(7) }),
      ],
      rejectedCount: 0,
      error: null,
    });

    expect(presentation.status).toBe("syncing");
    expect(syncStatusText(presentation)).toBe("Syncing 1 change...");
  });
});
