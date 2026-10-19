import { relayClerkTokenOptions } from "@spiritdevs/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@spiritdevs/shared/relayUrl";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedErrorClass<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("PATHWAY_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerkPublishableKey: string | null;
  readonly clerkJwtTemplate: string | null;
  readonly relayUrl: string | null;
  readonly relayTracing: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
  readonly cloudSync: {
    readonly convexUrl: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

function normalizeSecureUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Loopback is the one place a Convex deployment is reachable without TLS: a self-hosted backend. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * A Convex deployment URL, normalized to its origin.
 *
 * Cloud deployments are always `https://<deployment>.convex.cloud`; plain HTTP is accepted only
 * for a loopback host, which is a locally run backend and cannot be intercepted on the wire.
 */
export function normalizeConvexDeploymentUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.username.length > 0 || url.password.length > 0) {
      return null;
    }
    if (url.protocol === "https:") {
      return url.origin;
    }
    return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname) ? url.origin : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(): CloudPublicConfig {
  return {
    clerkPublishableKey: trimNonEmpty(
      import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined,
    ),
    clerkJwtTemplate: trimNonEmpty(import.meta.env.VITE_CLERK_JWT_TEMPLATE as string | undefined),
    relayUrl: normalizeSecureRelayUrl(
      (import.meta.env.VITE_PATHWAY_RELAY_URL as string | undefined) ?? "",
    ),
    relayTracing: {
      tracesUrl: normalizeSecureUrl(
        (import.meta.env.VITE_RELAY_OTLP_TRACES_URL as string | undefined) ?? "",
      ),
      tracesDataset: trimNonEmpty(
        import.meta.env.VITE_RELAY_OTLP_TRACES_DATASET as string | undefined,
      ),
      tracesToken: trimNonEmpty(import.meta.env.VITE_RELAY_OTLP_TRACES_TOKEN as string | undefined),
    },
    cloudSync: {
      convexUrl: normalizeConvexDeploymentUrl(
        (import.meta.env.VITE_PATHWAY_CONVEX_URL as string | undefined) ?? "",
      ),
    },
  };
}

export function resolveRelayTracingConfig() {
  const { relayTracing } = resolveCloudPublicConfig();
  return relayTracing.tracesUrl && relayTracing.tracesDataset && relayTracing.tracesToken
    ? {
        tracesUrl: relayTracing.tracesUrl,
        tracesDataset: relayTracing.tracesDataset,
        tracesToken: relayTracing.tracesToken,
      }
    : null;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerkPublishableKey && config.clerkJwtTemplate && config.relayUrl);
}

export function hasClerkPublicConfig(): boolean {
  return Boolean(resolveCloudPublicConfig().clerkPublishableKey);
}

/**
 * Whether this build can run cloud sync. Online Pathway deployments always use it; the only
 * remaining checks are the concrete services the runtime needs to connect.
 */
export function hasCloudSyncPublicConfig(): boolean {
  const { cloudSync } = resolveCloudPublicConfig();
  return hasCloudPublicConfig() && cloudSync.convexUrl !== null;
}

/** The Convex deployment origin, or `null` when cloud sync is not configured. */
export function resolveCloudSyncConvexUrl(): string | null {
  return hasCloudSyncPublicConfig() ? resolveCloudPublicConfig().cloudSync.convexUrl : null;
}

/**
 * Convex accepts Clerk tokens for `applicationID: "convex"` (see
 * `packages/backend/convex/auth.config.ts`), and Clerk stamps `aud` with the JWT template's name.
 * So the Convex socket needs a token minted from a template literally named `convex` — a different
 * token from the relay's, whose template name is deployment-configured
 * (`VITE_CLERK_JWT_TEMPLATE`). The name is fixed by the backend's auth config, so it is a constant
 * here rather than another public-config key.
 */
export const CONVEX_CLERK_JWT_TEMPLATE = "convex";

/**
 * Clerk `getToken` options for the Convex socket. Convex asks for a fresh token only when the one
 * it holds was rejected, so the cache is skipped exactly then instead of on every call.
 */
export function resolveConvexClerkTokenOptions(
  options: { readonly forceRefreshToken?: boolean } = {},
) {
  return {
    template: CONVEX_CLERK_JWT_TEMPLATE,
    skipCache: options.forceRefreshToken ?? false,
  } as const;
}

export function resolveRelayClerkTokenOptions() {
  const { clerkJwtTemplate } = resolveCloudPublicConfig();
  if (!clerkJwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "PATHWAY_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(clerkJwtTemplate);
}
