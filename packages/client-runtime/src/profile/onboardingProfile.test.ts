import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_PROFILE_METADATA,
  isOnboardingComplete,
  mergeProfileMetadata,
  onboardingStepIndex,
  parseProfileMetadata,
  resolveOnboardingStep,
} from "./onboardingProfile.ts";

describe("parseProfileMetadata", () => {
  it("parses a fresh v1 shape", () => {
    expect(parseProfileMetadata({ v: 1 })).toEqual({ v: 1 });
  });

  it("parses a completed company profile", () => {
    const metadata = parseProfileMetadata({
      v: 1,
      accountKind: "company",
      company: { name: "Acme", size: "11-50", role: "founder" },
      onboardingCompletedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(metadata?.company?.name).toBe("Acme");
    expect(isOnboardingComplete(metadata)).toBe(true);
  });

  it("treats absent metadata as null", () => {
    expect(parseProfileMetadata(undefined)).toBeNull();
    expect(parseProfileMetadata({})).toBeNull();
  });

  it("treats an unknown future version as null, not an error", () => {
    expect(parseProfileMetadata({ v: 2, accountKind: "individual" })).toBeNull();
  });

  it("rejects malformed branch data", () => {
    expect(parseProfileMetadata({ v: 1, accountKind: "collective" })).toBeNull();
    expect(parseProfileMetadata({ v: 1, company: { size: "11-50" } })).toBeNull();
  });
});

describe("resolveOnboardingStep", () => {
  it("starts at identity while the user has no name", () => {
    expect(resolveOnboardingStep({ hasName: false, metadata: null })).toBe("identity");
    expect(
      resolveOnboardingStep({
        hasName: false,
        metadata: { v: 1, accountKind: "company" },
      }),
    ).toBe("identity");
  });

  it("asks for the account kind once a name exists", () => {
    expect(resolveOnboardingStep({ hasName: true, metadata: null })).toBe("account-kind");
    expect(resolveOnboardingStep({ hasName: true, metadata: EMPTY_PROFILE_METADATA })).toBe(
      "account-kind",
    );
  });

  it("resumes into the chosen branch", () => {
    expect(
      resolveOnboardingStep({ hasName: true, metadata: { v: 1, accountKind: "company" } }),
    ).toBe("company-details");
    expect(
      resolveOnboardingStep({ hasName: true, metadata: { v: 1, accountKind: "individual" } }),
    ).toBe("individual-details");
  });

  it("gives both branches the same step position", () => {
    expect(onboardingStepIndex("company-details")).toBe(onboardingStepIndex("individual-details"));
  });
});

describe("mergeProfileMetadata", () => {
  it("pins the version over a null base", () => {
    expect(mergeProfileMetadata(null, { accountKind: "individual" })).toEqual({
      v: 1,
      accountKind: "individual",
    });
  });

  it("preserves earlier answers when patching later steps", () => {
    const base = mergeProfileMetadata(null, { accountKind: "company" });
    const next = mergeProfileMetadata(base, {
      company: { name: "Acme" },
      onboardingCompletedAt: "2026-08-11T00:00:00.000Z",
    });
    expect(next.accountKind).toBe("company");
    expect(isOnboardingComplete(next)).toBe(true);
  });
});
