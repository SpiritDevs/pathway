import { useSignUp } from "@clerk/react/legacy";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { clerkErrorMessage } from "./clerkErrorMessage";
import {
  RESEND_COOLDOWN_SECONDS,
  VERIFICATION_CODE_LENGTH,
  canResendCode,
  isVerificationCodeComplete,
  normalizeVerificationCode,
  resendButtonLabel,
  resendCooldownEndsAt,
  resendSecondsRemaining,
} from "./registerForm.logic";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * Step two of registration: the 6-digit code Clerk emailed after
 * `prepareEmailAddressVerification`. A completed attempt activates the new
 * session and hands off to /onboarding, where the root gate takes over.
 */
export function VerifyEmailCodeForm({
  emailAddress,
  onBack,
}: {
  readonly emailAddress: string;
  readonly onBack: () => void;
}) {
  const { isLoaded, signUp, setActive } = useSignUp();
  const navigate = useNavigate();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResending, setIsResending] = useState(false);
  const [didResend, setDidResend] = useState(false);
  // A code was already sent by the details step, so the cooldown starts on mount.
  const [cooldownEndsAt, setCooldownEndsAt] = useState<number | null>(() =>
    resendCooldownEndsAt(Date.now()),
  );
  const [secondsRemaining, setSecondsRemaining] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldownEndsAt === null) {
      setSecondsRemaining(0);
      return;
    }

    setSecondsRemaining(resendSecondsRemaining(cooldownEndsAt, Date.now()));
    const timer = window.setInterval(() => {
      const remaining = resendSecondsRemaining(cooldownEndsAt, Date.now());
      setSecondsRemaining(remaining);
      if (remaining <= 0) {
        window.clearInterval(timer);
        setCooldownEndsAt(null);
      }
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [cooldownEndsAt]);

  const resendUnlocked = canResendCode({
    isBusy: isResending || isSubmitting,
    secondsRemaining,
  });

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || isSubmitting) return;
    if (!isVerificationCodeComplete(code)) {
      setError(`Enter the ${VERIFICATION_CODE_LENGTH}-digit code from your email.`);
      return;
    }

    setError(null);
    setDidResend(false);
    setIsSubmitting(true);
    try {
      const attempt = await signUp.attemptEmailAddressVerification({ code });
      if (attempt.status === "complete" && attempt.createdSessionId !== null) {
        await setActive({ session: attempt.createdSessionId });
        await navigate({ replace: true, to: "/onboarding" });
        return;
      }
      setError("That did not finish sign-up. Check the code and try again.");
    } catch (caught) {
      setError(clerkErrorMessage(caught, "We could not verify that code. Try again."));
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleResend() {
    if (!isLoaded || !resendUnlocked) return;

    setError(null);
    setDidResend(false);
    setIsResending(true);
    try {
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      setDidResend(true);
      setCooldownEndsAt(resendCooldownEndsAt(Date.now()));
    } catch (caught) {
      setError(clerkErrorMessage(caught, "We could not send a new code. Try again."));
    } finally {
      setIsResending(false);
    }
  }

  return (
    <form
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-xl shadow-black/8"
      noValidate
      onSubmit={handleSubmit}
    >
      <div className="mb-6 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent a {VERIFICATION_CODE_LENGTH}-digit code to{" "}
          <span className="font-medium text-foreground">{emailAddress}</span>.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="register-code">Verification code</Label>
          <Input
            autoComplete="one-time-code"
            autoFocus
            className="[&_input]:text-center [&_input]:font-mono [&_input]:tracking-[0.5em]"
            id="register-code"
            inputMode="numeric"
            maxLength={VERIFICATION_CODE_LENGTH}
            name="code"
            onChange={(event) => setCode(normalizeVerificationCode(event.target.value))}
            placeholder="000000"
            size="lg"
            value={code}
          />
        </div>

        {error === null ? null : (
          <p className="text-sm text-destructive-foreground" role="alert">
            {error}
          </p>
        )}

        {error === null && didResend ? (
          <p className="text-sm text-muted-foreground" role="status">
            Code sent. Check your inbox.
          </p>
        ) : null}

        <Button className="w-full" disabled={!isLoaded || isSubmitting} size="lg" type="submit">
          {isSubmitting ? "Verifying…" : "Verify email"}
        </Button>

        <div className="flex items-center justify-between gap-2">
          <Button onClick={onBack} size="sm" variant="ghost">
            Use a different email
          </Button>
          <Button
            disabled={!isLoaded || !resendUnlocked}
            onClick={handleResend}
            size="sm"
            variant="ghost"
          >
            {isResending ? "Sending…" : resendButtonLabel(secondsRemaining)}
          </Button>
        </div>
      </div>
    </form>
  );
}
