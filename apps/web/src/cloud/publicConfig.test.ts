import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasClerkPublicConfig,
  hasCloudPublicConfig,
  hasCloudSyncPublicConfig,
  normalizeConvexDeploymentUrl,
  parsePublicFlag,
  resolveCloudSyncConvexUrl,
  resolveRelayClerkTokenOptions,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hasCloudPublicConfig", () => {
  it("requires all public cloud values", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "pathway-relay");
    expect(hasCloudPublicConfig()).toBe(false);

    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "https://relay.example.test");
    expect(hasCloudPublicConfig()).toBe(true);
  });

  it("rejects an insecure relay URL", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "pathway-relay");
    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "http://relay.example.test");

    expect(hasCloudPublicConfig()).toBe(false);
  });

  it("reports the missing Clerk JWT template as structured configuration", () => {
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");

    expect(() => resolveRelayClerkTokenOptions()).toThrowError(
      new CloudPublicConfigMissingError({ key: "PATHWAY_CLERK_JWT_TEMPLATE" }),
    );
  });
});

describe("parsePublicFlag", () => {
  it("reads only an explicit yes as on", () => {
    for (const on of ["1", "true", "TRUE", " on ", "yes"]) expect(parsePublicFlag(on)).toBe(true);
    for (const off of [undefined, "", "0", "false", "off", "no", "maybe"]) {
      expect(parsePublicFlag(off)).toBe(false);
    }
  });
});

describe("normalizeConvexDeploymentUrl", () => {
  it("keeps an https deployment origin and drops its path", () => {
    expect(normalizeConvexDeploymentUrl("https://example.convex.cloud/")).toBe(
      "https://example.convex.cloud",
    );
    expect(normalizeConvexDeploymentUrl("  https://example.convex.cloud/api  ")).toBe(
      "https://example.convex.cloud",
    );
  });

  it("allows plaintext only for a local deployment", () => {
    expect(normalizeConvexDeploymentUrl("http://127.0.0.1:3210")).toBe("http://127.0.0.1:3210");
    expect(normalizeConvexDeploymentUrl("http://example.convex.cloud")).toBeNull();
  });

  it("refuses anything that is not a plain deployment URL", () => {
    expect(normalizeConvexDeploymentUrl("")).toBeNull();
    expect(normalizeConvexDeploymentUrl("example.convex.cloud")).toBeNull();
    expect(normalizeConvexDeploymentUrl("ws://example.convex.cloud")).toBeNull();
    // Credentials in the URL would be sent on every request; a deployment URL never needs them.
    expect(normalizeConvexDeploymentUrl("https://user:pass@example.convex.cloud")).toBeNull();
  });
});

describe("hasCloudSyncPublicConfig", () => {
  const stubCloud = () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "pathway-relay");
    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "https://relay.example.test");
  };

  it("stays off until the flag, the Convex URL, and the rest of the cloud config are all present", () => {
    vi.stubEnv("VITE_PATHWAY_CLOUD_SYNC", "");
    vi.stubEnv("VITE_PATHWAY_CONVEX_URL", "");
    expect(hasCloudSyncPublicConfig()).toBe(false);
    expect(resolveCloudSyncConvexUrl()).toBeNull();

    stubCloud();
    expect(hasCloudSyncPublicConfig()).toBe(false);

    // The flag alone is not enough: without a deployment there is nothing to sync against.
    vi.stubEnv("VITE_PATHWAY_CLOUD_SYNC", "1");
    expect(hasCloudSyncPublicConfig()).toBe(false);

    vi.stubEnv("VITE_PATHWAY_CONVEX_URL", "https://example.convex.cloud");
    expect(hasCloudSyncPublicConfig()).toBe(true);
    expect(resolveCloudSyncConvexUrl()).toBe("https://example.convex.cloud");
  });

  it("stays off when the flag is absent even with a deployment configured", () => {
    stubCloud();
    vi.stubEnv("VITE_PATHWAY_CONVEX_URL", "https://example.convex.cloud");
    vi.stubEnv("VITE_PATHWAY_CLOUD_SYNC", "");

    expect(hasCloudSyncPublicConfig()).toBe(false);
    expect(resolveCloudSyncConvexUrl()).toBeNull();
  });

  it("stays off without the relay config the session depends on", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "");
    vi.stubEnv("VITE_PATHWAY_CLOUD_SYNC", "1");
    vi.stubEnv("VITE_PATHWAY_CONVEX_URL", "https://example.convex.cloud");

    expect(hasCloudSyncPublicConfig()).toBe(false);
  });
});

describe("hasClerkPublicConfig", () => {
  it("only requires the Clerk publishable key", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "");
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "");
    vi.stubEnv("VITE_PATHWAY_RELAY_URL", "");
    expect(hasClerkPublicConfig()).toBe(false);

    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", "pk_test_example");
    expect(hasClerkPublicConfig()).toBe(true);
    expect(hasCloudPublicConfig()).toBe(false);
  });
});
