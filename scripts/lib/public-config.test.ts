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
    expect(env.PATHWAY_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.VITE_CLERK_JWT_TEMPLATE).toBeUndefined();
    expect(env.PATHWAY_RELAY_URL).toBeUndefined();
    expect(env.VITE_PATHWAY_RELAY_URL).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_URL).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_DATASET).toBeUndefined();
    expect(env.VITE_RELAY_OTLP_TRACES_TOKEN).toBeUndefined();
  });

  it("applies process, local, and base precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_root\nPATHWAY_CLERK_JWT_TEMPLATE=template_root\nPATHWAY_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nPATHWAY_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.prod"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_prod\nPATHWAY_CLERK_JWT_TEMPLATE=template_prod\nPATHWAY_CLERK_CLI_OAUTH_CLIENT_ID=oauth_prod\nPATHWAY_RELAY_URL=https://prod.example.test\nPATHWAY_CONVEX_URL=https://prod.convex.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_local\nPATHWAY_CLERK_JWT_TEMPLATE=template_local\nPATHWAY_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nPATHWAY_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).PATHWAY_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).PATHWAY_CONVEX_URL).toBeUndefined();
    expect(
      loadRepoEnv({ baseEnv: {}, includeProductionEnv: true, repoRoot }).PATHWAY_CONVEX_URL,
    ).toBe("https://prod.convex.test");
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
      PATHWAY_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      PATHWAY_RELAY_URL: "https://ci.example.test",
      VITE_PATHWAY_RELAY_URL: "https://ci.example.test",
    });
  });

  it("uses a primary checkout as fallback for worktree production credentials", () => {
    const primaryRepoRoot = makeTemporaryDirectory();
    const worktreeRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(primaryRepoRoot, ".env.prod"),
      "PATHWAY_CLERK_PUBLISHABLE_KEY=pk_primary\nPATHWAY_CLERK_JWT_TEMPLATE=template_primary\nPATHWAY_CONVEX_URL=https://primary.convex.test\nPATHWAY_RELAY_URL=https://primary.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(worktreeRoot, ".env.prod"),
      "PATHWAY_RELAY_URL=https://worktree.example.test\n",
    );

    expect(
      loadRepoEnv({
        baseEnv: {},
        fallbackRepoRoot: primaryRepoRoot,
        includeProductionEnv: true,
        repoRoot: worktreeRoot,
      }),
    ).toMatchObject({
      PATHWAY_CLERK_PUBLISHABLE_KEY: "pk_primary",
      PATHWAY_CLERK_JWT_TEMPLATE: "template_primary",
      PATHWAY_CONVEX_URL: "https://primary.convex.test",
      PATHWAY_RELAY_URL: "https://worktree.example.test",
    });
  });

  it("accepts legacy framework aliases as root overrides", () => {
    expect(
      resolvePublicConfig({
        VITE_CLERK_PUBLISHABLE_KEY: "pk_legacy",
        VITE_CLERK_JWT_TEMPLATE: "template_legacy",
        PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_canonical",
        VITE_PATHWAY_RELAY_URL: "https://legacy.example.test",
      }),
    ).toEqual({
      clerkPublishableKey: "pk_legacy",
      clerkJwtTemplate: "template_legacy",
      clerkCliOAuthClientId: "oauth_canonical",
      relayUrl: "https://legacy.example.test",
      relayClientOtlpTracesUrl: undefined,
      relayClientOtlpTracesDataset: undefined,
      relayClientOtlpTracesToken: undefined,
    });
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
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
