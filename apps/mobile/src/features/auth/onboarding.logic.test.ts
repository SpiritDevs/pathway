import { resolveOnboardingStep } from "@t3tools/client-runtime/profile";
import { describe, expect, it } from "vite-plus/test";

import {
  avatarDataUrl,
  buildCompanyProfile,
  buildIdentityUpdate,
  buildIndividualProfile,
  canContinueIdentity,
  onboardingProgressLabel,
  resolveNextOnboardingStep,
  resolvePreviousOnboardingStep,
  toggleProviderSelection,
} from "./onboarding.logic";

describe("resolveNextOnboardingStep", () => {
  it("walks identity to the account-kind choice", () => {
    expect(resolveNextOnboardingStep("identity", undefined)).toEqual("account-kind");
  });

  it("branches on the account kind that was just written", () => {
    expect(resolveNextOnboardingStep("account-kind", "company")).toEqual("company-details");
    expect(resolveNextOnboardingStep("account-kind", "individual")).toEqual("individual-details");
  });

  it("ends the flow after either branch", () => {
    expect(resolveNextOnboardingStep("company-details", "company")).toEqual(null);
    expect(resolveNextOnboardingStep("individual-details", "individual")).toEqual(null);
  });
});

describe("resolvePreviousOnboardingStep", () => {
  it("has nowhere to go from the first step", () => {
    expect(resolvePreviousOnboardingStep("identity")).toEqual(null);
  });

  it("walks back through the graph", () => {
    expect(resolvePreviousOnboardingStep("account-kind")).toEqual("identity");
    expect(resolvePreviousOnboardingStep("company-details")).toEqual("account-kind");
    expect(resolvePreviousOnboardingStep("individual-details")).toEqual("account-kind");
  });

  it("round-trips with the shared resume resolver", () => {
    const resumed = resolveOnboardingStep({
      hasName: true,
      metadata: { v: 1, accountKind: "company" },
    });
    expect(resumed).toEqual("company-details");
    expect(resolvePreviousOnboardingStep(resumed)).toEqual("account-kind");
  });
});

describe("onboardingProgressLabel", () => {
  it("numbers both branch steps identically", () => {
    expect(onboardingProgressLabel("identity")).toEqual("Step 1 of 3");
    expect(onboardingProgressLabel("account-kind")).toEqual("Step 2 of 3");
    expect(onboardingProgressLabel("company-details")).toEqual("Step 3 of 3");
    expect(onboardingProgressLabel("individual-details")).toEqual("Step 3 of 3");
  });
});

describe("identity step", () => {
  it("requires a non-blank first name", () => {
    expect(canContinueIdentity("")).toEqual(false);
    expect(canContinueIdentity("   ")).toEqual(false);
    expect(canContinueIdentity(" Ada ")).toEqual(true);
  });

  it("trims and always sends both name fields", () => {
    expect(buildIdentityUpdate({ firstName: " Ada ", lastName: "  " })).toEqual({
      firstName: "Ada",
      lastName: "",
    });
  });

  it("wraps picker base64 as a JPEG data URL", () => {
    expect(avatarDataUrl("QUJD")).toEqual("data:image/jpeg;base64,QUJD");
  });
});

describe("toggleProviderSelection", () => {
  it("adds and removes without reordering the rest", () => {
    expect(toggleProviderSelection([], "codex")).toEqual(["codex"]);
    expect(toggleProviderSelection(["codex", "claude"], "cursor")).toEqual([
      "codex",
      "claude",
      "cursor",
    ]);
    expect(toggleProviderSelection(["codex", "claude", "cursor"], "claude")).toEqual([
      "codex",
      "cursor",
    ]);
  });
});

describe("buildCompanyProfile", () => {
  it("collapses a fully skipped step to undefined", () => {
    expect(buildCompanyProfile({ name: "  ", size: null, role: null })).toEqual(undefined);
  });

  it("omits unanswered optional keys", () => {
    expect(buildCompanyProfile({ name: " Acme ", size: null, role: null })).toEqual({
      name: "Acme",
    });
  });

  it("keeps every answered key", () => {
    expect(buildCompanyProfile({ name: "Acme", size: "11-50", role: "engineer" })).toEqual({
      name: "Acme",
      size: "11-50",
      role: "engineer",
    });
  });

  it("keeps a size answered without a name", () => {
    expect(buildCompanyProfile({ name: "", size: "1000+", role: null })).toEqual({
      name: "",
      size: "1000+",
    });
  });
});

describe("buildIndividualProfile", () => {
  it("collapses a fully skipped step to undefined", () => {
    expect(
      buildIndividualProfile({ providers: [], referralSource: null, referralDetail: "  " }),
    ).toEqual(undefined);
  });

  it("drops the detail box unless the source is other", () => {
    expect(
      buildIndividualProfile({
        providers: ["codex"],
        referralSource: "youtube",
        referralDetail: "a stray note",
      }),
    ).toEqual({ providers: ["codex"], referralSource: "youtube" });
  });

  it("keeps the detail box under other", () => {
    expect(
      buildIndividualProfile({
        providers: [],
        referralSource: "other",
        referralDetail: " a conference ",
      }),
    ).toEqual({ referralSource: "other", referralDetail: "a conference" });
  });

  it("treats a stray detail with no source as skipped", () => {
    expect(
      buildIndividualProfile({ providers: [], referralSource: null, referralDetail: "typed" }),
    ).toEqual(undefined);
  });
});
