/**
 * Pure state for the /login form. The sign-in surface is three screens behind
 * one card — credentials, "email me a reset code", and "code + new password" —
 * so the transitions, the field validation and the resend cooldown live here
 * where they can be tested without Clerk, a DOM, or a timer.
 */

export const RESEND_COOLDOWN_SECONDS = 30;
export const VERIFICATION_CODE_LENGTH = 6;
export const MIN_PASSWORD_LENGTH = 8;

export type SignInStep = "client-trust-code" | "credentials" | "reset-code" | "reset-request";

export type SignInField = "code" | "identifier" | "newPassword" | "password";

export interface SignInFormState {
  readonly code: string;
  readonly error: string | null;
  readonly identifier: string;
  readonly newPassword: string;
  readonly password: string;
  readonly pending: boolean;
  readonly resendCooldown: number;
  readonly step: SignInStep;
}

export type SignInFormEvent =
  | { readonly field: SignInField; readonly type: "fieldChanged"; readonly value: string }
  | { readonly message: string; readonly type: "failed" }
  | { readonly type: "cancelled" }
  | { readonly type: "clientTrustCodeSent" }
  | { readonly type: "codeSent" }
  | { readonly type: "cooldownTicked" }
  | { readonly type: "resetRequested" }
  | { readonly type: "submitted" }
  | { readonly type: "succeeded" };

export const initialSignInFormState: SignInFormState = {
  code: "",
  error: null,
  identifier: "",
  newPassword: "",
  password: "",
  pending: false,
  resendCooldown: 0,
  step: "credentials",
};

/** Clerk rejects anything that is not exactly six digits, so never let it in. */
export function sanitizeVerificationCode(value: string) {
  return value.replace(/\D/gu, "").slice(0, VERIFICATION_CODE_LENGTH);
}

/**
 * Deliberately loose: Clerk owns the real verdict on an identifier. This only
 * catches the obvious typo before we spend a network round trip on it.
 */
function looksLikeEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function applyFieldChange(state: SignInFormState, field: SignInField, value: string) {
  switch (field) {
    case "code":
      return { ...state, code: sanitizeVerificationCode(value) };
    case "identifier":
      return { ...state, identifier: value };
    case "newPassword":
      return { ...state, newPassword: value };
    case "password":
      return { ...state, password: value };
  }
}

export function signInFormReducer(state: SignInFormState, event: SignInFormEvent): SignInFormState {
  switch (event.type) {
    case "cancelled":
      return {
        ...state,
        code: "",
        error: null,
        newPassword: "",
        pending: false,
        resendCooldown: 0,
        step: "credentials",
      };
    case "codeSent":
      // Also covers a resend: the previous code is dead, so clear the field.
      return {
        ...state,
        code: "",
        error: null,
        pending: false,
        resendCooldown: RESEND_COOLDOWN_SECONDS,
        step: "reset-code",
      };
    case "clientTrustCodeSent":
      return {
        ...state,
        code: "",
        error: null,
        password: "",
        pending: false,
        resendCooldown: RESEND_COOLDOWN_SECONDS,
        step: "client-trust-code",
      };
    case "cooldownTicked":
      return state.resendCooldown === 0
        ? state
        : { ...state, resendCooldown: state.resendCooldown - 1 };
    case "failed":
      return { ...state, error: event.message, pending: false };
    case "fieldChanged":
      return applyFieldChange(state, event.field, event.value);
    case "resetRequested":
      return { ...state, error: null, password: "", pending: false, step: "reset-request" };
    case "submitted":
      return { ...state, error: null, pending: true };
    case "succeeded":
      return { ...state, error: null, pending: false };
  }
}

/**
 * The message to show instead of submitting, or `null` when the current step is
 * ready to go to Clerk.
 */
export function validateSubmission(state: SignInFormState): string | null {
  const identifier = state.identifier.trim();

  if (state.step === "credentials" || state.step === "reset-request") {
    if (identifier === "") return "Enter your email address.";
    if (!looksLikeEmail(identifier)) return "Enter a valid email address.";
    if (state.step === "reset-request") return null;
    return state.password === "" ? "Enter your password." : null;
  }

  if (state.code.length !== VERIFICATION_CODE_LENGTH) {
    return `Enter the ${VERIFICATION_CODE_LENGTH}-digit code we emailed you.`;
  }
  if (state.step === "client-trust-code") return null;
  if (state.newPassword.length < MIN_PASSWORD_LENGTH) {
    return `Your new password needs at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

/**
 * This Clerk instance is email + password only, so every status other than the
 * one the step expects is a configuration surprise rather than a user error.
 * Naming the status keeps the report actionable instead of "something failed".
 */
const UNEXPECTED_STATUS_COPY: Record<string, string> = {
  needs_first_factor: "That email and password did not complete sign in. Try again.",
  needs_identifier: "This sign in lost track of your email address. Start again.",
  needs_new_password: "This account has to set a new password before signing in.",
  needs_second_factor:
    "This account has two-factor authentication enabled, which is not supported yet.",
};

export function describeUnexpectedSignInStatus(status: string | null): string {
  if (status === null) return "Sign in did not complete. Try again.";
  return UNEXPECTED_STATUS_COPY[status] ?? `Sign in stopped at an unsupported step (${status}).`;
}

export function resendCodeLabel(resendCooldown: number) {
  return resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : "Resend code";
}
