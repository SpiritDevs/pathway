import { describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasTracingPublicConfig,
  resolveCloudPublicConfig,
  resolveConvexClerkTokenOptions,
  resolveRelayClerkTokenOptions,
} from "./publicConfig";

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {},
    },
  },
}));

describe("resolveCloudPublicConfig", () => {
  it("reports the missing Clerk JWT template as structured configuration", () => {
    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "PATHWAY_CLERK_JWT_TEMPLATE" }),
    );
  });

  it("returns no cloud configuration for an unconfigured build", () => {
    expect(resolveCloudPublicConfig({})).toEqual({
      clerk: {
        publishableKey: null,
        jwtTemplate: null,
      },
      relay: {
        url: null,
      },
      convex: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("normalizes statically injected cloud configuration", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "  pk_test_example  ", jwtTemplate: "  pathway-relay  " },
        relay: { url: " https://relay.example.test/// " },
        convex: { url: " https://example.convex.cloud/some-path " },
        observability: {
          tracesUrl: " https://api.axiom.co/v1/traces ",
          tracesDataset: " mobile-traces ",
          tracesToken: " public-ingest-token ",
        },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "pathway-relay",
      },
      relay: {
        url: "https://relay.example.test",
      },
      convex: {
        url: "https://example.convex.cloud",
      },
      observability: {
        tracesUrl: "https://api.axiom.co/v1/traces",
        tracesDataset: "mobile-traces",
        tracesToken: "public-ingest-token",
      },
    });
  });

  it("rejects an insecure relay URL", () => {
    expect(
      resolveCloudPublicConfig({
        clerk: { publishableKey: "pk_test_example", jwtTemplate: "pathway-relay" },
        relay: { url: "http://relay.example.test" },
        convex: { url: "http://example.convex.cloud" },
      }),
    ).toEqual({
      clerk: {
        publishableKey: "pk_test_example",
        jwtTemplate: "pathway-relay",
      },
      relay: {
        url: null,
      },
      convex: {
        url: null,
      },
      observability: {
        tracesUrl: null,
        tracesDataset: null,
        tracesToken: null,
      },
    });
  });

  it("uses the Convex Clerk JWT template for workspace provisioning", () => {
    expect(resolveConvexClerkTokenOptions()).toEqual({ template: "convex" });
  });

  it("rejects an insecure traces URL", () => {
    expect(
      resolveCloudPublicConfig({
        observability: {
          tracesUrl: "http://api.axiom.co/v1/traces",
          tracesDataset: "mobile-traces",
          tracesToken: "public-ingest-token",
        },
      }).observability,
    ).toEqual({
      tracesUrl: null,
      tracesDataset: "mobile-traces",
      tracesToken: "public-ingest-token",
    });
  });

  it("keeps tracing disabled unless every public tracing value is configured", () => {
    expect(hasTracingPublicConfig(resolveCloudPublicConfig({}))).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
          },
        }),
      ),
    ).toBe(false);
    expect(
      hasTracingPublicConfig(
        resolveCloudPublicConfig({
          observability: {
            tracesUrl: "https://api.axiom.co/v1/traces",
            tracesDataset: "mobile-traces",
            tracesToken: "public-ingest-token",
          },
        }),
      ),
    ).toBe(true);
  });
});
