// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv, resolvePublicConfig } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("does not project cloud configuration for an unconfigured clone", () => {
    const env = loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() });

    expect(env.PATHWAY_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID).toBeUndefined();
    expect(env.VITE_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY).toBeUndefined();
    expect(env.PATHWAY_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.EXPO_PUBLIC_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.PATHWAY_RELAY_URL).toBeUndefined();
    expect(env.VITE_PATHWAY_RELAY_URL).toBeUndefined();
    expect(env.PATHWAY_MOBILE_OTLP_TRACES_URL).toBeUndefined();
    expect(env.PATHWAY_MOBILE_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.PATHWAY_MOBILE_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_URL).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.EXPO_PUBLIC_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_root\nPATHWAY_CLERK_JWT_TEMPLATE=template_root\nPATHWAY_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nPATHWAY_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_local\nPATHWAY_CLERK_JWT_TEMPLATE=template_local\nPATHWAY_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nPATHWAY_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).PATHWAY_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          PATHWAY_CLERK_PUBLISHABLE_KEY: "pk_ci",
          PATHWAY_CLERK_JWT_TEMPLATE: "template_ci",
          PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          PATHWAY_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      PATHWAY_CLERK_PUBLISHABLE_KEY: "pk_ci",
      PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      PATHWAY_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      PATHWAY_RELAY_URL: "https://ci.example.test",
      VITE_PATHWAY_RELAY_URL: "https://ci.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_PATHWAY_RELAY_URL: "https://legacy.example.test",
        EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
        EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
        EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      mobileOtlpTracesUrl: "https://api.axiom.co/v1/traces",
      mobileOtlpTracesDataset: "mobile-traces",
      mobileOtlpTracesToken: "mobile-token",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
  });

  /**
   * The cloud-sync knob is the only one whose two consumers parse the value rather than pass it
   * along: the deployment half (Convex's `requireCloudSyncEnabled`, the server daemon) demands
   * exactly `"enabled"`, while the web build reads a boolean flag. Projecting the operator's string
   * verbatim to both names could only ever satisfy one of them, so it is normalized here.
   */
  it("normalizes every affirmative spelling so one knob enables both halves", () => {
    /** Restates the deployment-side gate: apps/server syncDaemon and convex/lib/capability. */
    const deploymentGateAccepts = (value: string | undefined) => value?.trim() === "enabled";
    /** Restates apps/web/src/cloud/publicConfig.ts `parseCloudSyncFlag`. */
    const webGateAccepts = (value: string | undefined) =>
      ["enabled", "1", "true", "on", "yes"].includes(value?.trim().toLowerCase() ?? "");

    for (const written of ["enabled", "true", "1", "yes", "ON"]) {
      const env = loadRepoEnv({
        baseEnv: { PATHWAY_CLOUD_SYNC: written },
        repoRoot: makeTemporaryDirectory(),
      });

      expect(deploymentGateAccepts(env.PATHWAY_CLOUD_SYNC)).toBe(true);
      expect(webGateAccepts(env.VITE_PATHWAY_CLOUD_SYNC)).toBe(true);
    }

    // An operator who writes the VITE_ spelling instead gets the same pair back.
    const fromViteSpelling = loadRepoEnv({
      baseEnv: { VITE_PATHWAY_CLOUD_SYNC: "true" },
      repoRoot: makeTemporaryDirectory(),
    });
    expect(deploymentGateAccepts(fromViteSpelling.PATHWAY_CLOUD_SYNC)).toBe(true);
    expect(webGateAccepts(fromViteSpelling.VITE_PATHWAY_CLOUD_SYNC)).toBe(true);

    // Off stays off at both ends, in the operator's own wording.
    const off = loadRepoEnv({
      baseEnv: { PATHWAY_CLOUD_SYNC: "false" },
      repoRoot: makeTemporaryDirectory(),
    });
    expect(off.PATHWAY_CLOUD_SYNC).toBe("false");
    expect(deploymentGateAccepts(off.PATHWAY_CLOUD_SYNC)).toBe(false);
    expect(webGateAccepts(off.VITE_PATHWAY_CLOUD_SYNC)).toBe(false);
  });

  it("projects canonical relay client tracing values to web build aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET: "relay-client-traces",
      PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN: "relay-client-token",
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "relay-client-traces",
      VITE_RELAY_OTLP_TRACES_TOKEN: "relay-client-token",
    });
  });

  it("projects canonical mobile tracing values to Expo public aliases", () => {
    expect(
      loadRepoEnv({
        baseEnv: {
          PATHWAY_RELAY_URL: "https://relay.example.test",
          PATHWAY_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
          PATHWAY_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
          PATHWAY_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
        },
        repoRoot: makeTemporaryDirectory(),
      }),
    ).toEqual({
      PATHWAY_RELAY_URL: "https://relay.example.test",
      VITE_PATHWAY_RELAY_URL: "https://relay.example.test",
      PATHWAY_MOBILE_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      PATHWAY_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
      PATHWAY_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "mobile-traces",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "mobile-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
