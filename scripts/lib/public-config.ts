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
  /** Opt-in flag for cloud sync; absent means off, which is every deployment until it is set. */
  readonly cloudSync: string | undefined;
  /** Convex deployment the cloud-sync engine talks to; only read when {@link cloudSync} is on. */
  readonly convexUrl: string | undefined;
  readonly mobileOtlpTracesUrl: string | undefined;
  readonly mobileOtlpTracesDataset: string | undefined;
  readonly mobileOtlpTracesToken: string | undefined;
  readonly relayClientOtlpTracesUrl: string | undefined;
  readonly relayClientOtlpTracesDataset: string | undefined;
  readonly relayClientOtlpTracesToken: string | undefined;
}

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The one value both halves of cloud sync agree on.
 *
 * The deployment half is gated on this literal exactly — Convex's `requireCloudSyncEnabled` and the
 * server daemon both compare against `"enabled"` — while the web build reads its flag through a
 * boolean parser that also takes `1|true|on|yes`. Since a single knob is projected to both names
 * below, an un-normalized value can only ever satisfy one of them: `enabled` would leave the
 * browser dark, `true` would leave the daemon and the deployment off.
 */
const CLOUD_SYNC_ENABLED_VALUE = "enabled";

const CLOUD_SYNC_ON_VALUES: ReadonlySet<string> = new Set([
  CLOUD_SYNC_ENABLED_VALUE,
  "1",
  "true",
  "on",
  "yes",
]);

/**
 * Collapses every affirmative spelling of the cloud-sync knob onto
 * {@link CLOUD_SYNC_ENABLED_VALUE}, so one operator value enables the deployment, the server
 * daemon, and the web build together. Anything that is not an affirmative is passed through
 * untouched: both consumers read it as off, and the operator's own wording is worth keeping in the
 * environment they will read back.
 */
export function normalizeCloudSyncFlag(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return undefined;
  return CLOUD_SYNC_ON_VALUES.has(normalized) ? CLOUD_SYNC_ENABLED_VALUE : value?.trim();
}

const REPO_ROOT = NodePath.dirname(
  NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url))),
);

export function loadRepoEnv({
  baseEnv = process.env,
  repoRoot = REPO_ROOT,
}: {
  readonly baseEnv?: Environment;
  readonly repoRoot?: string;
} = {}): Record<string, string | undefined> {
  const rootEnv = readEnvFile(NodePath.join(repoRoot, ".env"));
  const localEnv = readEnvFile(NodePath.join(repoRoot, ".env.local"));
  const config = resolvePublicConfig(baseEnv, localEnv, rootEnv);
  const cloudSync = normalizeCloudSyncFlag(config.cloudSync);

  return {
    ...rootEnv,
    ...localEnv,
    ...baseEnv,
    ...(config.clerkPublishableKey
      ? {
          PATHWAY_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          VITE_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
          EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: config.clerkPublishableKey,
        }
      : {}),
    ...(config.clerkJwtTemplate
      ? {
          PATHWAY_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          VITE_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
          EXPO_PUBLIC_CLERK_JWT_TEMPLATE: config.clerkJwtTemplate,
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
    ...(cloudSync
      ? {
          PATHWAY_CLOUD_SYNC: cloudSync,
          VITE_PATHWAY_CLOUD_SYNC: cloudSync,
        }
      : {}),
    ...(config.convexUrl
      ? {
          PATHWAY_CONVEX_URL: config.convexUrl,
          VITE_PATHWAY_CONVEX_URL: config.convexUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesUrl
      ? {
          PATHWAY_MOBILE_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
          EXPO_PUBLIC_OTLP_TRACES_URL: config.mobileOtlpTracesUrl,
        }
      : {}),
    ...(config.mobileOtlpTracesDataset
      ? {
          PATHWAY_MOBILE_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
          EXPO_PUBLIC_OTLP_TRACES_DATASET: config.mobileOtlpTracesDataset,
        }
      : {}),
    ...(config.mobileOtlpTracesToken
      ? {
          PATHWAY_MOBILE_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
          EXPO_PUBLIC_OTLP_TRACES_TOKEN: config.mobileOtlpTracesToken,
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
      "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
    ),
    clerkJwtTemplate: firstNonEmpty(
      sources,
      "PATHWAY_CLERK_JWT_TEMPLATE",
      "VITE_CLERK_JWT_TEMPLATE",
      "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
    ),
    clerkCliOAuthClientId: firstNonEmpty(
      sources,
      "PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID",
      "VITE_CLERK_CLI_OAUTH_CLIENT_ID",
    ),
    relayUrl: firstNonEmpty(sources, "PATHWAY_RELAY_URL", "VITE_PATHWAY_RELAY_URL"),
    cloudSync: firstNonEmpty(sources, "PATHWAY_CLOUD_SYNC", "VITE_PATHWAY_CLOUD_SYNC"),
    convexUrl: firstNonEmpty(sources, "PATHWAY_CONVEX_URL", "VITE_PATHWAY_CONVEX_URL"),
    mobileOtlpTracesUrl: firstNonEmpty(
      sources,
      "PATHWAY_MOBILE_OTLP_TRACES_URL",
      "EXPO_PUBLIC_OTLP_TRACES_URL",
    ),
    mobileOtlpTracesDataset: firstNonEmpty(
      sources,
      "PATHWAY_MOBILE_OTLP_TRACES_DATASET",
      "EXPO_PUBLIC_OTLP_TRACES_DATASET",
    ),
    mobileOtlpTracesToken: firstNonEmpty(
      sources,
      "PATHWAY_MOBILE_OTLP_TRACES_TOKEN",
      "EXPO_PUBLIC_OTLP_TRACES_TOKEN",
    ),
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
