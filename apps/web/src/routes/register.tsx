import { useAuth } from "@clerk/react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { AuthShell } from "../components/auth/AuthShell";
import { RegisterForm } from "../components/auth/RegisterForm";
import { VerifyEmailCodeForm } from "../components/auth/VerifyEmailCodeForm";
import { type RegisterStep } from "../components/auth/registerForm.logic";
import { hasClerkPublicConfig } from "../cloud/publicConfig";

export const Route = createFileRoute("/register")({
  component: RegisterPage,
});

function RegisterPage() {
  if (!hasClerkPublicConfig()) return <Navigate replace to="/" />;

  return <ConfiguredRegisterPage />;
}

function ConfiguredRegisterPage() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const [step, setStep] = useState<RegisterStep>("details");
  const [email, setEmail] = useState("");

  // The root gate forwards a signed-in user with an incomplete profile to
  // /onboarding, so this only needs to get them off the registration surface.
  if (isLoaded && isSignedIn) return <Navigate replace to="/" />;

  return (
    <AuthShell>
      {!isLoaded ? (
        <div
          aria-label="Loading registration"
          className="h-[25rem] rounded-2xl border border-border/70 bg-card/85 shadow-xl shadow-black/8"
        />
      ) : null}

      {isLoaded && step === "details" ? (
        <RegisterForm
          email={email}
          onCodeSent={(sentTo) => {
            setEmail(sentTo);
            setStep("verify");
          }}
          onEmailChange={setEmail}
        />
      ) : null}

      {isLoaded && step === "verify" ? (
        <VerifyEmailCodeForm
          emailAddress={email}
          onBack={() => {
            setStep("details");
          }}
        />
      ) : null}
    </AuthShell>
  );
}
