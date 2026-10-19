/**
 * Pure state derivation for the /register flow. The components own the Clerk
 * calls and the `window.setInterval` that drives the resend countdown; every
 * decision those callbacks make lives here so it can be tested without a
 * Clerk instance or a timer.
 */

/** Seconds a user must wait between `prepareEmailAddressVerification` calls. */
export const RESEND_COOLDOWN_SECONDS = 30;

/** Digits in the emailed verification code. */
export const VERIFICATION_CODE_LENGTH = 6;

/** Which half of the registration flow is on screen. */
export type RegisterStep = "details" | "verify";

/**
 * The instant the resend button unlocks, as an epoch millisecond timestamp.
 * Callers store this rather than a countdown so a backgrounded tab that misses
 * interval ticks still resolves to the correct remaining time on its next read.
 */
export function resendCooldownEndsAt(
  now: number,
  seconds: number = RESEND_COOLDOWN_SECONDS,
): number {
  return now + seconds * 1000;
}

/**
 * Whole seconds left on the cooldown, rounded up so the label never shows `0`
 * while the button is still locked. `null` means no cooldown is running.
 */
export function resendSecondsRemaining(cooldownEndsAt: number | null, now: number): number {
  if (cooldownEndsAt === null) return 0;
  const remaining = cooldownEndsAt - now;
  if (remaining <= 0) return 0;
  return Math.ceil(remaining / 1000);
}

/** True once the cooldown has elapsed and no request is already in flight. */
export function canResendCode({
  isBusy,
  secondsRemaining,
}: {
  readonly isBusy: boolean;
  readonly secondsRemaining: number;
}): boolean {
  return !isBusy && secondsRemaining <= 0;
}

/** Label for the resend control, counting down while the cooldown runs. */
export function resendButtonLabel(secondsRemaining: number): string {
  if (secondsRemaining <= 0) return "Resend code";
  return `Resend in ${secondsRemaining}s`;
}

/**
 * Keeps the code field to digits only and to the code length, so a pasted
 * "Your code is 123456" or a stray space cannot reach Clerk.
 */
export function normalizeVerificationCode(
  raw: string,
  length: number = VERIFICATION_CODE_LENGTH,
): string {
  return raw.replace(/\D/g, "").slice(0, length);
}

/** True when the field holds a full code and is worth submitting. */
export function isVerificationCodeComplete(
  code: string,
  length: number = VERIFICATION_CODE_LENGTH,
): boolean {
  return normalizeVerificationCode(code, length).length === length;
}

/**
 * Client-side guard before `signUp.create`. Deliberately shallow — Clerk owns
 * the real email and password policy, and its failures come back through
 * `clerkErrorMessage`. This only catches the empty and obviously-malformed
 * cases so an incomplete form does not cost a round trip.
 */
export function validateRegisterDetails({
  email,
  password,
}: {
  readonly email: string;
  readonly password: string;
}): string | null {
  const trimmed = email.trim();
  if (trimmed.length === 0) return "Enter your email address.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return "Enter a valid email address.";
  if (password.length === 0) return "Choose a password.";
  if (password.length < 8) return "Passwords need at least 8 characters.";
  return null;
}
