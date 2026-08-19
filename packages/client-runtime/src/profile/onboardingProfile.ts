import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The user profile stored in Clerk `unsafeMetadata`.
 *
 * Trust boundary: `unsafeMetadata` is writable by the signed-in client, so
 * everything here is self-asserted. Nothing authorization-bearing (company
 * membership, entitlements, roles that grant anything) may live in this shape;
 * see docs/internals/decisions/0003 and 0005.
 *
 * The shape is versioned so a future store migration can read it cheaply. An
 * unknown or malformed value parses to `null`, which the app treats as "needs
 * onboarding" — never as an error.
 */
export const PROFILE_METADATA_VERSION = 1;

export const AccountKind = Schema.Literals(["individual", "company"]);
export type AccountKind = typeof AccountKind.Type;

export const CompanySize = Schema.Literals(["1-10", "11-50", "51-200", "201-1000", "1000+"]);
export type CompanySize = typeof CompanySize.Type;

export const CompanyRole = Schema.Literals(["engineer", "lead", "founder", "other"]);
export type CompanyRole = typeof CompanyRole.Type;

export const ProviderUsage = Schema.Literals(["codex", "claude", "cursor", "grok", "opencode"]);
export type ProviderUsage = typeof ProviderUsage.Type;

export const ReferralSource = Schema.Literals([
  "search",
  "social-media",
  "friend-or-colleague",
  "youtube",
  "other",
]);
export type ReferralSource = typeof ReferralSource.Type;

export const CompanyProfile = Schema.Struct({
  name: Schema.String,
  size: Schema.optionalKey(CompanySize),
  role: Schema.optionalKey(CompanyRole),
  referralSource: Schema.optionalKey(ReferralSource),
  referralDetail: Schema.optionalKey(Schema.String),
});
export type CompanyProfile = typeof CompanyProfile.Type;

export const IndividualProfile = Schema.Struct({
  providers: Schema.optionalKey(Schema.Array(ProviderUsage)),
  referralSource: Schema.optionalKey(ReferralSource),
  referralDetail: Schema.optionalKey(Schema.String),
});
export type IndividualProfile = typeof IndividualProfile.Type;

export const ProfileMetadata = Schema.Struct({
  v: Schema.Literal(PROFILE_METADATA_VERSION),
  accountKind: Schema.optionalKey(AccountKind),
  company: Schema.optionalKey(CompanyProfile),
  individual: Schema.optionalKey(IndividualProfile),
  /** ISO timestamp; presence is the single "onboarding done" signal. */
  onboardingCompletedAt: Schema.optionalKey(Schema.String),
});
export type ProfileMetadata = typeof ProfileMetadata.Type;

export const EMPTY_PROFILE_METADATA: ProfileMetadata = { v: PROFILE_METADATA_VERSION };

const decodeProfileMetadata = Schema.decodeUnknownOption(ProfileMetadata);

/**
 * Parses a Clerk `unsafeMetadata` value. Returns `null` for anything that is
 * not a valid v1 profile — absent, malformed, or a future version — which
 * callers must treat as "onboarding has not completed".
 */
export function parseProfileMetadata(value: unknown): ProfileMetadata | null {
  return Option.getOrNull(decodeProfileMetadata(value));
}

export function isOnboardingComplete(metadata: ProfileMetadata | null): boolean {
  return Boolean(metadata?.onboardingCompletedAt);
}

/**
 * Reopens the account-kind step when Clerk says onboarding finished but Convex has no usable
 * workspace for the identity. Profile details stay available as form defaults; the kind and
 * completion marker are removed so the user must deliberately provision a personal workspace or
 * organization again.
 */
export function restartOnboardingForWorkspaceRecovery(
  metadata: ProfileMetadata | null,
): ProfileMetadata {
  const current = metadata ?? EMPTY_PROFILE_METADATA;
  const {
    accountKind: _accountKind,
    onboardingCompletedAt: _onboardingCompletedAt,
    ...preserved
  } = current;
  return { ...preserved, v: PROFILE_METADATA_VERSION };
}

/** Coordinates the destructive recovery write only after an authoritative workspace check. */
export async function recoverMissingOnboardingWorkspace(options: {
  readonly hasUsableWorkspace: () => Promise<boolean>;
  readonly restartOnboarding: () => Promise<void>;
}): Promise<"valid" | "restarted"> {
  if (await options.hasUsableWorkspace()) return "valid";
  await options.restartOnboarding();
  return "restarted";
}

/**
 * Shallow-merges a patch over the current metadata, pinning the version. The
 * result is what gets written back to `user.update({ unsafeMetadata })`.
 */
export function mergeProfileMetadata(
  current: ProfileMetadata | null,
  patch: Partial<Omit<ProfileMetadata, "v">>,
): ProfileMetadata {
  return { ...(current ?? EMPTY_PROFILE_METADATA), ...patch, v: PROFILE_METADATA_VERSION };
}

/**
 * The onboarding step graph. Identity (name/avatar) comes first, then the
 * account-kind choice, then exactly one branch. The branch steps share an
 * index so a progress indicator never has to guess the total before the
 * branch is chosen.
 */
export type OnboardingStep = "identity" | "account-kind" | "company-details" | "individual-details";

export const ONBOARDING_TOTAL_STEPS = 3;

export function onboardingStepIndex(step: OnboardingStep): number {
  switch (step) {
    case "identity":
      return 0;
    case "account-kind":
      return 1;
    case "company-details":
    case "individual-details":
      return 2;
  }
}

/**
 * Resolves where a user resumes. Name lives on the native Clerk user (not in
 * metadata), so the caller passes whether one exists. Deliberately pure: web
 * and mobile both drive their steppers off this.
 */
export function resolveOnboardingStep(input: {
  readonly hasName: boolean;
  readonly metadata: ProfileMetadata | null;
}): OnboardingStep {
  if (!input.hasName) return "identity";
  const accountKind = input.metadata?.accountKind;
  if (!accountKind) return "account-kind";
  return accountKind === "company" ? "company-details" : "individual-details";
}

export interface ProfileOption<Value extends string> {
  readonly value: Value;
  readonly label: string;
}

export const COMPANY_SIZE_OPTIONS: ReadonlyArray<ProfileOption<CompanySize>> = [
  { value: "1-10", label: "1–10 people" },
  { value: "11-50", label: "11–50 people" },
  { value: "51-200", label: "51–200 people" },
  { value: "201-1000", label: "201–1,000 people" },
  { value: "1000+", label: "1,000+ people" },
];

export const COMPANY_ROLE_OPTIONS: ReadonlyArray<ProfileOption<CompanyRole>> = [
  { value: "engineer", label: "Engineer" },
  { value: "lead", label: "Lead or manager" },
  { value: "founder", label: "Founder or executive" },
  { value: "other", label: "Something else" },
];

export const PROVIDER_USAGE_OPTIONS: ReadonlyArray<ProfileOption<ProviderUsage>> = [
  { value: "codex", label: "Codex" },
  { value: "claude", label: "Claude Code" },
  { value: "cursor", label: "Cursor" },
  { value: "grok", label: "Grok" },
  { value: "opencode", label: "OpenCode" },
];

export const REFERRAL_SOURCE_OPTIONS: ReadonlyArray<ProfileOption<ReferralSource>> = [
  { value: "search", label: "Search" },
  { value: "social-media", label: "Social media" },
  { value: "friend-or-colleague", label: "A friend or colleague" },
  { value: "youtube", label: "YouTube" },
  { value: "other", label: "Somewhere else" },
];
