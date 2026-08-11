import { useSignIn } from "@clerk/expo/legacy";
import { useCallback, useEffect, useState } from "react";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { AuthButton, AuthCard, AuthField, AuthLinkButton } from "./components/AuthControls";
import { AuthScreenShell } from "./components/AuthScreenShell";
import {
  canSubmitPasswordReset,
  isLikelyEmailAddress,
  MINIMUM_PASSWORD_LENGTH,
  normalizeVerificationCode,
  resolveResendCooldownSeconds,
  VERIFICATION_CODE_LENGTH,
} from "./authFlow.logic";
import { clerkErrorMessage } from "./clerkErrorMessage";

/**
 * Password reset over `reset_password_email_code`. Under a mandatory account
 * gate a forgotten password costs you the application, not a feature, so this
 * ships with sign-in rather than after it (docs/internals/decisions/0001).
 */
export function ForgotPasswordScreen(props: {
  readonly initialEmailAddress: string;
  readonly onBack: () => void;
}) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [emailAddress, setEmailAddress] = useState(props.initialEmailAddress);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [sentAtMs, setSentAtMs] = useState<number | null>(null);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);

  useEffect(() => {
    if (sentAtMs === null) return;
    setCooldownSeconds(resolveResendCooldownSeconds({ sentAtMs, nowMs: Date.now() }));
    const interval = setInterval(() => {
      const remaining = resolveResendCooldownSeconds({ sentAtMs, nowMs: Date.now() });
      setCooldownSeconds(remaining);
      if (remaining === 0) clearInterval(interval);
    }, 1000);
    return () => clearInterval(interval);
  }, [sentAtMs]);

  const sendCode = useCallback(() => {
    if (!isLoaded) return;
    void (async () => {
      setIsSubmitting(true);
      setError(null);
      try {
        await signIn.create({
          strategy: "reset_password_email_code",
          identifier: emailAddress.trim(),
        });
        setSentAtMs(Date.now());
      } catch (cause) {
        setError(clerkErrorMessage(cause, "Could not send a reset code. Try again shortly."));
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [emailAddress, isLoaded, signIn]);

  const submitNewPassword = useCallback(() => {
    if (!isLoaded) return;
    void (async () => {
      setIsSubmitting(true);
      setError(null);
      try {
        const attempt = await signIn.attemptFirstFactor({
          strategy: "reset_password_email_code",
          code,
          password,
        });
        if (attempt.status === "complete") {
          // Resetting signs you straight in — the gate takes it from here.
          await setActive({ session: attempt.createdSessionId });
          return;
        }
        setError(
          attempt.status === "needs_second_factor"
            ? "This account needs a second factor, which is not supported yet."
            : "The reset did not complete. Send a new code and try again.",
        );
        setIsSubmitting(false);
      } catch (cause) {
        setError(clerkErrorMessage(cause, "Could not reset the password. Try again."));
        setIsSubmitting(false);
      }
    })();
  }, [code, isLoaded, password, setActive, signIn]);

  const hasSentCode = sentAtMs !== null;

  return (
    <AuthScreenShell
      onBack={props.onBack}
      title="Reset your password"
      subtitle={
        hasSentCode
          ? `Enter the ${VERIFICATION_CODE_LENGTH}-digit code we sent to ${emailAddress.trim()} and choose a new password.`
          : "We will email you a code to set a new password."
      }
    >
      <AuthCard>
        {hasSentCode ? (
          <>
            <AuthField
              label="Reset code"
              inputProps={{
                autoComplete: "one-time-code",
                className: "text-center text-2xl tracking-[8px]",
                keyboardType: "number-pad",
                maxLength: VERIFICATION_CODE_LENGTH,
                onChangeText: (value: string) => setCode(normalizeVerificationCode(value)),
                placeholder: "000000",
                textContentType: "oneTimeCode",
                value: code,
              }}
            />
            <AuthField
              label="New password"
              hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters.`}
              inputProps={{
                autoCapitalize: "none",
                autoComplete: "new-password",
                autoCorrect: false,
                onChangeText: setPassword,
                onSubmitEditing: submitNewPassword,
                placeholder: "Choose a new password",
                returnKeyType: "go",
                secureTextEntry: true,
                textContentType: "newPassword",
                value: password,
              }}
            />

            {error ? <ErrorBanner message={error} /> : null}

            <AuthButton
              busy={isSubmitting}
              disabled={!isLoaded || !canSubmitPasswordReset({ code, password, isSubmitting })}
              label={isSubmitting ? "Resetting..." : "Set new password"}
              onPress={submitNewPassword}
            />
            <AuthLinkButton
              disabled={cooldownSeconds > 0 || isSubmitting}
              label={cooldownSeconds > 0 ? `Resend code in ${cooldownSeconds}s` : "Resend code"}
              onPress={sendCode}
            />
            <Text className="text-center text-xs text-foreground-muted">
              Resetting your password signs you in on this device.
            </Text>
          </>
        ) : (
          <>
            <AuthField
              label="Email"
              inputProps={{
                autoCapitalize: "none",
                autoComplete: "email",
                autoCorrect: false,
                keyboardType: "email-address",
                onChangeText: setEmailAddress,
                onSubmitEditing: sendCode,
                placeholder: "you@example.com",
                returnKeyType: "go",
                textContentType: "emailAddress",
                value: emailAddress,
              }}
            />

            {error ? <ErrorBanner message={error} /> : null}

            <AuthButton
              busy={isSubmitting}
              disabled={!isLoaded || isSubmitting || !isLikelyEmailAddress(emailAddress)}
              label={isSubmitting ? "Sending..." : "Send reset code"}
              onPress={sendCode}
            />
          </>
        )}
      </AuthCard>
    </AuthScreenShell>
  );
}
