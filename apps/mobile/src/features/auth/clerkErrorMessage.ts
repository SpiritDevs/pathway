/**
 * Maps Clerk API failures to user-facing copy. The Clerk SDK rejects with a
 * `{ errors: [{ code, message, longMessage }] }` shape; anything else falls
 * back to the caller's message. Keep codes here — sign-in, registration, and
 * the onboarding stepper all read from this table so the error voice stays
 * uniform.
 *
 * Ported from `apps/web/src/components/auth/clerkErrorMessage.ts`. Both copies
 * belong in `@spiritdevs/client-runtime` eventually; until that move happens the
 * table is duplicated rather than imported across app boundaries.
 */
const CLERK_ERROR_COPY: Record<string, string> = {
  form_identifier_not_found: "No account exists with that email.",
  form_password_incorrect: "That password is incorrect.",
  form_identifier_exists: "An account with that email already exists. Try signing in.",
  form_password_pwned: "That password has appeared in a data breach. Choose a different password.",
  form_password_length_too_short: "Passwords need at least 8 characters.",
  form_password_validation_failed: "That password is incorrect.",
  form_code_incorrect: "That code is not right. Check the email and try again.",
  verification_expired: "That code has expired. Send a new one.",
  verification_failed: "Verification failed. Send a new code and try again.",
  too_many_requests: "Too many attempts. Wait a moment before trying again.",
  session_exists: "You are already signed in.",
  captcha_invalid: "We could not confirm you are human. Close the app and try again.",
  user_locked: "This account is locked from too many failed attempts. Try again later.",
};

interface ClerkApiErrorLike {
  readonly code?: string;
  readonly message?: string;
  readonly longMessage?: string;
}

function firstClerkError(error: unknown): ClerkApiErrorLike | null {
  if (typeof error !== "object" || error === null) return null;
  const errors = (error as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const first: unknown = errors[0];
  return typeof first === "object" && first !== null ? (first as ClerkApiErrorLike) : null;
}

export function clerkErrorMessage(error: unknown, fallback: string): string {
  const apiError = firstClerkError(error);
  if (!apiError) return fallback;
  const known = apiError.code ? CLERK_ERROR_COPY[apiError.code] : undefined;
  return known ?? apiError.longMessage ?? apiError.message ?? fallback;
}
