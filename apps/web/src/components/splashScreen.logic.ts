import type { ClerkAuthGateState } from "./clerk/authGate.logic";

/**
 * What the app is waiting on while the splash screen is up. The splash is the
 * only thing on screen at that point, so each line names the step that is
 * actually running rather than describing loading in general.
 */
export type AppLoadingReason = "account" | "environment" | "onboarding" | "profile" | "sign-in";

export const APP_LOADING_MESSAGES: Record<AppLoadingReason, string> = {
  environment: "Connecting to your environment…",
  account: "Checking your account…",
  profile: "Loading your profile…",
  "sign-in": "Taking you to sign in…",
  onboarding: "Opening setup…",
};

/**
 * The line the boot shell in index.html paints. That frame runs before any
 * bundle has loaded, so it cannot read the table above — keep the two in sync.
 */
export const BOOT_SHELL_MESSAGE = "Starting up…";

/**
 * Why the Clerk gate is still holding the app back, or null once it lets the app
 * through. `loading` covers two different waits — the SDK itself, then the
 * signed-in user's profile — so `isLoaded` picks the line that is true.
 */
export function resolveAuthGateLoadingReason({
  gateState,
  isLoaded,
}: {
  readonly gateState: ClerkAuthGateState;
  readonly isLoaded: boolean;
}): AppLoadingReason | null {
  switch (gateState) {
    case "loading":
      return isLoaded ? "profile" : "account";
    case "redirect":
      return "sign-in";
    case "onboarding":
      return "onboarding";
    default:
      return null;
  }
}
