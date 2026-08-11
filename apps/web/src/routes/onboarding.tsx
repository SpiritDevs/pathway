import { isOnboardingComplete, parseProfileMetadata } from "@t3tools/client-runtime/profile";
import { useUser } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";

import { hasClerkPublicConfig } from "../cloud/publicConfig";
import { AuthShell } from "../components/auth/AuthShell";
import { OnboardingStepper } from "../components/onboarding/OnboardingStepper";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  if (!hasClerkPublicConfig()) return <Navigate replace to="/" />;

  return <ConfiguredOnboardingPage />;
}

function ConfiguredOnboardingPage() {
  const { isLoaded, isSignedIn, user } = useUser();

  if (isLoaded && !isSignedIn) return <Navigate replace to="/login" />;

  if (!isLoaded || !isSignedIn) {
    return (
      <AuthShell width="wide">
        <div
          aria-label="Loading your account"
          className="h-[560px] animate-pulse rounded-2xl border border-border/70 bg-card/85 shadow-xl shadow-black/8"
        />
      </AuthShell>
    );
  }

  // A finished profile has no business here — the same bounce `/login` gives a
  // signed-in visitor (docs/internals/decisions/0004).
  if (isOnboardingComplete(parseProfileMetadata(user.unsafeMetadata))) {
    return <Navigate replace to="/" />;
  }

  return (
    <AuthShell width="wide">
      <OnboardingStepper user={user} />
    </AuthShell>
  );
}
