// @effect-diagnostics nodeBuiltinImport:off - Build bootstrap reads optional root env files before an Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export interface PathwayPublicConfig {
  readonly clerkPublishableKey: string | undefined;
  readonly clerkJwtTemplate: string | undefined;
  readonly clerkCliOAuthClientId: string | undefined;
  readonly relayUrl: string | undefined;
  /** Convex deployment the always-on cloud-sync engine talks to. */
  readonly convexUrl: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  fallbackRepoRoot,
  includeProductionEnv = false,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly fallbackRepoRoot?: string;
  readonly includeProductionEnv?: boolean;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const fallbackRootEnv = fallbackRepoRoot
    ? readEnvFile(NodePath.join(fallbackRepoRoot, ".env"))
    : {};
  const fallbackProductionEnv =
    fallbackRepoRoot && includeProductionEnv
      ? readEnvFile(NodePath.join(fallbackRepoRoot, ".env.prod"))
      : {};
  const fallbackLocalEnv = fallbackRepoRoot
    ? readEnvFile(NodePath.join(fallbackRepoRoot, ".env.local"))
    : {};
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const productionEnv = includeProductionEnv
    ? readEnvFile(NodePath.join(repoRoot, ".env.prod"))
    : {};
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(
    baseEnv,
    localEnv,
    productionEnv,
    rootEnv,
    fallbackLocalEnv,
    fallbackProductionEnv,
    fallbackRootEnv,
  );
  return {
    ...fallbackRootEnv,
    ...fallbackProductionEnv,
    ...fallbackLocalEnv,
    ...rootEnv,
    ...productionEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          PATHWAY_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          PATHWAY_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
        }
      : {}),
    ...(config.clerkCliOAuthClientId
      ? {
          PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
          VITE_CLERK_CLI_OAUTH_CLIENT_ID: config.clerkCliOAuthClientId,
        }
      : {}),
    ...(config.relayUrl
      ? {
          PATHWAY_RELAY_URL: config.relayUrl,
          VITE_PATHWAY_RELAY_URL: config.relayUrl,
        }
      : {}),
    ...(config.convexUrl
      ? {
          PATHWAY_CONVEX_URL: config.convexUrl,
          VITE_PATHWAY_CONVEX_URL: config.convexUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesUrl
      ? {
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
          VITE_RELAY_OTLP_TRACES_URL: config.relayClientOtlpTracesUrl,
        }
      : {}),
    ...(config.relayClientOtlpTracesDataset
      ? {
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
          VITE_RELAY_OTLP_TRACES_DATASET: config.relayClientOtlpTracesDataset,
        }
      : {}),
    ...(config.relayClientOtlpTracesToken
      ? {
          PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
          VITE_RELAY_OTLP_TRACES_TOKEN: config.relayClientOtlpTracesToken,
        }
      : {}),
  };
}

export function resolvePublicConfig(...sources: readonly Environment[]): PathwayPublicConfig {
  return {
    clerkPublishableKey: firstNonEmpty(
      sources,
      "PATHWAY_CLERK_PUBLISHABLE_KEY",
      "VITE_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "PATHWAY_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "PATHWAY_RELAY_URL", "VITE_PATHWAY_RELAY_URL"),
    convexUrl: firstNonEmpty(sources, "PATHWAY_CONVEX_URL", "VITE_PATHWAY_CONVEX_URL"),
    relayClientOtlpTracesUrl: firstNonEmpty(
      sources,
      "PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL",
      "VITE_RELAY_OTLP_TRACES_URL",
    ),
    relayClientOtlpTracesDataset: firstNonEmpty(
      sources,
      "PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET",
      "VITE_RELAY_OTLP_TRACES_DATASET",
    ),
    relayClientOtlpTracesToken: firstNonEmpty(
      sources,
      "PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN",
      "VITE_RELAY_OTLP_TRACES_TOKEN",
    ),
  };
}

function firstNonEmpty(sources: readonly Environment[], ...names: readonly string[]) {
  for (const source of sources) {
    for (const name of names) {
      const value = source[name]?.trim();
      if (value) {
        return value;
      }
    }
  }
  return undefined;
}

function readEnvFile(path: string): Record<string, string | undefined> {
  return NodeFS.existsSync(path) ? NodeUtil.parseEnv(NodeFS.readFileSync(path, "utf8")) : {};
}
