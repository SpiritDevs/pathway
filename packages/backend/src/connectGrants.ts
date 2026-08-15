/**
 * Short-lived bearer tokens for authorizing a relay connection to one environment.
 *
 * @module connectGrants
 */

/** One minute limits replay exposure while leaving enough time for one interactive connect. */
export const CONNECT_GRANT_TTL_MS = 60_000;

/** 32 bytes of entropy, hex-encoded; Convex stores only its SHA-256 digest. */
export const CONNECT_GRANT_TOKEN_BYTES = 32;

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/** Generates the plaintext bearer token returned once to the issuing client. */
export function generateConnectGrantToken(): string {
  const bytes = new Uint8Array(CONNECT_GRANT_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Hashes a bearer token before storage or relay-side validation lookup. */
export async function hashConnectGrantToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return toHex(new Uint8Array(digest));
}

export function connectGrantExpiresAt(issuedAt: number): number {
  return issuedAt + CONNECT_GRANT_TTL_MS;
}

export type ConnectGrantInvalidReason =
  | "expired"
  | "consumed"
  | "company-inactive"
  | "registration-inactive"
  | "membership-inactive"
  | "permission-revoked";

export interface ConnectGrantValidityInput {
  readonly grant: {
    readonly expiresAt: number;
    readonly consumedAt: number | null;
  };
  readonly companyActive: boolean;
  readonly registrationState: "active" | "revoked" | null;
  readonly membership: {
    readonly state: "active" | "locked" | "left";
    readonly permissionHeld: boolean;
  } | null;
}

/**
 * Evaluates every revocable input to grant consumption without exposing the reason to callers.
 * The Convex mutation collapses these diagnostic values into one uniform refusal shape.
 */
export function checkConnectGrantValidity(
  input: ConnectGrantValidityInput,
  now: number,
): ConnectGrantInvalidReason | null {
  if (now >= input.grant.expiresAt) return "expired";
  if (input.grant.consumedAt !== null) return "consumed";
  if (!input.companyActive) return "company-inactive";
  if (input.registrationState !== "active") return "registration-inactive";
  if (input.membership?.state !== "active") return "membership-inactive";
  if (!input.membership.permissionHeld) return "permission-revoked";
  return null;
}
