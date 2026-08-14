import { describe, expect, it } from "vite-plus/test";

import {
  checkInvitationAcceptable,
  generateInvitationToken,
  hashInvitationToken,
  INVITATION_TTL_MS,
  invitationDeliveryIdempotencyKey,
  invitationExpiresAt,
  isInvitationExpired,
  normalizeEmail,
} from "./invitations.ts";

const NOW = 1_700_000_000_000;

describe("normalizeEmail", () => {
  it("trims and lower-cases so an invite matches the identity that accepts it", () => {
    expect(normalizeEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });
});

describe("hashInvitationToken", () => {
  it("matches the SHA-256 vector for a known input", async () => {
    expect(await hashInvitationToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is stable and 64 hex characters wide", async () => {
    const token = generateInvitationToken();
    const first = await hashInvitationToken(token);
    const second = await hashInvitationToken(token);

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not reveal the token", async () => {
    const token = generateInvitationToken();
    expect(await hashInvitationToken(token)).not.toBe(token);
  });

  it("separates distinct tokens", async () => {
    const [a, b] = [generateInvitationToken(), generateInvitationToken()];
    expect(a).not.toBe(b);
    expect(await hashInvitationToken(a)).not.toBe(await hashInvitationToken(b));
  });
});

describe("generateInvitationToken", () => {
  it("produces 32 bytes of hex", () => {
    expect(generateInvitationToken()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("expiry", () => {
  it("expires seven days out", () => {
    expect(invitationExpiresAt(NOW)).toBe(NOW + INVITATION_TTL_MS);
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("treats the expiry instant itself as expired", () => {
    expect(isInvitationExpired(NOW, NOW - 1)).toBe(false);
    expect(isInvitationExpired(NOW, NOW)).toBe(true);
  });
});

describe("invitationDeliveryIdempotencyKey", () => {
  it("changes only when the delivery attempt does", () => {
    expect(invitationDeliveryIdempotencyKey("inv-1", 0)).toBe("company-invite/inv-1/0");
    expect(invitationDeliveryIdempotencyKey("inv-1", 0)).toBe(
      invitationDeliveryIdempotencyKey("inv-1", 0),
    );
    expect(invitationDeliveryIdempotencyKey("inv-1", 1)).not.toBe(
      invitationDeliveryIdempotencyKey("inv-1", 0),
    );
  });
});

describe("checkInvitationAcceptable", () => {
  const pending = { state: "pending", email: "ada@example.com", expiresAt: NOW + 1000 } as const;
  const verified = { email: "Ada@Example.com", emailVerified: true };

  it("accepts a pending invitation for the matching verified email", () => {
    expect(checkInvitationAcceptable(pending, verified, NOW)).toBeNull();
  });

  it("rejects a missing, revoked, or already-consumed invitation", () => {
    expect(checkInvitationAcceptable(null, verified, NOW)).toBe("invitation-not-found");
    expect(checkInvitationAcceptable({ ...pending, state: "revoked" }, verified, NOW)).toBe(
      "invitation-revoked",
    );
    expect(checkInvitationAcceptable({ ...pending, state: "accepted" }, verified, NOW)).toBe(
      "invitation-consumed",
    );
  });

  it("rejects an invitation past its expiry even while still marked pending", () => {
    expect(checkInvitationAcceptable(pending, verified, NOW + 5000)).toBe("invitation-expired");
  });

  it("binds acceptance to the verified email", () => {
    expect(
      checkInvitationAcceptable(pending, { email: "grace@example.com", emailVerified: true }, NOW),
    ).toBe("invitation-email-mismatch");
    expect(
      checkInvitationAcceptable(pending, { email: "ada@example.com", emailVerified: false }, NOW),
    ).toBe("invitation-email-unverified");
  });
});
