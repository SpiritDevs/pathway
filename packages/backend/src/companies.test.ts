import { describe, expect, it } from "vite-plus/test";

import {
  clampOfflineAccessDays,
  COMPANY_DELETION_RECOVERY_MS,
  companyPurgeAfter,
  defaultIssueKeyPrefix,
  isCompanyPurgeDue,
  normalizeIssueKeyPrefix,
  offlineGrantExpiresAt,
  OFFLINE_ACCESS_DEFAULT_DAYS,
} from "./companies.ts";

describe("clampOfflineAccessDays", () => {
  it("holds the setting between zero and ninety days", () => {
    expect(clampOfflineAccessDays(30)).toBe(30);
    expect(clampOfflineAccessDays(-5)).toBe(0);
    expect(clampOfflineAccessDays(400)).toBe(90);
    expect(clampOfflineAccessDays(Number.NaN)).toBe(OFFLINE_ACCESS_DEFAULT_DAYS);
  });
});

describe("offlineGrantExpiresAt", () => {
  it("issues no grant at all when offline access is disabled", () => {
    expect(offlineGrantExpiresAt(1_000, 0)).toBeNull();
  });

  it("dates the grant from the successful authorization", () => {
    expect(offlineGrantExpiresAt(1_000, 1)).toBe(1_000 + 24 * 60 * 60 * 1000);
  });
});

describe("deletion recovery", () => {
  it("stays restorable for thirty days", () => {
    const scheduledAt = 5_000;
    const purgeAfter = companyPurgeAfter(scheduledAt);

    expect(purgeAfter).toBe(scheduledAt + COMPANY_DELETION_RECOVERY_MS);
    expect(COMPANY_DELETION_RECOVERY_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(isCompanyPurgeDue(purgeAfter, purgeAfter - 1)).toBe(false);
    expect(isCompanyPurgeDue(purgeAfter, purgeAfter)).toBe(true);
  });
});

describe("issue key prefixes", () => {
  it("derives a prefix from the company name", () => {
    expect(defaultIssueKeyPrefix("Acme Robotics")).toBe("ACM");
    expect(defaultIssueKeyPrefix("42")).toBe("PW");
  });

  it("normalizes a hand-entered prefix", () => {
    expect(normalizeIssueKeyPrefix(" pw-core ")).toBe("PWCORE");
    expect(normalizeIssueKeyPrefix("abcdefghijk")).toBe("ABCDEFGH");
  });
});
