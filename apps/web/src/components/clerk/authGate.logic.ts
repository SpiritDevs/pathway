export type ClerkAuthGateState = "authenticated" | "loading" | "onboarding" | "public" | "redirect";

const PUBLIC_AUTH_PATHNAMES = new Set(["/login", "/register"]);

/**
 * The single decision about whether a visitor may reach the app. `onboarding`
 * means signed in but the profile stepper has not completed; `/onboarding`
 * itself requires a signed-in user, so it is not in the public set.
 * `onboardingComplete` is `undefined` while the Clerk user object is still
 * loading — the gate holds rather than guessing.
 */
export function resolveClerkAuthGateState({
  isLoaded,
  isSignedIn,
  onboardingComplete,
  pathname,
}: {
  readonly isLoaded: boolean;
  readonly isSignedIn: boolean | undefined;
  readonly onboardingComplete: boolean | undefined;
  readonly pathname: string;
}): ClerkAuthGateState {
  if (PUBLIC_AUTH_PATHNAMES.has(pathname)) return "public";
  if (!isLoaded) return "loading";
  if (!isSignedIn) return "redirect";
  if (onboardingComplete === undefined) return "loading";
  if (!onboardingComplete && pathname !== "/onboarding") return "onboarding";
  return "authenticated";
}
