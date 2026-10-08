import { assert, describe, it } from "@effect/vitest";

import { resolveLocalCyndrbaseEnvironment } from "./local-cyndrbase.ts";

const clerkKey = `pk_test_${btoa("witty-mole-42.clerk.accounts.dev$")}`;

describe("resolveLocalCyndrbaseEnvironment", () => {
  it("derives the deployment's issuers from the clients' public config", () => {
    assert.deepStrictEqual(
      resolveLocalCyndrbaseEnvironment({
        PATHWAY_CLERK_PUBLISHABLE_KEY: clerkKey,
        PATHWAY_RELAY_URL: "https://relay.example.test/",
        RESEND_API_KEY: "re_secret",
      }),
      {
        values: {
          CLERK_JWT_ISSUER_DOMAIN: "https://witty-mole-42.clerk.accounts.dev",
          PATHWAY_RELAY_JWT_ISSUER: "https://relay.example.test",
          PATHWAY_RELAY_JWKS_URL: "https://relay.example.test/.well-known/jwks.json",
        },
        secrets: { RESEND_API_KEY: "re_secret" },
      },
    );
  });

  it("lets explicit deployment values win", () => {
    const resolved = resolveLocalCyndrbaseEnvironment({
      PATHWAY_CLERK_PUBLISHABLE_KEY: clerkKey,
      CLERK_JWT_ISSUER_DOMAIN: "https://clerk.example.test",
      PATHWAY_RELAY_URL: "https://relay.example.test",
      PATHWAY_RELAY_JWT_ISSUER: "https://relay.local.test",
      PATHWAY_RELAY_JWKS_URL: "data:application/json;base64,e30=",
      PATHWAY_RELAY_JWT_ADDITIONAL_ISSUERS: "https://second.example.test",
    });
    assert.deepStrictEqual(resolved?.values, {
      CLERK_JWT_ISSUER_DOMAIN: "https://clerk.example.test",
      PATHWAY_RELAY_JWT_ISSUER: "https://relay.local.test",
      PATHWAY_RELAY_JWKS_URL: "data:application/json;base64,e30=",
      PATHWAY_RELAY_JWT_ADDITIONAL_ISSUERS: "https://second.example.test",
    });
  });

  it("starts nothing when cloud sync has no Clerk or relay", () => {
    assert.isUndefined(resolveLocalCyndrbaseEnvironment({ PATHWAY_RELAY_URL: "https://r.test" }));
    assert.isUndefined(
      resolveLocalCyndrbaseEnvironment({ PATHWAY_CLERK_PUBLISHABLE_KEY: clerkKey }),
    );
    assert.isUndefined(
      resolveLocalCyndrbaseEnvironment({
        PATHWAY_CLERK_PUBLISHABLE_KEY: "pk_test_%",
        PATHWAY_RELAY_URL: "https://r.test",
      }),
    );
  });
});
