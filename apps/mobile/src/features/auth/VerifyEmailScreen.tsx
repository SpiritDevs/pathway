import { useSignUp } from "@clerk/expo/legacy";
import { useCallback, useEffect, useState } from "react";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { AuthButton, AuthCard, AuthField, AuthLinkButton } from "./components/AuthControls";
import { AuthScreenShell } from "./components/AuthScreenShell";
import {
  isCompleteVerificationCode,
  normalizeVerificationCode,
  resolveResendCooldownSeconds,
  VERIFICATION_CODE_LENGTH,
} from "./authFlow.logic";
import { clerkErrorMessage } from "./clerkErrorMessage";

/**
 * Registration step two: the 6-digit email code. Completing it sets the
 * session active, which drops the gate onto the onboarding stepper — a brand
 * new user has no profile yet (docs/internals/decisions/0004).
 */
export function VerifyEmailScreen(props: {
  readonly emailAddress: string;
  readonly initialSentAtMs: number;
  readonly onBack: () => void;
}) {
  const { isLoaded, signUp, setActive } = useSignUp();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentAtMs, setSentAtMs] = useState(props.initialSentAtMs);
  const [cooldownSeconds, setCooldownSeconds] = useState(() =>
    resolveResendCooldownSeconds({ sentAtMs: props.initialSentAtMs, nowMs: Date.now() }),
  );

  // One timer for the whole cooldown; it stops itself when the window closes
  // so an idle verification screen is not ticking in the background.
  useEffect(() => {
    setCooldownSeconds(resolveResendCooldownSeconds({ sentAtMs, nowMs: Date.now() }));
    const interval = setInterval(() => {
      const remaining = resolveResendCooldownSeconds({ sentAtMs, nowMs: Date.now() });
      setCooldownSeconds(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [sentAtMs]);

  const handleSubmit = useCallback(() => {
    if (!isLoaded) return;
    void (async () => {
      setIsSubmitting(true);
      setError(null);
      setNotice(null);
      try {
        const attempt = await signUp.attemptEmailAddressVerification({ code });
        if (attempt.status === "complete") {
          await setActive({ session: attempt.createdSessionId });
          return;
        }
        setError("That did not complete the sign-up. Send a new code and try again.");
        setIsSubmitting(false);
      } catch (cause) {
        setError(clerkErrorMessage(cause, "We could not verify that code. Try again."));
        setIsSubmitting(false);
      }
    })();
  }, [code, isLoaded, setActive, signUp]);

  const handleResend = useCallback(() => {
    if (!isLoaded || cooldownSeconds > 0) return;
    void (async () => {
      setError(null);
      setNotice(null);
      try {
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        setSentAtMs(Date.now());
        setNotice("A new code is on the way.");
      } catch (cause) {
        setError(clerkErrorMessage(cause, "Could not send a new code. Try again shortly."));
      }
    })();
  }, [cooldownSeconds, isLoaded, signUp]);

  return (
    <AuthScreenShell
      onBack={props.onBack}
      title="Check your email"
      subtitle={`We sent a ${VERIFICATION_CODE_LENGTH}-digit code to ${props.emailAddress}.`}
    >
      <AuthCard>
        <AuthField
          label="Verification code"
          inputProps={{
            autoComplete: "one-time-code",
            className: "text-center text-2xl tracking-[8px]",
            keyboardType: "number-pad",
            maxLength: VERIFICATION_CODE_LENGTH,
            onChangeText: (value: string) => setCode(normalizeVerificationCode(value)),
            onSubmitEditing: handleSubmit,
            placeholder: "000000",
            textContentType: "oneTimeCode",
            value: code,
          }}
        />

        {error ? <ErrorBanner message={error} /> : null}

        <AuthButton
          busy={isSubmitting}
          disabled={!isLoaded || isSubmitting || !isCompleteVerificationCode(code)}
          label={isSubmitting ? "Verifying..." : "Verify email"}
          onPress={handleSubmit}
        />
        <AuthLinkButton
          disabled={cooldownSeconds > 0}
          label={cooldownSeconds > 0 ? `Resend code in ${cooldownSeconds}s` : "Resend code"}
          onPress={handleResend}
        />
        {notice ? (
          <Text className="text-center text-xs text-foreground-muted">{notice}</Text>
        ) : null}
      </AuthCard>
    </AuthScreenShell>
  );
}
