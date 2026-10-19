import { useSignIn } from "@clerk/react/legacy";
import { Link, useNavigate } from "@tanstack/react-router";
import { type Dispatch, type FormEvent, useEffect, useReducer } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { clerkErrorMessage } from "./clerkErrorMessage";
import {
  describeUnexpectedSignInStatus,
  initialSignInFormState,
  resendCodeLabel,
  signInFormReducer,
  validateSubmission,
  VERIFICATION_CODE_LENGTH,
  type SignInFormEvent,
  type SignInFormState,
} from "./signInForm.logic";
import { cn } from "~/lib/utils";

const CARD_CLASS = "rounded-2xl border border-border/70 bg-card p-6 shadow-xl shadow-black/8";
const QUIET_LINK_CLASS =
  "cursor-pointer rounded-sm text-muted-foreground text-xs underline-offset-4 outline-none transition-colors hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64";

interface StepProps {
  readonly dispatch: Dispatch<SignInFormEvent>;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  readonly state: SignInFormState;
}

interface CredentialsStepProps extends StepProps {
  readonly onForgotPassword: () => void;
}

interface ResetRequestStepProps extends StepProps {
  readonly onCancel: () => void;
}

interface ResetCodeStepProps extends ResetRequestStepProps {
  readonly onResend: () => void;
}

type ClientTrustCodeStepProps = ResetCodeStepProps;

function CardHeading({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <div className="mb-5 space-y-1">
      <h1 className="font-semibold text-base text-foreground tracking-tight">{title}</h1>
      <p className="text-muted-foreground text-sm">{description}</p>
    </div>
  );
}

function FormAlert({ message }: { readonly message: string }) {
  return (
    <p className="mb-4 text-destructive text-sm" role="alert">
      {message}
    </p>
  );
}

function LoadingCard() {
  return <div aria-busy="true" aria-label="Loading sign in" className={cn(CARD_CLASS, "h-96")} />;
}

function CredentialsStep({ dispatch, onForgotPassword, onSubmit, state }: CredentialsStepProps) {
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="sign-in-email">Email</Label>
        <Input
          autoComplete="email"
          autoFocus
          disabled={state.pending}
          id="sign-in-email"
          onChange={(event) => {
            dispatch({ field: "identifier", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="you@company.com"
          type="email"
          value={state.identifier}
        />
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-1.5">
        <Label htmlFor="sign-in-password">Password</Label>
        <Input
          autoComplete="current-password"
          className="col-span-2 row-start-2"
          disabled={state.pending}
          id="sign-in-password"
          onChange={(event) => {
            dispatch({ field: "password", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="Your password"
          type="password"
          value={state.password}
        />
        <button
          className={cn(QUIET_LINK_CLASS, "col-start-2 row-start-1")}
          disabled={state.pending}
          onClick={onForgotPassword}
          type="button"
        >
          Forgot password?
        </button>
      </div>

      <Button className="w-full" disabled={state.pending} size="lg" type="submit">
        {state.pending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  );
}

function ResetRequestStep({ dispatch, onCancel, onSubmit, state }: ResetRequestStepProps) {
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="reset-email">Email</Label>
        <Input
          autoComplete="email"
          autoFocus
          disabled={state.pending}
          id="reset-email"
          onChange={(event) => {
            dispatch({ field: "identifier", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="you@company.com"
          type="email"
          value={state.identifier}
        />
      </div>

      <Button className="w-full" disabled={state.pending} size="lg" type="submit">
        {state.pending ? "Sending code…" : "Email me a reset code"}
      </Button>

      <div className="text-center">
        <button
          className={QUIET_LINK_CLASS}
          disabled={state.pending}
          onClick={onCancel}
          type="button"
        >
          Back to sign in
        </button>
      </div>
    </form>
  );
}

function ResetCodeStep({ dispatch, onCancel, onResend, onSubmit, state }: ResetCodeStepProps) {
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="reset-code">Verification code</Label>
        <Input
          autoComplete="one-time-code"
          autoFocus
          disabled={state.pending}
          id="reset-code"
          inputMode="numeric"
          maxLength={VERIFICATION_CODE_LENGTH}
          onChange={(event) => {
            dispatch({ field: "code", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="000000"
          value={state.code}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="reset-new-password">New password</Label>
        <Input
          autoComplete="new-password"
          disabled={state.pending}
          id="reset-new-password"
          onChange={(event) => {
            dispatch({ field: "newPassword", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="At least 8 characters"
          type="password"
          value={state.newPassword}
        />
      </div>

      <Button className="w-full" disabled={state.pending} size="lg" type="submit">
        {state.pending ? "Updating password…" : "Set password and sign in"}
      </Button>

      <div className="flex items-baseline justify-between gap-3">
        <button
          className={QUIET_LINK_CLASS}
          disabled={state.pending}
          onClick={onCancel}
          type="button"
        >
          Back to sign in
        </button>
        <button
          className={QUIET_LINK_CLASS}
          disabled={state.pending || state.resendCooldown > 0}
          onClick={onResend}
          type="button"
        >
          {resendCodeLabel(state.resendCooldown)}
        </button>
      </div>
    </form>
  );
}

function ClientTrustCodeStep({
  dispatch,
  onCancel,
  onResend,
  onSubmit,
  state,
}: ClientTrustCodeStepProps) {
  return (
    <form className="space-y-4" onSubmit={onSubmit}>
      <div className="space-y-1.5">
        <Label htmlFor="client-trust-code">Verification code</Label>
        <Input
          autoComplete="one-time-code"
          autoFocus
          disabled={state.pending}
          id="client-trust-code"
          inputMode="numeric"
          maxLength={VERIFICATION_CODE_LENGTH}
          onChange={(event) => {
            dispatch({ field: "code", type: "fieldChanged", value: event.target.value });
          }}
          placeholder="000000"
          value={state.code}
        />
      </div>

      <Button className="w-full" disabled={state.pending} size="lg" type="submit">
        {state.pending ? "Verifying…" : "Verify and sign in"}
      </Button>

      <div className="flex items-baseline justify-between gap-3">
        <button
          className={QUIET_LINK_CLASS}
          disabled={state.pending}
          onClick={onCancel}
          type="button"
        >
          Back to sign in
        </button>
        <button
          className={QUIET_LINK_CLASS}
          disabled={state.pending || state.resendCooldown > 0}
          onClick={onResend}
          type="button"
        >
          {resendCodeLabel(state.resendCooldown)}
        </button>
      </div>
    </form>
  );
}

/**
 * The first-party sign-in card. Clerk's `<SignIn />` is replaced by
 * `useSignIn()` from `@clerk/react/legacy` — in v6.12 the root `useSignIn`
 * export is the signals-based hook, and the `{ isLoaded, signIn, setActive }`
 * resource hook this flow needs lives on the `legacy` entrypoint.
 */
export function SignInForm() {
  const clerkSignIn = useSignIn();
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(signInFormReducer, initialSignInFormState);
  const cooldownActive = state.resendCooldown > 0;

  useEffect(() => {
    if (!cooldownActive) return;
    const timer = window.setInterval(() => {
      dispatch({ type: "cooldownTicked" });
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [cooldownActive]);

  const submitCredentials = async () => {
    if (!clerkSignIn.isLoaded) return;
    const { setActive, signIn } = clerkSignIn;
    dispatch({ type: "submitted" });

    try {
      const attempt = await signIn.create({
        identifier: state.identifier.trim(),
        password: state.password,
      });

      if (attempt.status === "complete" && attempt.createdSessionId !== null) {
        await setActive({ session: attempt.createdSessionId });
        dispatch({ type: "succeeded" });
        await navigate({ replace: true, to: "/" });
        return;
      }

      if (attempt.status === "needs_client_trust") {
        const emailCodeFactor = attempt.supportedSecondFactors?.find(
          (factor) => factor.strategy === "email_code",
        );
        if (!emailCodeFactor) {
          dispatch({
            message: "This sign-in requires a verification method that is not available.",
            type: "failed",
          });
          return;
        }

        await attempt.prepareSecondFactor({
          emailAddressId: emailCodeFactor.emailAddressId,
          strategy: "email_code",
        });
        dispatch({ type: "clientTrustCodeSent" });
        return;
      }

      dispatch({ message: describeUnexpectedSignInStatus(attempt.status), type: "failed" });
    } catch (error) {
      dispatch({
        message: clerkErrorMessage(error, "We could not sign you in. Try again."),
        type: "failed",
      });
    }
  };

  const sendClientTrustCode = async () => {
    if (!clerkSignIn.isLoaded) return;
    const { signIn } = clerkSignIn;
    dispatch({ type: "submitted" });

    try {
      const emailCodeFactor = signIn.supportedSecondFactors?.find(
        (factor) => factor.strategy === "email_code",
      );
      if (!emailCodeFactor) {
        dispatch({
          message: "This sign-in requires a verification method that is not available.",
          type: "failed",
        });
        return;
      }

      await signIn.prepareSecondFactor({
        emailAddressId: emailCodeFactor.emailAddressId,
        strategy: "email_code",
      });
      dispatch({ type: "clientTrustCodeSent" });
    } catch (error) {
      dispatch({
        message: clerkErrorMessage(error, "We could not send a verification code. Try again."),
        type: "failed",
      });
    }
  };

  const submitClientTrustCode = async () => {
    if (!clerkSignIn.isLoaded) return;
    const { setActive, signIn } = clerkSignIn;
    dispatch({ type: "submitted" });

    try {
      const attempt = await signIn.attemptSecondFactor({
        code: state.code,
        strategy: "email_code",
      });

      if (attempt.status === "complete" && attempt.createdSessionId !== null) {
        await setActive({ session: attempt.createdSessionId });
        dispatch({ type: "succeeded" });
        await navigate({ replace: true, to: "/" });
        return;
      }

      dispatch({ message: describeUnexpectedSignInStatus(attempt.status), type: "failed" });
    } catch (error) {
      dispatch({
        message: clerkErrorMessage(error, "That verification code did not work. Try again."),
        type: "failed",
      });
    }
  };

  const sendResetCode = async () => {
    if (!clerkSignIn.isLoaded) return;
    const { signIn } = clerkSignIn;
    dispatch({ type: "submitted" });

    try {
      const attempt = await signIn.create({
        identifier: state.identifier.trim(),
        strategy: "reset_password_email_code",
      });

      if (attempt.status === "needs_first_factor") {
        dispatch({ type: "codeSent" });
        return;
      }

      dispatch({ message: describeUnexpectedSignInStatus(attempt.status), type: "failed" });
    } catch (error) {
      dispatch({
        message: clerkErrorMessage(error, "We could not send a reset code. Try again."),
        type: "failed",
      });
    }
  };

  const submitNewPassword = async () => {
    if (!clerkSignIn.isLoaded) return;
    const { setActive, signIn } = clerkSignIn;
    dispatch({ type: "submitted" });

    try {
      const verified = await signIn.attemptFirstFactor({
        code: state.code,
        password: state.newPassword,
        strategy: "reset_password_email_code",
      });
      // Clerk answers `needs_new_password` when it accepted the code but not the
      // password alongside it; finishing the job here avoids a dead end.
      const attempt =
        verified.status === "needs_new_password"
          ? await signIn.resetPassword({ password: state.newPassword })
          : verified;

      if (attempt.status === "complete" && attempt.createdSessionId !== null) {
        await setActive({ session: attempt.createdSessionId });
        dispatch({ type: "succeeded" });
        await navigate({ replace: true, to: "/" });
        return;
      }

      dispatch({ message: describeUnexpectedSignInStatus(attempt.status), type: "failed" });
    } catch (error) {
      dispatch({
        message: clerkErrorMessage(error, "We could not reset your password. Try again."),
        type: "failed",
      });
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (state.pending) return;

    const invalid = validateSubmission(state);
    if (invalid !== null) {
      dispatch({ message: invalid, type: "failed" });
      return;
    }

    if (state.step === "credentials") {
      void submitCredentials();
      return;
    }
    if (state.step === "reset-request") {
      void sendResetCode();
      return;
    }
    if (state.step === "client-trust-code") {
      void submitClientTrustCode();
      return;
    }
    void submitNewPassword();
  };

  const handleResend = () => {
    if (state.pending || cooldownActive) return;
    if (state.step === "client-trust-code") {
      void sendClientTrustCode();
      return;
    }
    void sendResetCode();
  };

  const handleForgotPassword = () => {
    dispatch({ type: "resetRequested" });
  };

  const handleCancel = () => {
    dispatch({ type: "cancelled" });
  };

  if (!clerkSignIn.isLoaded) return <LoadingCard />;

  return (
    <div>
      <div className={CARD_CLASS}>
        {state.step === "credentials" ? (
          <CardHeading description="Sign in to your workspace." title="Welcome back" />
        ) : null}
        {state.step === "reset-request" ? (
          <CardHeading
            description="We will email you a six-digit code to set a new password."
            title="Reset your password"
          />
        ) : null}
        {state.step === "reset-code" ? (
          <CardHeading
            description={`Enter the code we sent to ${state.identifier.trim()} and choose a new password.`}
            title="Check your email"
          />
        ) : null}
        {state.step === "client-trust-code" ? (
          <CardHeading
            description={`Enter the six-digit code we sent to ${state.identifier.trim()}.`}
            title="Verify this device"
          />
        ) : null}

        {state.error === null ? null : <FormAlert message={state.error} />}

        {state.step === "credentials" ? (
          <CredentialsStep
            dispatch={dispatch}
            onForgotPassword={handleForgotPassword}
            onSubmit={handleSubmit}
            state={state}
          />
        ) : null}
        {state.step === "reset-request" ? (
          <ResetRequestStep
            dispatch={dispatch}
            onCancel={handleCancel}
            onSubmit={handleSubmit}
            state={state}
          />
        ) : null}
        {state.step === "reset-code" ? (
          <ResetCodeStep
            dispatch={dispatch}
            onCancel={handleCancel}
            onResend={handleResend}
            onSubmit={handleSubmit}
            state={state}
          />
        ) : null}
        {state.step === "client-trust-code" ? (
          <ClientTrustCodeStep
            dispatch={dispatch}
            onCancel={handleCancel}
            onResend={handleResend}
            onSubmit={handleSubmit}
            state={state}
          />
        ) : null}
      </div>

      <p className="mt-5 text-center text-muted-foreground text-sm">
        New here?{" "}
        <Link
          className="cursor-pointer font-medium text-foreground underline-offset-4 hover:underline"
          to="/register"
        >
          Create an account
        </Link>
      </p>
    </div>
  );
}
