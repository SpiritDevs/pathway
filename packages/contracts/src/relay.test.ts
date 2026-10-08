import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as OpenApi from "effect/unstable/httpapi/OpenApi";

import { COMPANY_PERMISSIONS } from "./company.ts";
import {
  RELAY_CONVEX_CONNECT_GRANT_PERMISSIONS,
  RelayApi,
  RelayDeviceRegistrationRequest,
  RelayEnvironmentDpopAccessTokenRequest,
  RelayManagedEndpointProviderKind,
  RelayManagedEndpointRuntimeConfig,
} from "./relay.ts";

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

  it("exposes a distinct environment token exchange with a fixed connect-only client", () => {
    const document = OpenApi.fromApi(RelayApi);
    expect(document.paths["/v1/environment/dpop-token"]?.post).toBeDefined();

    const decode = Schema.decodeUnknownSync(RelayEnvironmentDpopAccessTokenRequest);
    expect(
      decode({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "signed-environment-assertion",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        resource: "https://relay.example.test",
        scope: "environment:connect",
        client_id: "pathway-env",
      }),
    ).toMatchObject({ client_id: "pathway-env", scope: "environment:connect" });
    expect(() =>
      decode({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        subject_token: "signed-environment-assertion",
        subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        resource: "https://relay.example.test",
        scope: "environment:status",
        client_id: "pathway-env",
      }),
    ).toThrow();
  });
});

describe("native notification device platforms", () => {
  const preferences = {
    liveActivitiesEnabled: false,
    notificationsEnabled: true,
    notifyOnApproval: true,
    notifyOnInput: true,
    notifyOnCompletion: true,
    notifyOnFailure: true,
  };
  const device = {
    deviceId: "vision-device",
    label: "Vision Pro",
    platform: "visionos",
    iosMajorVersion: 26,
    pushToken: "notification-token",
    preferences,
  };

  it("accepts visionOS notifications while preserving the OS-version wire field", () => {
    const decode = Schema.decodeUnknownSync(RelayDeviceRegistrationRequest);
    expect(decode(device)).toMatchObject({ platform: "visionos", iosMajorVersion: 26 });
    expect(decode({ ...device, platform: "ios", iosMajorVersion: 18 })).toMatchObject({
      platform: "ios",
      iosMajorVersion: 18,
    });
  });

  it("rejects visionOS Live Activity preferences and push-to-start tokens", () => {
    const decode = Schema.decodeUnknownSync(RelayDeviceRegistrationRequest);
    expect(() =>
      decode({ ...device, preferences: { ...preferences, liveActivitiesEnabled: true } }),
    ).toThrow("Live Activities are not supported on visionOS");
    expect(() => decode({ ...device, pushToStartToken: "unsupported" })).toThrow(
      "Live Activities are not supported on visionOS",
    );
  });
});

// The runtime config as servers before Cyndrbase Connect decode it.
const decodePreConnect = Schema.decodeUnknownSync(
  Schema.Struct({
    environmentId: Schema.String,
    providerKind: RelayManagedEndpointProviderKind,
    connectorToken: Schema.String,
    tunnelId: Schema.optional(Schema.String),
    tunnelName: Schema.optional(Schema.String),
  }),
);
const decodeRuntimeConfig = Schema.decodeUnknownSync(RelayManagedEndpointRuntimeConfig);

describe("managed endpoint runtime config across versions", () => {
  const connect = {
    environmentId: "environment-1",
    providerKind: "pathway_relay",
    connectorToken: "connector-token",
    edgeUrl: "wss://edge.example.test/connect/v1",
    endpointId: "endpoint-1",
  } as const;
  const cloudflared = {
    environmentId: "environment-1",
    providerKind: "cloudflare_tunnel",
    connectorToken: "cloudflared-token",
    tunnelId: "tunnel-1",
    tunnelName: "tunnel-name",
  } as const;

  it("lets older servers decode a Connect config they will not run", () => {
    expect(decodePreConnect(connect).providerKind).toBe("pathway_relay");
  });

  it("decodes a stored cloudflared config without Connect fields", () => {
    const decoded = decodeRuntimeConfig(cloudflared);
    expect(decoded.edgeUrl).toBeUndefined();
    expect(decoded.endpointId).toBeUndefined();
  });
});
