import { describe, expect, it } from "vite-plus/test";

import {
  branchStepForAccountKind,
  buildCompanyPatch,
  buildIndividualPatch,
  canContinueFromIdentity,
  isOnboardingBranchStep,
  onboardingPeekLayerCount,
  onboardingStepAnnouncement,
  previousOnboardingStep,
  resolveStepperArrowIntent,
  shouldIgnoreStepperKeyEvent,
  toggleProfileChip,
  toggleSingleChoice,
} from "./onboardingStepper.logic";

describe("onboardingStepAnnouncement", () => {
  it("numbers steps from one and names the card", () => {
    expect(onboardingStepAnnouncement("identity")).toBe("Step 1 of 3: Tell us about you");
    expect(onboardingStepAnnouncement("account-kind")).toBe(
      "Step 2 of 3: How will you use Pathway?",
    );
  });

  it("gives both branches the same position", () => {
    expect(onboardingStepAnnouncement("company-details")).toBe("Step 3 of 3: About your company");
    expect(onboardingStepAnnouncement("individual-details")).toBe("Step 3 of 3: About your setup");
  });
});

describe("branchStepForAccountKind", () => {
  it("routes each account kind to its branch", () => {
    expect(branchStepForAccountKind("company")).toBe("company-details");
    expect(branchStepForAccountKind("individual")).toBe("individual-details");
  });
});

describe("isOnboardingBranchStep", () => {
  it("only treats the two branch cards as branches", () => {
    expect(isOnboardingBranchStep("identity")).toBe(false);
    expect(isOnboardingBranchStep("account-kind")).toBe(false);
    expect(isOnboardingBranchStep("company-details")).toBe(true);
    expect(isOnboardingBranchStep("individual-details")).toBe(true);
  });
});

describe("previousOnboardingStep", () => {
  it("has no card before identity", () => {
    expect(previousOnboardingStep("identity")).toBe(null);
  });

  it("walks back one card", () => {
    expect(previousOnboardingStep("account-kind")).toBe("identity");
  });

  it("collapses both branches back to the account-kind choice", () => {
    expect(previousOnboardingStep("company-details")).toBe("account-kind");
    expect(previousOnboardingStep("individual-details")).toBe("account-kind");
  });
});

describe("onboardingPeekLayerCount", () => {
  it("shows two peek layers on the first card", () => {
    expect(onboardingPeekLayerCount("identity")).toBe(2);
  });

  it("drops to one on the middle card", () => {
    expect(onboardingPeekLayerCount("account-kind")).toBe(1);
  });

  it("shows none on the last card of either branch", () => {
    expect(onboardingPeekLayerCount("company-details")).toBe(0);
    expect(onboardingPeekLayerCount("individual-details")).toBe(0);
  });
});

describe("canContinueFromIdentity", () => {
  it("requires a non-blank first name", () => {
    expect(canContinueFromIdentity("")).toBe(false);
    expect(canContinueFromIdentity("   ")).toBe(false);
    expect(canContinueFromIdentity(" Ada ")).toBe(true);
  });
});

describe("toggleProfileChip", () => {
  it("appends an unselected value", () => {
    expect(toggleProfileChip(["codex"], "cursor")).toEqual(["codex", "cursor"]);
  });

  it("removes a selected value", () => {
    expect(toggleProfileChip(["codex", "cursor"], "codex")).toEqual(["cursor"]);
  });

  it("preserves selection order and does not mutate the input", () => {
    const values = ["codex", "claude"] as const;
    const next = toggleProfileChip(values, "grok");
    expect(next).toEqual(["codex", "claude", "grok"]);
    expect(values).toEqual(["codex", "claude"]);
  });

  it("empties out when the last value is toggled off", () => {
    expect(toggleProfileChip(["codex"], "codex")).toEqual([]);
  });
});

describe("toggleSingleChoice", () => {
  it("selects when nothing is selected", () => {
    expect(toggleSingleChoice(null, "search")).toBe("search");
  });

  it("replaces a different selection", () => {
    expect(toggleSingleChoice("search", "youtube")).toBe("youtube");
  });

  it("deselects when the current value is pressed again", () => {
    expect(toggleSingleChoice("search", "search")).toBe(null);
  });
});

describe("resolveStepperArrowIntent", () => {
  it("ignores every key while a write is in flight", () => {
    expect(
      resolveStepperArrowIntent({
        key: "ArrowLeft",
        step: "account-kind",
        canAdvance: true,
        isPending: true,
      }),
    ).toBe(null);
  });

  it("ignores keys that are not arrows", () => {
    expect(
      resolveStepperArrowIntent({
        key: "Enter",
        step: "account-kind",
        canAdvance: true,
        isPending: false,
      }),
    ).toBe(null);
  });

  it("goes back from any card that has a predecessor", () => {
    expect(
      resolveStepperArrowIntent({
        key: "ArrowLeft",
        step: "company-details",
        canAdvance: false,
        isPending: false,
      }),
    ).toBe("back");
  });

  it("refuses to go back off the first card", () => {
    expect(
      resolveStepperArrowIntent({
        key: "ArrowLeft",
        step: "identity",
        canAdvance: true,
        isPending: false,
      }),
    ).toBe(null);
  });

  it("advances only when the active card's own gate is satisfied", () => {
    expect(
      resolveStepperArrowIntent({
        key: "ArrowRight",
        step: "identity",
        canAdvance: true,
        isPending: false,
      }),
    ).toBe("advance");
    expect(
      resolveStepperArrowIntent({
        key: "ArrowRight",
        step: "identity",
        canAdvance: false,
        isPending: false,
      }),
    ).toBe(null);
  });

  it("never completes onboarding from a branch card", () => {
    expect(
      resolveStepperArrowIntent({
        key: "ArrowRight",
        step: "company-details",
        canAdvance: true,
        isPending: false,
      }),
    ).toBe(null);
    expect(
      resolveStepperArrowIntent({
        key: "ArrowRight",
        step: "individual-details",
        canAdvance: true,
        isPending: false,
      }),
    ).toBe(null);
  });
});

describe("shouldIgnoreStepperKeyEvent", () => {
  it("leaves arrow keys to text entry targets", () => {
    expect(shouldIgnoreStepperKeyEvent({ tagName: "INPUT", isContentEditable: false })).toBe(true);
    expect(shouldIgnoreStepperKeyEvent({ tagName: "textarea", isContentEditable: false })).toBe(
      true,
    );
    expect(shouldIgnoreStepperKeyEvent({ tagName: "SELECT", isContentEditable: false })).toBe(true);
    expect(shouldIgnoreStepperKeyEvent({ tagName: "DIV", isContentEditable: true })).toBe(true);
  });

  it("claims arrow keys everywhere else", () => {
    expect(shouldIgnoreStepperKeyEvent({ tagName: "BODY", isContentEditable: false })).toBe(false);
    expect(shouldIgnoreStepperKeyEvent({ tagName: "BUTTON", isContentEditable: false })).toBe(
      false,
    );
  });
});

describe("buildCompanyPatch", () => {
  it("writes nothing when the whole branch was skipped", () => {
    expect(
      buildCompanyPatch({
        name: "   ",
        size: null,
        role: null,
        referralSource: null,
        referralDetail: "",
      }),
    ).toBe(null);
  });

  it("trims the name and omits unanswered keys", () => {
    expect(
      buildCompanyPatch({
        name: "  Acme  ",
        size: null,
        role: null,
        referralSource: null,
        referralDetail: "",
      }),
    ).toEqual({ name: "Acme" });
  });

  it("keeps every answered field", () => {
    expect(
      buildCompanyPatch({
        name: "Acme",
        size: "11-50",
        role: "founder",
        referralSource: "other",
        referralDetail: "  A conference  ",
      }),
    ).toEqual({
      name: "Acme",
      size: "11-50",
      role: "founder",
      referralSource: "other",
      referralDetail: "A conference",
    });
  });

  it("still records answers when only the name was skipped", () => {
    expect(
      buildCompanyPatch({
        name: "",
        size: "1000+",
        role: null,
        referralSource: null,
        referralDetail: "",
      }),
    ).toEqual({ name: "", size: "1000+" });
  });

  it("drops referral detail unless Other is selected", () => {
    expect(
      buildCompanyPatch({
        name: "Acme",
        size: null,
        role: null,
        referralSource: "search",
        referralDetail: "stale answer",
      }),
    ).toEqual({ name: "Acme", referralSource: "search" });
  });
});

describe("buildIndividualPatch", () => {
  it("writes nothing when the whole branch was skipped", () => {
    expect(buildIndividualPatch({ providers: [], referralSource: null, referralDetail: "" })).toBe(
      null,
    );
  });

  it("keeps providers alone", () => {
    expect(
      buildIndividualPatch({
        providers: ["codex", "claude"],
        referralSource: null,
        referralDetail: "",
      }),
    ).toEqual({ providers: ["codex", "claude"] });
  });

  it("keeps a referral source without its detail", () => {
    expect(
      buildIndividualPatch({ providers: [], referralSource: "youtube", referralDetail: "  " }),
    ).toEqual({ referralSource: "youtube" });
  });

  it("keeps the trimmed detail only under the other source", () => {
    expect(
      buildIndividualPatch({
        providers: [],
        referralSource: "other",
        referralDetail: "  a conference  ",
      }),
    ).toEqual({ referralSource: "other", referralDetail: "a conference" });
  });

  it("drops a stale detail when the source moved away from other", () => {
    expect(
      buildIndividualPatch({
        providers: ["grok"],
        referralSource: "search",
        referralDetail: "a conference",
      }),
    ).toEqual({ providers: ["grok"], referralSource: "search" });
  });

  it("ignores a blank detail under the other source", () => {
    expect(
      buildIndividualPatch({ providers: [], referralSource: "other", referralDetail: "" }),
    ).toEqual({ referralSource: "other" });
  });
});
