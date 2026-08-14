/**
 * Invitation token handling. The plaintext token exists only in the emailed link: Convex stores
 * the SHA-256 hash, so a database read never yields something that can accept an invitation.
 *
 * @module invitations
 */

export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 32 bytes of entropy, hex-encoded — the whole secret of the acceptance link. */
export const INVITATION_TOKEN_BYTES = 32;

export const INVITATION_STATES = ["pending", "accepted", "revoked", "expired"] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

/**
 * The one normalization both the invitation and the accepting Clerk identity pass through, so an
 * invite addressed to `Ada@Example.com ` is accepted by `ada@example.com` and nothing else.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Web Crypto rather than `node:crypto`: this runs in the Convex isolate as well as in tests. */
export function generateInvitationToken(): string {
  const bytes = new Uint8Array(INVITATION_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export async function hashInvitationToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function invitationExpiresAt(now: number): number {
  return now + INVITATION_TTL_MS;
}

export function isInvitationExpired(expiresAt: number, now: number): boolean {
  return now >= expiresAt;
}

/**
 * Resend deduplicates on this key, so a retried delivery of the same attempt never sends twice
 * while a deliberate resend — which bumps the attempt — always does.
 *
 * @see https://resend.com/docs/dashboard/emails/idempotency-keys
 */
export function invitationDeliveryIdempotencyKey(
  invitationId: string,
  deliveryAttempt: number,
): string {
  return `company-invite/${invitationId}/${deliveryAttempt}`;
}

export type InvitationAcceptanceRejection =
  | "invitation-not-found"
  | "invitation-expired"
  | "invitation-consumed"
  | "invitation-revoked"
  | "invitation-email-mismatch"
  | "invitation-email-unverified";

export interface InvitationRecordView {
  readonly state: InvitationState;
  readonly email: string;
  readonly expiresAt: number;
}

export interface AcceptingIdentity {
  readonly email: string;
  readonly emailVerified: boolean;
}

/**
 * The whole acceptance gate, minus the transaction. Returns `null` when acceptance may proceed.
 */
export function checkInvitationAcceptable(
  invitation: InvitationRecordView | null,
  identity: AcceptingIdentity,
  now: number,
): InvitationAcceptanceRejection | null {
  if (invitation === null) return "invitation-not-found";
  if (invitation.state === "revoked") return "invitation-revoked";
  if (invitation.state === "accepted") return "invitation-consumed";
  if (invitation.state === "expired" || isInvitationExpired(invitation.expiresAt, now)) {
    return "invitation-expired";
  }
  if (!identity.emailVerified) return "invitation-email-unverified";
  if (normalizeEmail(identity.email) !== normalizeEmail(invitation.email)) {
    return "invitation-email-mismatch";
  }
  return null;
}
