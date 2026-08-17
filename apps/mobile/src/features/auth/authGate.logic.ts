/**
 * The mobile mirror of `apps/web/src/components/clerk/authGate.logic.ts`.
 *
 * Mobile has no URL to gate on: the gate swaps the whole tree instead of
 * redirecting, so there is no `public` (route) state and no `redirect` state.
 * `misconfigured` is the mobile spelling of the web root's
 * `MissingAuthConfigScreen` branch — accounts are mandatory, so a build with
 * no Clerk publishable key fails closed (docs/internals/decisions/0001).
 */
export type MobileAuthGateState =
  | "misconfigured"
  | "loading"
  | "auth"
  | "onboarding"
  | "authenticated";
export type WorkspaceValidationState = "checking" | "valid" | "unavailable";

export function resolveMobileAuthGateState({
  hasClerkConfig,
  isLoaded,
  isSignedIn,
  onboardingComplete,
  workspaceValidation,
}: {
  readonly hasClerkConfig: boolean;
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  /** `undefined` while the Clerk user object is still loading. */
  readonly onboardingComplete: boolean | undefined;
  readonly workspaceValidation: WorkspaceValidationState;
}): MobileAuthGateState {
  if (!hasClerkConfig) return "misconfigured";
  if (!isLoaded) return "loading";
  if (!isSignedIn) return "auth";
  if (onboardingComplete === undefined) return "loading";
  if (!onboardingComplete) return "onboarding";
  return workspaceValidation === "checking" ? "loading" : "authenticated";
}
