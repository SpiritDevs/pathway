import { describe, expect, it } from "vite-plus/test";

import {
  classifySyncStatusError,
  deriveCompanySyncStatus,
  type CompanySyncEngineState,
} from "./syncStatus.logic";

const state = (overrides: Partial<CompanySyncEngineState> = {}): CompanySyncEngineState => ({
  phase: "ready",
  bootstrapped: true,
  pending: [],
  rejected: [],
  quarantined: [],
  lastError: null,
  ...overrides,
});

describe("deriveCompanySyncStatus", () => {
  it("derives only phases represented by engine state", () => {
    expect(
      deriveCompanySyncStatus(state({ phase: "initializing", bootstrapped: false })).phase,
    ).toBe("bootstrapping");
    expect(deriveCompanySyncStatus(state({ phase: "syncing", bootstrapped: false })).phase).toBe(
      "bootstrapping",
    );
    expect(deriveCompanySyncStatus(state({ phase: "syncing" })).phase).toBe("live");
    expect(deriveCompanySyncStatus(state({ phase: "ready" })).phase).toBe("live");
    expect(deriveCompanySyncStatus(state({ phase: "disconnected" })).phase).toBe("reconnecting");
    expect(deriveCompanySyncStatus(state({ phase: "failed" })).phase).toBe("error");
  });

  it("counts pending kinds, blocked work, and recovery rows", () => {
    const status = deriveCompanySyncStatus(
      state({
        pending: [
          { operation: { kind: "issue.create" }, status: { _tag: "Pending" } },
          { operation: { kind: "issue.create" }, status: { _tag: "Blocked" } },
          { operation: { kind: "issue.update" }, status: { _tag: "Acknowledged" } },
        ],
        rejected: [{ rejected: true }],
        quarantined: [{ unreadable: true }, { unreadable: true }],
      }),
    );

    expect(status).toMatchObject({
      bootstrapComplete: true,
      pendingCount: 3,
      pendingKinds: [
        { kind: "issue.create", count: 2 },
        { kind: "issue.update", count: 1 },
      ],
      blockedCount: 1,
      rejectedCount: 1,
      quarantinedCount: 2,
    });
  });
});

describe("classifySyncStatusError", () => {
  it("keeps the classified transport message with a readable category", () => {
    expect(classifySyncStatusError({ reason: "offline", message: "Failed to fetch" })).toEqual({
      classification: "Offline",
      message: "Failed to fetch",
    });
    expect(
      classifySyncStatusError({ reason: "upgrade-required", message: "client too old" }),
    ).toEqual({ classification: "Update required", message: "client too old" });
  });

  it("uses a readable fallback when the transport supplied no message", () => {
    expect(classifySyncStatusError({ reason: "unauthorized", message: "   " })).toEqual({
      classification: "Sign-in required",
      message: "Pathway could not authorize cloud sync. Sign in again to continue.",
    });
  });
});
