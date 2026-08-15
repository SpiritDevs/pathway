import {
  ONBOARDING_TOTAL_STEPS,
  onboardingStepIndex,
  type CompanyProfile,
  type CompanyRole,
  type CompanySize,
  type IndividualProfile,
  type OnboardingStep,
  type ProviderUsage,
  type ReferralSource,
} from "@spiritdevs/client-runtime/profile";

/**
 * Mobile-side glue for the shared onboarding step graph. The graph itself
 * (`resolveOnboardingStep`, `onboardingStepIndex`, the option lists) lives in
 * `@spiritdevs/client-runtime/profile` and is shared with web; only the pieces
 * the native stepper needs on top of it live here.
 */

/**
 * Forward edge of the step graph. `null` means the stepper is finished and the
 * caller should write `onboardingCompletedAt`.
 */
export function resolveNextOnboardingStep(
  step: OnboardingStep,
  accountKind: "individual" | "company" | undefined,
): OnboardingStep | null {
  switch (step) {
    case "identity":
      return "account-kind";
    case "account-kind":
      // The branch is unknown until the choice is written, so the caller must
      // pass the kind it just persisted.
      return accountKind === "company" ? "company-details" : "individual-details";
    case "company-details":
    case "individual-details":
      return null;
  }
}

/** Back edge. `null` at the first step — there is nowhere to go but sign-out. */
export function resolvePreviousOnboardingStep(step: OnboardingStep): OnboardingStep | null {
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

export function onboardingProgressLabel(step: OnboardingStep): string {
  return `Step ${onboardingStepIndex(step) + 1} of ${ONBOARDING_TOTAL_STEPS}`;
}

/** The one hard-required field in the whole flow. */
export function canContinueIdentity(firstName: string): boolean {
  return firstName.trim().length > 0;
}

/**
 * `user.update` treats `undefined` as "leave alone" but empty string as a real
 * value, so a cleared last name has to be sent as `""` rather than dropped.
 */
export function buildIdentityUpdate(input: {
  readonly firstName: string;
  readonly lastName: string;
}): { readonly firstName: string; readonly lastName: string } {
  return { firstName: input.firstName.trim(), lastName: input.lastName.trim() };
}

/** expo-image-picker returns JPEG base64; Clerk accepts a data URL string. */
export function avatarDataUrl(base64: string): string {
  return `data:image/jpeg;base64,${base64}`;
}

export function toggleProviderSelection(
  selected: ReadonlyArray<ProviderUsage>,
  value: ProviderUsage,
): ReadonlyArray<ProviderUsage> {
  return selected.includes(value)
    ? selected.filter((entry) => entry !== value)
    : [...selected, value];
}

/**
 * Skippable answers collapse to `undefined` rather than an empty struct, so a
 * skipped branch leaves no misleading `{ name: "" }` behind in metadata.
 */
export function buildCompanyProfile(input: {
  readonly name: string;
  readonly size: CompanySize | null;
  readonly role: CompanyRole | null;
}): CompanyProfile | undefined {
  const name = input.name.trim();
  if (name.length === 0 && input.size === null && input.role === null) return undefined;
  return {
    name,
    ...(input.size === null ? {} : { size: input.size }),
    ...(input.role === null ? {} : { role: input.role }),
  };
}

export function buildIndividualProfile(input: {
  readonly providers: ReadonlyArray<ProviderUsage>;
  readonly referralSource: ReferralSource | null;
  readonly referralDetail: string;
}): IndividualProfile | undefined {
  const referralDetail = input.referralDetail.trim();
  // The detail box only exists under "other"; anything typed and then
  // abandoned by switching source must not be persisted.
  const keepDetail = input.referralSource === "other" && referralDetail.length > 0;
  if (input.providers.length === 0 && input.referralSource === null && !keepDetail) {
    return undefined;
  }
  return {
    ...(input.providers.length === 0 ? {} : { providers: input.providers }),
    ...(input.referralSource === null ? {} : { referralSource: input.referralSource }),
    ...(keepDetail ? { referralDetail } : {}),
  };
}
