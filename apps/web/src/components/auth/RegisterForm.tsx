import { useSignUp } from "@clerk/react/legacy";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";

import { clerkErrorMessage } from "./clerkErrorMessage";
import { validateRegisterDetails } from "./registerForm.logic";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";

/**
 * Step one of registration: email and password against Clerk's headless
 * `useSignUp`. On success it prepares the email-code verification and hands
 * the normalised address back so the code screen can address it.
 */
export function RegisterForm({
  email,
  onEmailChange,
  onCodeSent,
}: {
  readonly email: string;
  readonly onEmailChange: (email: string) => void;
  readonly onCodeSent: (email: string) => void;
}) {
  const { isLoaded, signUp } = useSignUp();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [captchaVisible, setCaptchaVisible] = useState(false);

  // Clerk resolves `signUp.create()` only after an interactive challenge is
  // solved, so while the Cloudflare checkbox is on screen the submit looks
  // stuck. Watch the mount point so the copy can say whose turn it is.
  useEffect(() => {
    const element = document.getElementById("clerk-captcha");
    if (!element) return;
    const sync = () => {
      setCaptchaVisible(element.childElementCount > 0);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(element, { childList: true });
    return () => {
      observer.disconnect();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isLoaded || isSubmitting) return;

    const emailAddress = email.trim();
    const invalid = validateRegisterDetails({ email: emailAddress, password });
    if (invalid !== null) {
      setError(invalid);
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await signUp.create({ emailAddress, password });
      await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      onCodeSent(emailAddress);
    } catch (caught) {
      setError(clerkErrorMessage(caught, "We could not create your account. Try again."));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form
      className="rounded-2xl border border-border/70 bg-card p-6 shadow-xl shadow-black/8"
      noValidate
      onSubmit={handleSubmit}
    >
      <div className="mb-6 space-y-1">
        <h1 className="text-lg font-semibold tracking-tight text-foreground">
          Create your account
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign up with your email address to get started.
        </p>
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="register-email">Email</Label>
          <Input
            autoComplete="email"
            autoFocus
            id="register-email"
            name="email"
            onChange={(event) => onEmailChange(event.target.value)}
            placeholder="you@example.com"
            type="email"
            value={email}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="register-password">Password</Label>
          <Input
            autoComplete="new-password"
            id="register-password"
            name="password"
            onChange={(event) => setPassword(event.target.value)}
            placeholder="At least 8 characters"
            type="password"
            value={password}
          />
        </div>

        {/*
          Clerk's bot protection mounts its widget into this element. It must be
          in the DOM before `signUp.create()` runs or the call fails and the
          submit button looks dead. Never hide it — Turnstile mis-sizes and can
          crash-loop when initialized inside a display:none container, and an
          empty div is zero-height anyway.
        */}
        <div id="clerk-captcha" />

        {captchaVisible ? (
          <p aria-live="polite" className="text-sm text-muted-foreground">
            Complete the check above to continue.
          </p>
        ) : null}

        {error === null ? null : (
          <p className="text-sm text-destructive-foreground" role="alert">
            {error}
          </p>
        )}

        <Button className="w-full" disabled={!isLoaded || isSubmitting} size="lg" type="submit">
          {isSubmitting
            ? captchaVisible
              ? "Waiting for verification…"
              : "Creating account…"
            : "Create account"}
        </Button>
      </div>

      <p className="mt-6 text-center text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link
          className="font-medium text-foreground underline-offset-4 hover:underline"
          to="/login"
        >
          Sign in
        </Link>
      </p>
    </form>
  );
}
