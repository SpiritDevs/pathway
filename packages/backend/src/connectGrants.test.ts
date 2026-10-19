import { describe, expect, it } from "vite-plus/test";

import {
  checkConnectGrantValidity,
  connectGrantExpiresAt,
  CONNECT_GRANT_TOKEN_BYTES,
  CONNECT_GRANT_TTL_MS,
  generateConnectGrantToken,
  hashConnectGrantToken,
  type ConnectGrantValidityInput,
} from "./connectGrants.ts";

const NOW = 1_700_000_000_000;

describe("connect grant token handling", () => {
  it("generates 32-byte opaque tokens and stores a stable SHA-256 digest", async () => {
    const first = generateConnectGrantToken();
    const second = generateConnectGrantToken();

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
    expect(CONNECT_GRANT_TOKEN_BYTES).toBe(32);
    expect(await hashConnectGrantToken(first)).toBe(await hashConnectGrantToken(first));
    expect(await hashConnectGrantToken(first)).not.toBe(first);
  });

  it("matches the SHA-256 vector for a known token", async () => {
    expect(await hashConnectGrantToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("expires grants exactly sixty seconds after issue", () => {
    expect(CONNECT_GRANT_TTL_MS).toBe(60_000);
    expect(connectGrantExpiresAt(NOW)).toBe(NOW + 60_000);
  });
});

describe("checkConnectGrantValidity", () => {
  const valid: ConnectGrantValidityInput = {
    grant: { expiresAt: NOW + 1, consumedAt: null },
    companyActive: true,
    registrationState: "active",
    membership: { state: "active", permissionHeld: true },
  };

  it("accepts an unconsumed grant while every linked authorization source is active", () => {
    expect(checkConnectGrantValidity(valid, NOW)).toBeNull();
  });

  it("treats the expiry instant and any consumption marker as invalid", () => {
    expect(checkConnectGrantValidity(valid, NOW + 1)).toBe("expired");
    expect(
      checkConnectGrantValidity({ ...valid, grant: { ...valid.grant, consumedAt: NOW } }, NOW),
    ).toBe("consumed");
  });

  it("invalidates grants when their company or registration is no longer active", () => {
    expect(checkConnectGrantValidity({ ...valid, companyActive: false }, NOW)).toBe(
      "company-inactive",
    );
    expect(checkConnectGrantValidity({ ...valid, registrationState: "revoked" }, NOW)).toBe(
      "registration-inactive",
    );
    expect(checkConnectGrantValidity({ ...valid, registrationState: null }, NOW)).toBe(
      "registration-inactive",
    );
  });

  it("invalidates grants when membership or its asserted permission is revoked", () => {
    expect(checkConnectGrantValidity({ ...valid, membership: null }, NOW)).toBe(
      "membership-inactive",
    );
    expect(
      checkConnectGrantValidity(
        { ...valid, membership: { state: "locked", permissionHeld: true } },
        NOW,
      ),
    ).toBe("membership-inactive");
    expect(
      checkConnectGrantValidity(
        { ...valid, membership: { state: "active", permissionHeld: false } },
        NOW,
      ),
    ).toBe("permission-revoked");
  });
});
