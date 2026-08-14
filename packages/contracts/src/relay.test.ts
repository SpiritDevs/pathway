import { describe, expect, it } from "vite-plus/test";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { COMPANY_PERMISSIONS } from "./company.ts";
import { RELAY_CONVEX_CONNECT_GRANT_PERMISSIONS, RelayApi } from "./relay.ts";

describe("relay Convex connect grants", () => {
  it("names permissions the company model actually grants", () => {
    // A grant asking for a permission no role can hold is unsatisfiable, and the
    // relay would reject every caller that presented one.
    for (const permission of RELAY_CONVEX_CONNECT_GRANT_PERMISSIONS) {
      expect(COMPANY_PERMISSIONS).toContain(permission);
    }
  });
});

describe("RelayApi security", () => {
  it("describes DPoP access tokens using the HTTP DPoP authorization scheme", () => {
    const document = OpenApi.fromApi(RelayApi);

    expect(document.components.securitySchemes?.relayDpop).toEqual({
      type: "http",
      scheme: "DPoP",
      description: "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
    });
  });
});
