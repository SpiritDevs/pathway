/**
 * Pure state for the signed-out auth surface. The screens are swapped by the
 * gate rather than pushed onto the root navigator (the root stack only exists
 * for the authenticated app), so the flow keeps its own small step graph here
 * where it can be tested without a renderer.
 */
export type AuthFlowStep =
  /** Email + password sign-in. The entry point. */
  | { readonly kind: "sign-in" }
  /** Email + password registration. */
  | { readonly kind: "register" }
  /** 6-digit email code after `signUp.create`. */
  | { readonly kind: "verify-email"; readonly emailAddress: string }
  /** `reset_password_email_code` — send code, then code + new password. */
  | { readonly kind: "forgot-password"; readonly emailAddress: string };

export const SIGN_IN_STEP: AuthFlowStep = { kind: "sign-in" };

/** Seconds a resend control stays disabled after sending a code. */
export const VERIFICATION_RESEND_COOLDOWN_SECONDS = 30;

export const VERIFICATION_CODE_LENGTH = 6;

export const MINIMUM_PASSWORD_LENGTH = 8;

/**
 * Where the back control goes. `null` means the step is the root of the flow
 * and should render no back affordance.
 */
export function resolveAuthFlowBackStep(step: AuthFlowStep): AuthFlowStep | null {
  switch (step.kind) {
    case "sign-in":
      return null;
    case "register":
    case "forgot-password":
      return SIGN_IN_STEP;
    case "verify-email":
      // Abandoning verification drops back to registration, not sign-in: the
      // account does not exist yet.
      return { kind: "register" };
  }
}

/**
 * Deliberately permissive. Clerk is the authority on whether an identifier is
 * usable; this only stops obviously-empty submissions from costing a round
 * trip (and a rate-limit slot).
 */
export function isLikelyEmailAddress(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || /\s/.test(trimmed)) return false;
  const at = trimmed.indexOf("@");
  if (at <= 0 || at !== trimmed.lastIndexOf("@")) return false;
  const domain = trimmed.slice(at + 1);
  return domain.length > 0 && !domain.startsWith(".") && !domain.endsWith(".");
}

/** Digits only, clamped to the code length — paste of "123 456" still works. */
export function normalizeVerificationCode(value: string): string {
  return value.replace(/\D/g, "").slice(0, VERIFICATION_CODE_LENGTH);
}

export function isCompleteVerificationCode(value: string): boolean {
  return normalizeVerificationCode(value).length === VERIFICATION_CODE_LENGTH;
}

export function canSubmitSignIn(input: {
  readonly emailAddress: string;
  readonly password: string;
  readonly isSubmitting: boolean;
}): boolean {
  return (
    !input.isSubmitting && isLikelyEmailAddress(input.emailAddress) && input.password.length > 0
  );
}

export function canSubmitRegistration(input: {
  readonly emailAddress: string;
  readonly password: string;
  readonly isSubmitting: boolean;
}): boolean {
  return (
    !input.isSubmitting &&
    isLikelyEmailAddress(input.emailAddress) &&
    input.password.length >= MINIMUM_PASSWORD_LENGTH
  );
}

export function canSubmitPasswordReset(input: {
  readonly code: string;
  readonly password: string;
  readonly isSubmitting: boolean;
}): boolean {
  return (
    !input.isSubmitting &&
    isCompleteVerificationCode(input.code) &&
    input.password.length >= MINIMUM_PASSWORD_LENGTH
  );
}

/**
 * Seconds left on the resend cooldown. `null` for `sentAtMs` means nothing has
 * been sent yet, which is not a cooldown — the control is live.
 */
export function resolveResendCooldownSeconds(input: {
  readonly sentAtMs: number | null;
  readonly nowMs: number;
}): number {
  if (input.sentAtMs === null) return 0;
  const elapsedSeconds = Math.floor((input.nowMs - input.sentAtMs) / 1000);
  const remaining = VERIFICATION_RESEND_COOLDOWN_SECONDS - elapsedSeconds;
  return remaining > 0 ? remaining : 0;
}
