import {
  ONBOARDING_TOTAL_STEPS,
  onboardingStepIndex,
  type AccountKind,
  type CompanyProfile,
  type CompanyRole,
  type CompanySize,
  type IndividualProfile,
  type OnboardingStep,
  type ProviderUsage,
  type ReferralSource,
} from "@spiritdevs/client-runtime/profile";

/**
 * Pure navigation, selection, and patch-shaping rules behind the onboarding
 * card stack. The stepper component owns Clerk writes and React state; every
 * decision it makes lives here so it can be tested without a browser or a
 * signed-in user.
 */

/** Copy for the card header and for the screen-reader step announcement. */
export const ONBOARDING_STEP_TITLES: Record<OnboardingStep, string> = {
  identity: "Tell us about you",
  "account-kind": "How will you use Pathway?",
  "company-details": "About your company",
  "individual-details": "About your setup",
};

export const ONBOARDING_STEP_DESCRIPTIONS: Record<OnboardingStep, string> = {
  identity: "Your name is the only thing we need. An avatar is optional.",
  "account-kind": "This decides which few questions we ask next. Nothing is locked in.",
  "company-details": "Helps us shape team features. Skip anything you would rather not answer.",
  "individual-details":
    "Helps us set up your first run. Skip anything you would rather not answer.",
};

/** "Step 2 of 3: How will you use Pathway?" — read out by the live region. */
export function onboardingStepAnnouncement(step: OnboardingStep): string {
  const position = onboardingStepIndex(step) + 1;
  return `Step ${position} of ${ONBOARDING_TOTAL_STEPS}: ${ONBOARDING_STEP_TITLES[step]}`;
}

export function isOnboardingBranchStep(step: OnboardingStep): boolean {
  return step === "company-details" || step === "individual-details";
}

/** The branch a chosen account kind leads to. */
export function branchStepForAccountKind(accountKind: AccountKind): OnboardingStep {
  return accountKind === "company" ? "company-details" : "individual-details";
}

/**
 * Back always returns to the previous card, and both branches collapse back to
 * the account-kind choice. `null` means "this is the first card".
 */
export function previousOnboardingStep(step: OnboardingStep): OnboardingStep | null {
  switch (step) {
    case "identity":
      return null;
    case "account-kind":
      return "identity";
    case "company-details":
    case "individual-details":
      return "account-kind";
  }
}

/**
 * How many cards remain behind the active one, capped at the two peek layers
 * the deck renders. Branch steps are last, so they show none.
 */
export function onboardingPeekLayerCount(step: OnboardingStep): number {
  const remaining = ONBOARDING_TOTAL_STEPS - 1 - onboardingStepIndex(step);
  return Math.max(0, Math.min(2, remaining));
}

/** The one hard requirement of the whole flow. */
export function canContinueFromIdentity(firstName: string): boolean {
  return firstName.trim().length > 0;
}

/** Adds or removes a value from a multi-select chip row, preserving order. */
export function toggleProfileChip<Value extends string>(
  values: ReadonlyArray<Value>,
  value: Value,
): ReadonlyArray<Value> {
  return values.includes(value)
    ? values.filter((candidate) => candidate !== value)
    : [...values, value];
}

/** Single-select chips deselect when the selected chip is pressed again. */
export function toggleSingleChoice<Value extends string>(
  current: Value | null,
  value: Value,
): Value | null {
  return current === value ? null : value;
}

export type StepperArrowIntent = "back" | "advance";

/**
 * Arrow keys move the deck, but never complete onboarding: the final card's
 * submit stays an explicit click. `canAdvance` is the step's own gate (a name
 * on identity, a chosen kind on account-kind).
 */
export function resolveStepperArrowIntent(input: {
  readonly key: string;
  readonly step: OnboardingStep;
  readonly canAdvance: boolean;
  readonly isPending: boolean;
}): StepperArrowIntent | null {
  if (input.isPending) return null;
  if (input.key === "ArrowLeft") {
    return previousOnboardingStep(input.step) === null ? null : "back";
  }
  if (input.key !== "ArrowRight") return null;
  if (isOnboardingBranchStep(input.step)) return null;
  return input.canAdvance ? "advance" : null;
}

/**
 * Arrow keys belong to the text field while one is focused; the deck only
 * claims them otherwise.
 */
export function shouldIgnoreStepperKeyEvent(target: {
  readonly tagName: string;
  readonly isContentEditable: boolean;
}): boolean {
  if (target.isContentEditable) return true;
  const tagName = target.tagName.toUpperCase();
  return tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT";
}

/**
 * Shapes the company answers into metadata, or `null` when the user answered
 * nothing — an untouched branch writes no `company` key at all rather than an
 * empty husk.
 */
export function buildCompanyPatch(input: {
  readonly name: string;
  readonly size: CompanySize | null;
  readonly role: CompanyRole | null;
  readonly referralSource: ReferralSource | null;
  readonly referralDetail: string;
}): CompanyProfile | null {
  const name = input.name.trim();
  const detail = input.referralSource === "other" ? input.referralDetail.trim() : "";
  if (
    name.length === 0 &&
    input.size === null &&
    input.role === null &&
    input.referralSource === null
  ) {
    return null;
  }
  return {
    name,
    ...(input.size === null ? {} : { size: input.size }),
    ...(input.role === null ? {} : { role: input.role }),
    ...(input.referralSource === null ? {} : { referralSource: input.referralSource }),
    ...(detail.length === 0 ? {} : { referralDetail: detail }),
  };
}

/**
 * Same rule for the individual branch. The free-text detail only survives when
 * the referral source is "other", so switching away from it cannot smuggle a
 * stale string into metadata.
 */
export function buildIndividualPatch(input: {
  readonly providers: ReadonlyArray<ProviderUsage>;
  readonly referralSource: ReferralSource | null;
  readonly referralDetail: string;
}): IndividualProfile | null {
  const detail = input.referralSource === "other" ? input.referralDetail.trim() : "";
  const hasProviders = input.providers.length > 0;
  if (!hasProviders && input.referralSource === null) return null;
  return {
    ...(hasProviders ? { providers: input.providers } : {}),
    ...(input.referralSource === null ? {} : { referralSource: input.referralSource }),
    ...(detail.length === 0 ? {} : { referralDetail: detail }),
  };
}
