import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  CloudPublicConfigMissingError,
  hasClerkPublicConfig,
  hasCloudPublicConfig,
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
