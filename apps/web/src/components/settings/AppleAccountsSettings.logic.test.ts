import type { AppleEnvironmentHealth } from "@spiritdevs/contracts/apple";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vite-plus/test";

import {
  APPLE_CONFLICT_MESSAGE,
  completeProjectLinkPicker,
  describeAppleError,
  EMPTY_PROJECT_LINK_PICKER,
  environmentHealthRows,
  environmentKeyState,
  keyDraftProblem,
  keySummary,
  normalizeTeamId,
  pickProjectLinkAccount,
  pickProjectLinkApp,
  pickProjectLinkTeam,
} from "./AppleAccountsSettings.logic";

const NOW = 1_800_000_000_000;

function health(overrides: Partial<AppleEnvironmentHealth> = {}): AppleEnvironmentHealth {
  return {
    environmentId: "env-a",
    leaseExpiresAt: NOW + 10_000,
    connected: true,
    revision: 1,
    lastVerifiedAt: NOW - 5_000,
    error: null,
    ...overrides,
  } as AppleEnvironmentHealth;
}

describe("environmentKeyState", () => {
  it("treats a live lease as connected", () => {
    expect(environmentKeyState(health(), NOW)).toBe("connected");
  });

  it("treats a passed lease as not connected even when the row says connected", () => {
    expect(environmentKeyState(health({ leaseExpiresAt: NOW - 1 }), NOW)).toBe("lease-expired");
    expect(environmentKeyState(health({ leaseExpiresAt: null }), NOW)).toBe("lease-expired");
  });

  it("reports environments without a current lease as disconnected", () => {
    expect(environmentKeyState(health({ connected: false }), NOW)).toBe("disconnected");
  });
});

describe("environmentHealthRows", () => {
  it("labels known environments, falls back for unknown ones and keeps the last error", () => {
    const rows = environmentHealthRows(
      [
        health({ environmentId: "env-b-unknown-id" }),
        health({
          environmentId: "env-a",
          error: { code: "unauthorized", message: "Rejected", retryAfterSeconds: null },
        }),
      ],
      NOW,
      (id) => (id === "env-a" ? "MacBook" : undefined),
    );
    expect(rows.map((row) => [row.label, row.state, row.error])).toEqual([
      ["Environment env-b-un", "connected", null],
      ["MacBook", "connected", "Rejected"],
    ]);
  });
});

describe("describeAppleError", () => {
  it("maps App Store Connect codes from cloud and environment errors", () => {
    expect(
      describeAppleError(new ConvexError({ code: "unauthorized", message: "raw" }), {
        fallback: "x",
      }).message,
    ).toMatch(/rejected this key/);
    expect(
      describeAppleError(
        { _tag: "AppleError", code: "rate-limited", message: "raw", retryAfterSeconds: 12.2 },
        { fallback: "x" },
      ).message,
    ).toMatch(/in 13 seconds/);
  });

  it("uses the stale-revision message only when the caller asks for it", () => {
    const conflict = new ConvexError({
      code: "entity-conflict",
      message: "Unlink projects before changing this Apple account's scope.",
    });
    expect(
      describeAppleError(conflict, { fallback: "x", conflictMessage: APPLE_CONFLICT_MESSAGE }),
    ).toEqual({ code: "entity-conflict", message: APPLE_CONFLICT_MESSAGE });
    expect(describeAppleError(conflict, { fallback: "x" }).message).toMatch(/^Unlink projects/);
  });

  it("keeps server messages for other codes and falls back for unknown errors", () => {
    expect(
      describeAppleError(new ConvexError({ code: "permission-denied", message: "Nope." }), {
        fallback: "x",
      }).message,
    ).toBe("Nope.");
    expect(describeAppleError("boom", { fallback: "Fallback." })).toEqual({
      code: null,
      message: "Fallback.",
    });
  });
});

describe("key and team input", () => {
  it("normalizes team IDs", () => {
    expect(normalizeTeamId(" abcde12345 ")).toBe("ABCDE12345");
  });

  it("requires a PEM private key", () => {
    const draft = { issuerId: "issuer", keyId: "KEY", privateKey: "nope" };
    expect(keyDraftProblem(draft)).toMatch(/\.p8/);
    expect(
      keyDraftProblem({
        ...draft,
        privateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n",
      }),
    ).toBeNull();
    expect(keyDraftProblem({ ...draft, issuerId: " " })).toMatch(/issuer/);
  });

  it("summarizes only the public key suffix", () => {
    const integration = {
      accountId: "a",
      teamId: "T",
      accountRevision: 0,
      connected: true,
      revision: 1,
      issuerId: "i",
      keyIdSuffix: "ABCD",
      lastVerifiedAt: null,
    } as Parameters<typeof keySummary>[0];
    expect(keySummary(integration)).toBe("Key …ABCD");
    expect(keySummary({ ...integration, connected: false })).toBe("No API key connected");
  });
});

describe("project link picker", () => {
  it("clears dependent choices when a parent changes", () => {
    let state = pickProjectLinkAccount(EMPTY_PROJECT_LINK_PICKER, "acct");
    state = pickProjectLinkTeam(state, "TEAM");
    state = pickProjectLinkApp(state, "app");
    expect(completeProjectLinkPicker(state)).toEqual({
      accountId: "acct",
      teamId: "TEAM",
      appId: "app",
    });
    expect(pickProjectLinkTeam(state, "OTHER")).toEqual({
      accountId: "acct",
      teamId: "OTHER",
      appId: null,
    });
    expect(pickProjectLinkAccount(state, "other")).toEqual({
      accountId: "other",
      teamId: null,
      appId: null,
    });
    expect(pickProjectLinkAccount(state, "acct")).toBe(state);
    expect(completeProjectLinkPicker(pickProjectLinkTeam(state, "OTHER"))).toBeNull();
  });
});
