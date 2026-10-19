import { describe, expect, it } from "vite-plus/test";

import { relayJwtProviders } from "./relayIssuers.ts";

describe("relayJwtProviders", () => {
  it("keeps the configured primary JWKS and derives additional relay JWKS URLs", () => {
    expect(
      relayJwtProviders(
        "https://relay.spiritdevs.com/",
        "https://relay.spiritdevs.com/custom-jwks",
        " https://relay-dev-corey.spiritdevs.com/, https://relay-dev-corey.spiritdevs.com ",
      ),
    ).toEqual([
      {
        issuer: "https://relay.spiritdevs.com",
        jwks: "https://relay.spiritdevs.com/custom-jwks",
      },
      {
        issuer: "https://relay-dev-corey.spiritdevs.com",
        jwks: "https://relay-dev-corey.spiritdevs.com/.well-known/jwks.json",
      },
    ]);
  });
});
