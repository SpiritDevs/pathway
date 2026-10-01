import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { AppleCloudStatus, AppleIdSessionState, AppleRpcs, APPLE_WS_METHODS } from "./apple.ts";
const encodeStatus = Schema.encodeUnknownSync(AppleCloudStatus);
const encodeSession = Schema.encodeUnknownSync(AppleIdSessionState);
describe("Apple client contracts", () => {
  it("serializes only public metadata, even when server objects contain extra secret fields", () => {
    const secret = {
      privateKey: "DO_NOT_SEND_PRIVATE_KEY",
      cookie: "DO_NOT_SEND_COOKIE",
      token: "DO_NOT_SEND_JWT",
    };
    const response = encodeStatus({
      integration: {
        accountId: "account",
        teamId: "team",
        accountRevision: 1,
        connected: true,
        revision: 1,
        issuerId: "issuer",
        keyIdSuffix: "1234",
        lastVerifiedAt: 1,
        ...secret,
      },
      environments: [
        {
          environmentId: "environment",
          connected: true,
          revision: 1,
          leaseExpiresAt: 30_000,
          lastVerifiedAt: 1,
          error: null,
          ...secret,
        },
      ],
      ...secret,
    });
    expect(JSON.stringify(response)).not.toContain("DO_NOT_SEND");
    expect(encodeSession({ state: "authenticated", expiresAt: 1000, ...secret })).toEqual({
      state: "authenticated",
      expiresAt: 1000,
    });
  });
  it("exposes the Apple methods without a client credential retrieval RPC", () => {
    expect([...AppleRpcs.requests.keys()]).toEqual(
      expect.arrayContaining(Object.values(APPLE_WS_METHODS)),
    );
    expect(
      [...AppleRpcs.requests.keys()].some((method) =>
        /credential|privateKey|cookie/iu.test(method),
      ),
    ).toBe(false);
  });
});
