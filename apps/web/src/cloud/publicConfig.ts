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
  /**
   * Cloud sync is opt-in per deployment, on top of the rest of the cloud config: the flag is what
   * makes a build open a Convex socket at all, so an unconfigured (or merely relay-configured)
   * deployment behaves exactly as it did before.
   */
  readonly cloudSync: {
    readonly enabled: boolean;
    readonly convexUrl: string | null;
  };
}

export function trimNonEmpty(value: string | undefined): string | null {
  return value?.trim() || null;
}

/**
 * Public flags arrive as strings (or as `undefined` in a build that never set them), so only an
 * explicit affirmative counts. Everything else — absent, empty, `"0"`, a typo — reads as off,
 * which is the safe direction for a feature that is default-off.
 */
export function parsePublicFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

/**
 * The literal the *deployment* side of cloud sync is gated on: Convex's `requireCloudSyncEnabled`
 * and the server daemon both demand exactly `PATHWAY_CLOUD_SYNC=enabled`, and it is the only value
 * any documentation names. One operator knob feeds both halves (see `scripts/lib/public-config.ts`,
 * which projects it to `VITE_PATHWAY_CLOUD_SYNC` as well), so the web gate has to accept it too —
 * otherwise the documented value turns Convex and the daemon on while every browser stays dark.
 */
export const CLOUD_SYNC_ENABLED_VALUE = "enabled";

/**
 * The cloud-sync opt-in, which answers to one more spelling than the other public flags: the
 * canonical {@link CLOUD_SYNC_ENABLED_VALUE} the deployment gates on, alongside the ordinary
 * affirmatives. Anything else — absent, empty, `"0"`, a typo — is off, as everywhere else.
 */
export function parseCloudSyncFlag(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === CLOUD_SYNC_ENABLED_VALUE || parsePublicFlag(value);
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
      enabled: parseCloudSyncFlag(import.meta.env.VITE_PATHWAY_CLOUD_SYNC as string | undefined),
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
 * Whether this build may run cloud sync: the whole cloud config, plus the explicit opt-in flag,
 * plus a Convex deployment to talk to. All three are required, so a deployment that only has the
 * relay configured — every deployment today — opens no Convex socket and runs no engine.
 */
export function hasCloudSyncPublicConfig(): boolean {
  const { cloudSync } = resolveCloudPublicConfig();
  return hasCloudPublicConfig() && cloudSync.enabled && cloudSync.convexUrl !== null;
}

/** The Convex deployment origin, or `null` when cloud sync is off or misconfigured. */
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
