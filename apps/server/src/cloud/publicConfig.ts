import { CONNECT_OAUTH_SCOPES, DEFAULT_HOSTED_APP_URL } from "@spiritdevs/shared/connectAuth";
import { clerkFrontendApiUrlFromPublishableKey } from "@spiritdevs/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@spiritdevs/shared/relayUrl";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

declare const __PATHWAY_BUILD_RELAY_URL__: string | undefined;
declare const __PATHWAY_BUILD_CONVEX_URL__: string | undefined;
declare const __PATHWAY_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;
declare const __PATHWAY_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__: string | undefined;
declare const __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__: string | undefined;
declare const __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__: string | undefined;
declare const __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__: string | undefined;

const CLOUD_CLI_OAUTH_REDIRECT_URI = "http://127.0.0.1:34338/callback";
const CLOUD_CLI_OAUTH_SCOPES = CONNECT_OAUTH_SCOPES;

function validateRelayUrl(value: string) {
  const relayUrl = normalizeSecureRelayUrl(value);
  return relayUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message: "Relay URL must be a secure absolute HTTPS origin.",
            }),
          ),
        ),
      )
    : Effect.succeed(relayUrl);
}

/**
 * Normalizes a Convex deployment URL to a bare origin.
 *
 * Unlike the relay URL this accepts an HTTP loopback origin, because `npx convex dev` serves a
 * local deployment on `http://127.0.0.1:3210` and a developer pointing a server at it is the
 * expected way to exercise cloud sync before a deployment exists. Everything else is the same
 * shape the relay demands — HTTPS, no credentials, no path, query, or fragment — so a value with a
 * function path baked into it is refused here rather than producing 404s from every call.
 */
export function normalizeConvexUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0 ||
      !/^\/+$/u.test(url.pathname)
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function validateConvexUrl(value: string) {
  const convexUrl = normalizeConvexUrl(value);
  return convexUrl === null
    ? Effect.fail(
        new Config.ConfigError(
          new Schema.SchemaError(
            new SchemaIssue.InvalidValue({
              message:
                "Convex URL must be an absolute HTTPS origin (or an HTTP loopback origin for a local deployment).",
            }),
          ),
        ),
      )
    : Effect.succeed(convexUrl);
}

function readBuildTimeValue(value: string | undefined): string {
  return typeof value === "undefined" ? "" : value.trim();
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export const buildTimeRelayUrl =
  typeof __PATHWAY_BUILD_RELAY_URL__ === "undefined"
    ? ""
    : (normalizeSecureRelayUrl(__PATHWAY_BUILD_RELAY_URL__) ?? "");
/**
 * Convex deployment baked in at build time. Empty in a source checkout and in any build that did
 * not set `PATHWAY_CONVEX_URL`, which is what keeps cloud sync off by default: with no fallback
 * the runtime config below simply fails to resolve and the sync daemon stays a no-op.
 */
export const buildTimeConvexUrl =
  typeof __PATHWAY_BUILD_CONVEX_URL__ === "undefined"
    ? ""
    : (normalizeConvexUrl(__PATHWAY_BUILD_CONVEX_URL__) ?? "");
export const buildTimeClerkPublishableKey = readBuildTimeValue(
  typeof __PATHWAY_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __PATHWAY_BUILD_CLERK_PUBLISHABLE_KEY__,
);
export const buildTimeClerkCliOAuthClientId = readBuildTimeValue(
  typeof __PATHWAY_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__ === "undefined"
    ? undefined
    : __PATHWAY_BUILD_CLERK_CLI_OAUTH_CLIENT_ID__,
);
export const buildTimeRelayClientTracing = {
  tracesUrl: readBuildTimeValue(
    typeof __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__ === "undefined"
      ? undefined
      : __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_URL__,
  ),
  tracesDataset: readBuildTimeValue(
    typeof __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__ === "undefined"
      ? undefined
      : __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_DATASET__,
  ),
  tracesToken: readBuildTimeValue(
    typeof __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__ === "undefined"
      ? undefined
      : __PATHWAY_BUILD_RELAY_CLIENT_OTLP_TRACES_TOKEN__,
  ),
} as const;

export function resolveRelayClientTracingConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback = buildTimeRelayClientTracing,
) {
  const tracesUrl = env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_URL?.trim() || fallback.tracesUrl;
  const tracesDataset =
    env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_DATASET?.trim() || fallback.tracesDataset;
  const tracesToken = env.PATHWAY_RELAY_CLIENT_OTLP_TRACES_TOKEN?.trim() || fallback.tracesToken;
  const normalizedTracesUrl = normalizeSecureUrl(tracesUrl);
  return normalizedTracesUrl && tracesDataset && tracesToken
    ? { tracesUrl: normalizedTracesUrl, tracesDataset, tracesToken }
    : null;
}

export function makeRelayUrlConfig(fallback = buildTimeRelayUrl) {
  const runtimeConfig = Config.nonEmptyString("PATHWAY_RELAY_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapOrFail(validateRelayUrl),
  );
}

export const relayUrlConfig = makeRelayUrlConfig();

/**
 * Convex deployment the cloud-sync daemon talks to.
 *
 * Mirrors {@link makeRelayUrlConfig}: a runtime `PATHWAY_CONVEX_URL` wins, otherwise the value the
 * build embedded, and an absent value is a *failure* rather than a default — cloud sync is opt-in,
 * so the daemon treats an unresolvable config as "not configured" and does nothing.
 */
export function makeConvexUrlConfig(fallback = buildTimeConvexUrl) {
  const runtimeConfig = Config.nonEmptyString("PATHWAY_CONVEX_URL");
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.mapOrFail(validateConvexUrl),
  );
}

export const convexUrlConfig = makeConvexUrlConfig();

/**
 * Hosted app origin used for out-of-band OAuth on headless
 * machines. Overridable so staging/nightly builds can point their CLIs at a
 * matching hosted deployment.
 */
export const hostedAppUrlConfig = makePublicValueConfig(
  "PATHWAY_HOSTED_APP_URL",
  DEFAULT_HOSTED_APP_URL,
).pipe(Config.mapOrFail(validateHostedAppUrl));

function validateHostedAppUrl(value: string) {
  try {
    const url = new URL(value);
    const isLoopbackHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    if (
      (url.protocol !== "https:" && !isLoopbackHttp) ||
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("invalid hosted app origin");
    }
    return Effect.succeed(url.origin);
  } catch {
    return Effect.fail(
      new Config.ConfigError(
        new Schema.SchemaError(
          new SchemaIssue.InvalidValue({
            message: "Hosted app URL must be an absolute HTTPS origin (or HTTP loopback origin).",
          }),
        ),
      ),
    );
  }
}

function makePublicValueConfig(name: string, fallback: string) {
  const runtimeConfig = Config.nonEmptyString(name);
  return (fallback ? runtimeConfig.pipe(Config.withDefault(fallback)) : runtimeConfig).pipe(
    Config.map((value) => value.trim()),
  );
}

export interface CloudCliOAuthConfig {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly scopes: typeof CLOUD_CLI_OAUTH_SCOPES;
}

export function makeCloudCliOAuthConfig({
  clerkPublishableKeyFallback = buildTimeClerkPublishableKey,
  clerkCliOAuthClientIdFallback = buildTimeClerkCliOAuthClientId,
}: {
  readonly clerkPublishableKeyFallback?: string;
  readonly clerkCliOAuthClientIdFallback?: string;
} = {}) {
  return Config.all({
    clerkPublishableKey: makePublicValueConfig(
      "PATHWAY_CLERK_PUBLISHABLE_KEY",
      clerkPublishableKeyFallback,
    ),
    clientId: makePublicValueConfig(
      "PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID",
      clerkCliOAuthClientIdFallback,
    ),
  }).pipe(
    Config.mapOrFail(({ clerkPublishableKey, clientId }) =>
      Effect.try({
        try: () => clerkFrontendApiUrlFromPublishableKey(clerkPublishableKey),
        catch: (cause) =>
          new Config.ConfigError(
            new ConfigProvider.SourceError({
              message: "Failed to derive Clerk Frontend API URL from the publishable key.",
              cause,
            }),
          ),
      }).pipe(
        Effect.map(
          (clerkFrontendApiUrl) =>
            ({
              authorizationEndpoint: `${clerkFrontendApiUrl}/oauth/authorize`,
              tokenEndpoint: `${clerkFrontendApiUrl}/oauth/token`,
              clientId,
              redirectUri: CLOUD_CLI_OAUTH_REDIRECT_URI,
              scopes: CLOUD_CLI_OAUTH_SCOPES,
            }) satisfies CloudCliOAuthConfig,
        ),
      ),
    ),
  );
}

export const cloudCliOAuthConfig = makeCloudCliOAuthConfig();

export const hasCloudPublicConfig = Boolean(
  (normalizeSecureRelayUrl(process.env.PATHWAY_RELAY_URL ?? "") ?? buildTimeRelayUrl) &&
  (process.env.PATHWAY_CLERK_PUBLISHABLE_KEY?.trim() || buildTimeClerkPublishableKey) &&
  (process.env.PATHWAY_CLERK_CLI_OAUTH_CLIENT_ID?.trim() || buildTimeClerkCliOAuthClientId),
);
