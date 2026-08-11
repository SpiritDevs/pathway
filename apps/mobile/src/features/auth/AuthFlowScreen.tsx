import { useCallback, useState } from "react";

import { ForgotPasswordScreen } from "./ForgotPasswordScreen";
import { RegisterScreen } from "./RegisterScreen";
import { SignInScreen } from "./SignInScreen";
import { VerifyEmailScreen } from "./VerifyEmailScreen";
import { resolveAuthFlowBackStep, SIGN_IN_STEP, type AuthFlowStep } from "./authFlow.logic";

/**
 * Host for the signed-out surface.
 *
 * These screens are NOT registered on the root native stack. The gate swaps
 * the whole tree (see AuthGate), so the root navigator — and with it the
 * workspace layout, the thread outbox drain, and every deep link that assumes
 * a signed-in account — is not mounted while this is on screen. The flow is
 * small enough to own its own step graph; the transitions live in
 * authFlow.logic.ts where they are testable without a renderer.
 *
 * The email address is threaded between steps so a user who mistypes at
 * sign-in does not retype it to register, and vice versa.
 */
export function AuthFlowScreen() {
  const [step, setStep] = useState<AuthFlowStep>(SIGN_IN_STEP);
  const [emailAddress, setEmailAddress] = useState("");
  const [verificationSentAtMs, setVerificationSentAtMs] = useState(0);

  const goBack = useCallback(() => {
    setStep((current) => resolveAuthFlowBackStep(current) ?? current);
  }, []);

  const goToRegister = useCallback((nextEmailAddress: string) => {
    setEmailAddress(nextEmailAddress);
    setStep({ kind: "register" });
  }, []);

  const goToSignIn = useCallback((nextEmailAddress: string) => {
    setEmailAddress(nextEmailAddress);
    setStep(SIGN_IN_STEP);
  }, []);

  const goToForgotPassword = useCallback((nextEmailAddress: string) => {
    setEmailAddress(nextEmailAddress);
    setStep({ kind: "forgot-password", emailAddress: nextEmailAddress });
  }, []);

  const goToVerification = useCallback((nextEmailAddress: string) => {
    setEmailAddress(nextEmailAddress);
    setVerificationSentAtMs(Date.now());
    setStep({ kind: "verify-email", emailAddress: nextEmailAddress });
  }, []);

  switch (step.kind) {
    case "sign-in":
      return (
        <SignInScreen
          initialEmailAddress={emailAddress}
          onForgotPassword={goToForgotPassword}
          onRegister={goToRegister}
        />
      );
    case "register":
      return (
        <RegisterScreen
          initialEmailAddress={emailAddress}
          onBack={goBack}
          onSignIn={goToSignIn}
          onVerificationSent={goToVerification}
        />
      );
    case "verify-email":
      return (
        <VerifyEmailScreen
          emailAddress={step.emailAddress}
          initialSentAtMs={verificationSentAtMs}
          onBack={goBack}
        />
      );
    case "forgot-password":
      return <ForgotPasswordScreen initialEmailAddress={step.emailAddress} onBack={goBack} />;
  }
}
