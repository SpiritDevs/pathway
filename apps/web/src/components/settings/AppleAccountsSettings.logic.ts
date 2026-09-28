import type { AppleEnvironmentHealth, AppleIntegration } from "@spiritdevs/contracts/apple";

import type { AppleAccount } from "~/cloud/appleAccounts";

export const APP_STORE_CONNECT_APPS_URL = "https://appstoreconnect.apple.com/apps";

export const APPLE_TEAM_TYPES = [
  { value: "individual", label: "Individual" },
  { value: "organization", label: "Organization" },
  { value: "enterprise", label: "Enterprise" },
  { value: "unknown", label: "Unknown" },
] as const;
export type AppleTeamType = (typeof APPLE_TEAM_TYPES)[number]["value"];

export type EnvironmentKeyState = "connected" | "lease-expired" | "disconnected";

export interface EnvironmentHealthRow {
  readonly environmentId: string;
  readonly label: string;
  readonly state: EnvironmentKeyState;
  readonly lastVerifiedAt: number | null;
  readonly error: string | null;
}

/**
 * Cloud subscriptions do not rerun when wall-clock time passes, so a lease whose expiry is behind
 * `now` reads as disconnected even while the row still says connected.
 */
export function environmentKeyState(
  health: AppleEnvironmentHealth,
  now: number,
): EnvironmentKeyState {
  if (!health.connected) return "disconnected";
  if (health.leaseExpiresAt === null || health.leaseExpiresAt <= now) return "lease-expired";
  return "connected";
}

export function environmentHealthRows(
  environments: ReadonlyArray<AppleEnvironmentHealth>,
  now: number,
  labelFor: (environmentId: string) => string | undefined,
): ReadonlyArray<EnvironmentHealthRow> {
  return environments
    .map((health) => ({
      environmentId: health.environmentId,
      label: labelFor(health.environmentId) ?? `Environment ${health.environmentId.slice(0, 8)}`,
      state: environmentKeyState(health, now),
      lastVerifiedAt: health.lastVerifiedAt,
      error: health.error?.message ?? null,
    }))
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export const ENVIRONMENT_KEY_STATE_LABELS: Readonly<Record<EnvironmentKeyState, string>> = {
  connected: "Connected",
  "lease-expired": "Idle",
  disconnected: "Not connected",
};

export function keySummary(integration: AppleIntegration): string {
  if (!integration.connected) return "No API key connected";
  return integration.keyIdSuffix === null ? "Key connected" : `Key …${integration.keyIdSuffix}`;
}

export function scopeLabel(
  scope: AppleAccount["scope"],
  companyName: (companyId: string) => string | undefined,
): string {
  return scope.kind === "user" ? "Personal" : (companyName(scope.companyId) ?? "Company");
}

export interface AppleErrorDetails {
  readonly code: string | null;
  readonly message: string;
}

function errorData(error: unknown): {
  code?: unknown;
  message?: unknown;
  retryAfterSeconds?: unknown;
} {
  if (typeof error !== "object" || error === null) return {};
  // Cloud calls throw ConvexError with `{ code, message }` data; environment RPCs fail with
  // AppleError, which carries the same fields directly.
  if ("data" in error && typeof error.data === "object" && error.data !== null) return error.data;
  if ("_tag" in error && error._tag === "AppleError") return error as { code?: unknown };
  return {};
}

const ASC_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  "not-connected": "Connect an App Store Connect API key for this team first.",
  "cloud-unavailable": "Pathway Cloud is unavailable. Try again in a moment.",
  unauthorized: "App Store Connect rejected this key. Check the issuer ID, key ID and .p8 file.",
  forbidden:
    "This API key cannot read apps. Give it at least the Developer role in App Store Connect.",
  "invalid-key":
    "That is not a valid App Store Connect private key. Choose the .p8 file Apple gave you.",
  "invalid-response": "App Store Connect sent an unexpected response. Try again.",
  "request-failed": "Could not reach App Store Connect. Try again.",
  "credential-changed": "The API key changed on another device. Try again.",
  "credential-missing": "Connect an App Store Connect API key for this team first.",
};

export const APPLE_CONFLICT_MESSAGE =
  "This changed on another device. The latest details are shown now; review them and try again.";

/**
 * `conflictMessage` replaces the server's text for stale-revision conflicts. Omit it where
 * `entity-conflict` carries a specific reason, such as a duplicate Apple ID. Linked projects
 * arrive as `apple-account-linked-projects` and keep the server's text.
 */
export function describeAppleError(
  error: unknown,
  options: { readonly fallback: string; readonly conflictMessage?: string },
): AppleErrorDetails {
  const data = errorData(error);
  const code = typeof data.code === "string" ? data.code : null;
  const serverMessage =
    typeof data.message === "string" && data.message.trim() ? data.message : null;
  if (code === "entity-conflict") {
    return { code, message: options.conflictMessage ?? serverMessage ?? APPLE_CONFLICT_MESSAGE };
  }
  if (code === "rate-limited") {
    const seconds = typeof data.retryAfterSeconds === "number" ? data.retryAfterSeconds : null;
    return {
      code,
      message:
        seconds === null
          ? "App Store Connect is rate limiting requests. Try again shortly."
          : `App Store Connect is rate limiting requests. Try again in ${Math.ceil(seconds)} seconds.`,
    };
  }
  if (code !== null && ASC_ERROR_MESSAGES[code]) return { code, message: ASC_ERROR_MESSAGES[code] };
  return { code, message: serverMessage ?? options.fallback };
}

export const APPLE_TEAM_ID_PATTERN = /^[A-Z0-9]{10}$/u;

export function normalizeTeamId(value: string): string {
  return value.trim().toUpperCase();
}

export interface KeyDraft {
  readonly issuerId: string;
  readonly keyId: string;
  readonly privateKey: string;
}

export const EMPTY_KEY_DRAFT: KeyDraft = { issuerId: "", keyId: "", privateKey: "" };

export function keyDraftProblem(draft: KeyDraft): string | null {
  if (!draft.issuerId.trim()) return "Enter the issuer ID from App Store Connect.";
  if (!draft.keyId.trim()) return "Enter the key ID.";
  if (!/-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----/u.test(draft.privateKey)) {
    return "Choose or paste the .p8 private key, including its BEGIN and END lines.";
  }
  return null;
}

export interface ProjectLinkPicker {
  readonly accountId: string | null;
  readonly teamId: string | null;
  readonly appId: string | null;
}

export const EMPTY_PROJECT_LINK_PICKER: ProjectLinkPicker = {
  accountId: null,
  teamId: null,
  appId: null,
};

/** Each choice clears the choices below it, so a stale team or app never survives a parent change. */
export function pickProjectLinkAccount(
  state: ProjectLinkPicker,
  accountId: string | null,
): ProjectLinkPicker {
  return accountId === state.accountId ? state : { accountId, teamId: null, appId: null };
}

export function pickProjectLinkTeam(
  state: ProjectLinkPicker,
  teamId: string | null,
): ProjectLinkPicker {
  return teamId === state.teamId ? state : { ...state, teamId, appId: null };
}

export function pickProjectLinkApp(
  state: ProjectLinkPicker,
  appId: string | null,
): ProjectLinkPicker {
  return { ...state, appId };
}

export function completeProjectLinkPicker(
  state: ProjectLinkPicker,
): { readonly accountId: string; readonly teamId: string; readonly appId: string } | null {
  return state.accountId !== null && state.teamId !== null && state.appId !== null
    ? { accountId: state.accountId, teamId: state.teamId, appId: state.appId }
    : null;
}
