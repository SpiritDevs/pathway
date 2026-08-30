// @effect-diagnostics nodeBuiltinImport:off -- credential stores are owned by Node CLIs and the OS keychain.
// @effect-diagnostics globalDate:off -- provider payloads and the bounded in-memory TTL use epoch timestamps.
// @effect-diagnostics globalFetch:off -- fixed first-party provider endpoints are isolated behind fetchJson.
/**
 * Live provider quota snapshots.
 *
 * Reads the credentials already owned by the configured CLI instance and calls
 * that provider's first-party usage endpoint. Credentials never cross the RPC
 * boundary and this service never mutates their stores.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import type {
  ProviderInstanceEnvironment,
  ProviderUsageDriver,
  ServerGetProviderUsageInput,
  ServerSettings,
  ServerProviderUsageLimit,
  ServerProviderUsageLine,
  ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import { ProviderInstanceId } from "@spiritdevs/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 60 * 1000;
const MAX_CACHE_ENTRIES = 64;
const CLAUDE_VERSION_TIMEOUT_MS = 2_000;
const FALLBACK_CLAUDE_VERSION = "2.1.69";

interface FetchJsonResult {
  readonly status: number;
  readonly ok: boolean;
  readonly json: unknown;
  readonly headers: Headers;
}

interface ProviderContext {
  readonly instanceId: ServerGetProviderUsageInput["instanceId"];
  readonly provider: ProviderUsageDriver;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly homeDir: string;
  readonly providerHomePath: string | null;
  readonly providerBinaryPath: string | null;
  readonly useDefaultCredentialStore: boolean;
  readonly nowMs: number;
}

interface CachedSnapshot {
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly fetchedAtMs: number;
}

interface ProviderFetchResult {
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly retryAfterUntilMs?: number;
}

interface InFlightFetch {
  readonly forced: boolean;
  readonly promise: Promise<ServerProviderUsageSnapshot>;
}

const snapshotCache = new Map<string, CachedSnapshot>();
const inFlightFetches = new Map<string, InFlightFetch>();
const retryAfterGates = new Map<string, number>();
const claudeVersionCache = new Map<string, Promise<string>>();
// This cache is process-local already, so its dirty-signal shares that
// lifetime. Sliding(1) mirrors ScheduledTaskService: subscribers always
// re-read the full list and never need a backlog of intermediate signals.
const snapshotChanges = Effect.runSync(PubSub.sliding<void>(1));

type ClaudeVersionRunner = (command: string, env: NodeJS.ProcessEnv) => Promise<string>;

const defaultClaudeVersionRunner: ClaudeVersionRunner = async (command, env) => {
  const { stdout } = await execFileAsync(command, ["--version"], {
    env,
    timeout: CLAUDE_VERSION_TIMEOUT_MS,
  });
  return stdout.toString();
};

let claudeVersionRunner = defaultClaudeVersionRunner;

function setBounded<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_CACHE_ENTRIES) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    map.delete(oldestKey);
  }
}

function getLru<K, V>(map: Map<K, V>, key: K): V | undefined {
  const value = map.get(key);
  if (value === undefined) return undefined;
  map.delete(key);
  map.set(key, value);
  return value;
}

type ProviderUsageSnapshotContent = Omit<
  ServerProviderUsageSnapshot,
  "source" | "updatedAt" | "fetchedAt"
>;

export type PushedProviderUsageSnapshot = ProviderUsageSnapshotContent & {
  readonly primaryLimit?: ServerProviderUsageLimit;
  readonly secondaryLimit?: ServerProviderUsageLimit;
  readonly updatesUsageLines?: true;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function clampPercent(value: number | undefined): number | undefined {
  return value === undefined ? undefined : Math.min(100, Math.max(0, value));
}

function titleCase(value: string): string {
  return value
    .split(/[\s_-]+/u)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      if (lower === "api") return "API";
      if (lower === "chatgpt") return "ChatGPT";
      if (lower === "oauth") return "OAuth";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function codexPlanName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
  const knownPlans: Record<string, string> = {
    chatgpt_plus: "ChatGPT Plus",
    plus: "ChatGPT Plus",
    chatgpt_pro: "ChatGPT Pro",
    pro: "ChatGPT Pro",
    chatgpt_team: "ChatGPT Team",
    team: "ChatGPT Team",
    chatgpt_business: "ChatGPT Business",
    business: "ChatGPT Business",
    self_serve_business: "ChatGPT Business",
    chatgpt_enterprise: "ChatGPT Enterprise",
    enterprise: "ChatGPT Enterprise",
    chatgpt_free: "ChatGPT Free",
    free: "ChatGPT Free",
  };
  if (knownPlans[normalized]) return knownPlans[normalized];
  if (normalized.includes("business")) return "ChatGPT Business";
  if (normalized.includes("enterprise")) return "ChatGPT Enterprise";
  return titleCase(value);
}

function claudePlanName(subscription: string | undefined, tier: string | undefined) {
  const normalizedTier = tier?.trim().toLowerCase();
  const knownTiers: Record<string, string> = {
    default_claude_max_5x: "Max (5x)",
    default_claude_max_20x: "Max (20x)",
  };
  if (normalizedTier && knownTiers[normalizedTier]) return knownTiers[normalizedTier];
  const normalizedSubscription = subscription?.trim().toLowerCase();
  if (!normalizedSubscription) return undefined;
  const multiplier = normalizedTier?.match(/(?:^|_)(\d+x)(?:_|$)/u)?.[1];
  return `${titleCase(normalizedSubscription)}${multiplier ? ` (${multiplier})` : ""}`;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const text = asString(value)?.toLowerCase();
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return undefined;
}

function formatWindowDuration(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes));
  if (rounded < 60) return `${rounded}m`;
  if (rounded % 10_080 === 0) return `${rounded / 10_080}w`;
  if (rounded % 1_440 === 0) return `${rounded / 1_440}d`;
  if (rounded % 60 === 0) return `${rounded / 60}h`;
  const hours = Math.floor(rounded / 60);
  return `${hours}h ${rounded % 60}m`;
}

export function describeWindow(
  durationMins: number | undefined,
  lane?: "primary" | "secondary",
): Pick<ServerProviderUsageLimit, "window" | "windowKey"> {
  if (durationMins !== undefined && Math.abs(durationMins - 300) <= 5) {
    return { window: "5h", windowKey: "session" };
  }
  if (durationMins !== undefined && Math.abs(durationMins - 10_080) <= 60) {
    return { window: "Weekly", windowKey: "weekly" };
  }
  if (durationMins !== undefined) {
    return { window: formatWindowDuration(durationMins), windowKey: "custom" };
  }
  return lane === "primary"
    ? { window: "5h", windowKey: "session" }
    : lane === "secondary"
      ? { window: "Weekly", windowKey: "weekly" }
      : { window: "Custom", windowKey: "custom" };
}

function formatUsd(amount: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  }).format(amount);
}

function isoFromUnixSeconds(value: unknown): string | undefined {
  const seconds = asFiniteNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return new Date(seconds * 1000).toISOString();
}

function isoFromUnixMillis(value: unknown): string | undefined {
  const millis = asFiniteNumber(value);
  if (millis === undefined || millis <= 0) return undefined;
  return new Date(millis).toISOString();
}

function isoFromString(value: unknown): string | undefined {
  const text = asString(value);
  if (!text) return undefined;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : undefined;
}

export function mapCodexRateLimitsUpdated(input: {
  instanceId: ServerGetProviderUsageInput["instanceId"];
  rateLimits: {
    readonly primary?: {
      readonly usedPercent: number;
      readonly windowDurationMins?: number | null;
      readonly resetsAt?: number | null;
    } | null;
    readonly secondary?: {
      readonly usedPercent: number;
      readonly windowDurationMins?: number | null;
      readonly resetsAt?: number | null;
    } | null;
    readonly credits?: {
      readonly balance?: string | null;
      readonly hasCredits: boolean;
      readonly unlimited: boolean;
    } | null;
    readonly planType?: string | null;
  };
}): PushedProviderUsageSnapshot {
  const limits: ServerProviderUsageLimit[] = [];
  const mapWindow = (
    value: NonNullable<typeof input.rateLimits.primary>,
    lane: "primary" | "secondary",
  ): ServerProviderUsageLimit => {
    const windowDurationMins = value.windowDurationMins ?? undefined;
    const resetsAt = isoFromUnixSeconds(value.resetsAt);
    const limit = {
      ...describeWindow(windowDurationMins, lane),
      usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
      ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
      ...(resetsAt ? { resetsAt } : {}),
    };
    limits.push(limit);
    return limit;
  };
  const primaryLimit = input.rateLimits.primary
    ? mapWindow(input.rateLimits.primary, "primary")
    : undefined;
  const secondaryLimit = input.rateLimits.secondary
    ? mapWindow(input.rateLimits.secondary, "secondary")
    : undefined;

  const usageLines: ServerProviderUsageLine[] = [];
  const credits = input.rateLimits.credits;
  const balance = asFiniteNumber(credits?.balance);
  if (credits?.hasCredits === true || (balance !== undefined && balance > 0)) {
    if (credits?.unlimited === true) {
      usageLines.push({ label: "Credits", value: "Unlimited" });
    } else if (balance !== undefined) {
      usageLines.push({ label: "Credits", value: `${formatUsd(balance)} remaining` });
    }
  }

  const planType = asString(input.rateLimits.planType);
  return {
    instanceId: input.instanceId,
    provider: "codex",
    status: "ok",
    limits,
    usageLines,
    ...(planType ? { planName: codexPlanName(planType) } : {}),
    ...(primaryLimit === undefined ? {} : { primaryLimit }),
    ...(secondaryLimit === undefined ? {} : { secondaryLimit }),
    ...(credits === undefined || credits === null ? {} : { updatesUsageLines: true }),
  };
}

function decodeJwtExpMs(jwt: string | undefined): number | null {
  const payload = jwt?.split(".")[1];
  if (!payload) return null;
  try {
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8"),
    ) as { exp?: unknown };
    return typeof json.exp === "number" && Number.isFinite(json.exp) ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function readJsonFile(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await NodeFSP.readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readKeychainPassword(input: {
  service: string;
  account?: string;
  platform: NodeJS.Platform;
}): Promise<string | null> {
  if (input.platform !== "darwin") return null;
  const args = ["find-generic-password", "-s", input.service, "-w"];
  if (input.account) args.push("-a", input.account);
  try {
    const { stdout } = await execFileAsync("security", args, { timeout: 5_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function decodeKeychainJson(value: string): unknown | null {
  const tryParse = (candidate: string): unknown | null => {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  };
  const direct = tryParse(value.trim());
  if (direct !== null) return direct;
  const hex = value.trim().replace(/^0x/iu, "");
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(hex)) return null;
  return tryParse(Buffer.from(hex, "hex").toString("utf8"));
}

async function fetchJson(input: {
  url: string;
  method?: "GET" | "POST";
  headers: Record<string, string>;
  body?: unknown;
}): Promise<FetchJsonResult> {
  const response = await fetch(input.url, {
    method: input.method ?? "GET",
    headers: input.headers,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  const declaredLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Provider usage response exceeded the size limit.");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Provider usage response exceeded the size limit.");
  }
  let json: unknown = null;
  try {
    json = text.length > 0 ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = null;
  }
  return {
    status: response.status,
    ok: response.ok,
    json,
    headers: response.headers,
  };
}

function snapshot(
  ctx: Pick<ProviderContext, "instanceId" | "provider" | "nowMs">,
  input: Omit<ServerProviderUsageSnapshot, "instanceId" | "provider" | "updatedAt" | "fetchedAt">,
): ServerProviderUsageSnapshot {
  const fetchedAt = new Date(ctx.nowMs).toISOString();
  return {
    instanceId: ctx.instanceId,
    provider: ctx.provider,
    updatedAt: fetchedAt,
    fetchedAt,
    ...input,
  };
}

function needsAuthSnapshot(ctx: ProviderContext, detail?: string): ServerProviderUsageSnapshot {
  const providerName =
    ctx.provider === "claudeAgent" ? "Claude" : ctx.provider === "codex" ? "Codex" : "Cursor";
  return snapshot(ctx, {
    status: "needs-auth",
    source: "provider-credentials",
    limits: [],
    usageLines: [],
    detail: detail ?? `Sign in with the ${providerName} CLI on this environment to see live usage.`,
  });
}

function errorSnapshot(
  ctx: ProviderContext,
  source: string,
  detail: string,
): ServerProviderUsageSnapshot {
  return snapshot(ctx, { status: "error", source, limits: [], usageLines: [], detail });
}

function retryAfterUntilMs(value: string | null | undefined, nowMs: number): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  const seconds = Number(text);
  if (Number.isFinite(seconds) && seconds >= 0) return nowMs + seconds * 1000;
  const dateMs = Date.parse(text);
  return Number.isFinite(dateMs) && dateMs > nowMs ? dateMs : undefined;
}

function failedFetchResult(
  ctx: ProviderContext,
  source: string,
  providerName: string,
  result: FetchJsonResult,
): ProviderFetchResult {
  const retryUntil =
    result.status === 429
      ? retryAfterUntilMs(result.headers.get("retry-after"), ctx.nowMs)
      : undefined;
  const detail = retryUntil
    ? `${providerName} usage is rate limited. Refreshes are paused until ${new Date(retryUntil).toISOString()}.`
    : `${providerName} usage request failed (${result.status}).`;
  return {
    snapshot: errorSnapshot(ctx, source, detail),
    ...(retryUntil === undefined ? {} : { retryAfterUntilMs: retryUntil }),
  };
}

function fetched(snapshotValue: ServerProviderUsageSnapshot): ProviderFetchResult {
  return { snapshot: snapshotValue };
}

function resolvePath(value: string): string {
  return NodePath.resolve(expandHomePath(value));
}

function mergeInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnvironment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged = { ...baseEnvironment };
  for (const variable of environment ?? []) merged[variable.name] = variable.value;
  return merged;
}

function providerConfigForInput(
  settings: ServerSettings,
  input: ServerGetProviderUsageInput,
): { config: Record<string, unknown>; environment: ProviderInstanceEnvironment | undefined } {
  const instance = settings.providerInstances[input.instanceId];
  if (instance?.driver === input.provider) {
    return {
      config: asRecord(instance.config) ?? {},
      environment: instance.environment,
    };
  }
  return {
    config: asRecord(settings.providers[input.provider]) ?? {},
    environment: undefined,
  };
}

function buildContext(
  settings: ServerSettings,
  input: ServerGetProviderUsageInput,
  baseEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ProviderContext {
  const { config, environment } = providerConfigForInput(settings, input);
  const env = mergeInstanceEnvironment(environment, baseEnvironment);
  const homeDir = NodeOS.homedir();
  if (input.provider === "codex") {
    const configured = asString(config.shadowHomePath) ?? asString(config.homePath);
    const environmentHome = asString(env.CODEX_HOME);
    const providerHomePath = resolvePath(
      configured ?? environmentHome ?? NodePath.join(homeDir, ".codex"),
    );
    return {
      instanceId: input.instanceId,
      provider: input.provider,
      env: { ...env, CODEX_HOME: providerHomePath },
      platform,
      homeDir,
      providerHomePath,
      providerBinaryPath: asString(config.binaryPath) ?? null,
      useDefaultCredentialStore: configured === undefined && environmentHome === undefined,
      nowMs: Date.now(),
    };
  }
  if (input.provider === "claudeAgent") {
    const configured = asString(config.homePath);
    const environmentHome = asString(env.CLAUDE_CONFIG_DIR);
    const providerHomePath = configured
      ? resolvePath(configured)
      : environmentHome
        ? resolvePath(environmentHome)
        : NodePath.join(homeDir, ".claude");
    return {
      instanceId: input.instanceId,
      provider: input.provider,
      env: { ...env, ...(configured ? { CLAUDE_CONFIG_DIR: providerHomePath } : {}) },
      platform,
      homeDir,
      providerHomePath,
      providerBinaryPath: asString(config.binaryPath) ?? null,
      useDefaultCredentialStore: configured === undefined && environmentHome === undefined,
      nowMs: Date.now(),
    };
  }
  return {
    instanceId: input.instanceId,
    provider: input.provider,
    env,
    platform,
    homeDir,
    providerHomePath: null,
    providerBinaryPath: null,
    useDefaultCredentialStore: true,
    nowMs: Date.now(),
  };
}

function resetFromWindow(
  window: Record<string, unknown> | null,
  nowMs: number,
  resetAtFallback?: unknown,
): string | undefined {
  return (
    isoFromUnixSeconds(window?.reset_at) ??
    isoFromUnixSeconds(resetAtFallback) ??
    (() => {
      const seconds = asFiniteNumber(window?.reset_after_seconds);
      return seconds !== undefined && seconds > 0
        ? new Date(nowMs + seconds * 1000).toISOString()
        : undefined;
    })()
  );
}

export function parseCodexUsage(input: {
  instanceId: ServerGetProviderUsageInput["instanceId"];
  json: unknown;
  headers?: Record<string, string>;
  nowMs: number;
}): ServerProviderUsageSnapshot {
  const ctx = { instanceId: input.instanceId, provider: "codex" as const, nowMs: input.nowMs };
  const root = asRecord(input.json);
  const rateLimit = asRecord(root?.rate_limit);
  const headers = input.headers ?? {};
  const limits: ServerProviderUsageLimit[] = [];
  const pushWindow = (options: {
    value: unknown;
    lane: "primary" | "secondary";
    headerPrefix: string;
    scope?: string;
  }) => {
    const { headerPrefix, lane, scope, value } = options;
    const record = asRecord(value) ?? {};
    const usedPercent =
      clampPercent(asFiniteNumber(headers[`${headerPrefix}-${lane}-used-percent`])) ??
      clampPercent(asFiniteNumber(record.used_percent));
    const resetsAt = resetFromWindow(
      record,
      input.nowMs,
      headers[`${headerPrefix}-${lane}-reset-at`],
    );
    const seconds = asFiniteNumber(record.limit_window_seconds);
    const headerMinutes = asFiniteNumber(headers[`${headerPrefix}-${lane}-window-minutes`]);
    const durationMins =
      seconds === undefined ? headerMinutes : Math.max(1, Math.round(seconds / 60));
    if (usedPercent === undefined && !resetsAt) return;
    const descriptor = describeWindow(durationMins, lane);
    limits.push({
      ...descriptor,
      ...(scope ? { scope } : {}),
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
      ...(durationMins === undefined ? {} : { windowDurationMins: durationMins }),
    });
  };
  pushWindow({
    value: rateLimit?.primary_window,
    lane: "primary",
    headerPrefix: "x-codex",
  });
  pushWindow({
    value: rateLimit?.secondary_window,
    lane: "secondary",
    headerPrefix: "x-codex",
  });
  const additionalRateLimits = Array.isArray(root?.additional_rate_limits)
    ? root.additional_rate_limits
    : [];
  for (const additional of additionalRateLimits) {
    const entry = asRecord(additional);
    const scopedRateLimit = asRecord(entry?.rate_limit);
    const identifier = asString(entry?.limit_name) ?? asString(entry?.metered_feature);
    if (!scopedRateLimit || !identifier) continue;
    const headerPrefix = `x-${identifier.toLowerCase().replace(/_/gu, "-")}`;
    pushWindow({
      value: scopedRateLimit.primary_window,
      lane: "primary",
      headerPrefix,
      scope: identifier,
    });
    pushWindow({
      value: scopedRateLimit.secondary_window,
      lane: "secondary",
      headerPrefix,
      scope: identifier,
    });
  }

  const usageLines: ServerProviderUsageLine[] = [];
  const credits = asRecord(root?.credits);
  const balance =
    asFiniteNumber(headers["x-codex-credits-balance"]) ?? asFiniteNumber(credits?.balance);
  const hasCredits =
    asBoolean(headers["x-codex-credits-has-credits"]) ?? asBoolean(credits?.has_credits);
  const unlimited =
    asBoolean(headers["x-codex-credits-unlimited"]) ?? asBoolean(credits?.unlimited);
  if (hasCredits === true || (balance !== undefined && balance > 0)) {
    if (unlimited === true) {
      usageLines.push({ label: "Credits", value: "Unlimited" });
    } else if (balance !== undefined) {
      usageLines.push({ label: "Credits", value: `${formatUsd(balance)} remaining` });
    }
  }
  const planType = asString(root?.plan_type);
  return snapshot(ctx, {
    status: "ok",
    source: "codex-wham-usage",
    limits,
    usageLines,
    ...(planType ? { planName: codexPlanName(planType) } : {}),
  });
}

interface CodexAuth {
  readonly accessToken: string;
  readonly accountId?: string;
}

function readCodexAuth(value: unknown): CodexAuth | "api-key" | null {
  const record = asRecord(value);
  const tokens = asRecord(record?.tokens);
  const accessToken = asString(tokens?.access_token);
  if (accessToken) {
    const accountId = asString(tokens?.account_id);
    return { accessToken, ...(accountId ? { accountId } : {}) };
  }
  return asString(record?.OPENAI_API_KEY) ? "api-key" : null;
}

async function resolveCodexAuth(ctx: ProviderContext): Promise<CodexAuth | "api-key" | null> {
  const fileAuth = readCodexAuth(
    await readJsonFile(NodePath.join(ctx.providerHomePath ?? ctx.homeDir, "auth.json")),
  );
  if (fileAuth) return fileAuth;
  if (!ctx.useDefaultCredentialStore) return null;
  const legacyAuth = readCodexAuth(
    await readJsonFile(NodePath.join(ctx.homeDir, ".config", "codex", "auth.json")),
  );
  if (legacyAuth) return legacyAuth;
  const keychain = await readKeychainPassword({
    service: "Codex Auth",
    platform: ctx.platform,
  });
  return keychain ? readCodexAuth(decodeKeychainJson(keychain)) : null;
}

async function fetchCodexUsage(ctx: ProviderContext): Promise<ProviderFetchResult> {
  const auth = await resolveCodexAuth(ctx);
  if (!auth) return fetched(needsAuthSnapshot(ctx));
  if (auth === "api-key") {
    return fetched(
      snapshot(ctx, {
        status: "unsupported",
        source: "codex-wham-usage",
        limits: [],
        usageLines: [],
        detail: "Codex API-key auth does not expose subscription usage. Sign in with ChatGPT.",
      }),
    );
  }
  const expiresAt = decodeJwtExpMs(auth.accessToken);
  if (expiresAt !== null && expiresAt <= ctx.nowMs)
    return fetched(needsAuthSnapshot(ctx, "Token expired — run codex to refresh"));
  try {
    const result = await fetchJson({
      url: "https://chatgpt.com/backend-api/wham/usage",
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        "User-Agent": "Pathway",
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
      },
    });
    if (result.status === 401 || result.status === 403) return fetched(needsAuthSnapshot(ctx));
    if (!result.ok) {
      return failedFetchResult(ctx, "codex-wham-usage", "Codex", result);
    }
    return fetched(
      parseCodexUsage({
        instanceId: ctx.instanceId,
        json: result.json,
        headers: Object.fromEntries(result.headers),
        nowMs: ctx.nowMs,
      }),
    );
  } catch {
    return fetched(
      errorSnapshot(ctx, "codex-wham-usage", "Could not reach the Codex usage endpoint."),
    );
  }
}

export function parseClaudeUsage(input: {
  instanceId: ServerGetProviderUsageInput["instanceId"];
  json: unknown;
  nowMs: number;
  planName?: string;
}): ServerProviderUsageSnapshot {
  const ctx = {
    instanceId: input.instanceId,
    provider: "claudeAgent" as const,
    nowMs: input.nowMs,
  };
  const root = asRecord(input.json);
  const limits: ServerProviderUsageLimit[] = [];
  const identities = new Set<string>();
  const pushLimit = (limit: ServerProviderUsageLimit) => {
    const identity = `${limit.windowKey ?? "custom"}:${limit.scope ?? ""}:${limit.window}`;
    if (identities.has(identity)) return;
    identities.add(identity);
    limits.push(limit);
  };
  const pushFlatWindow = (key: string, value: unknown) => {
    const record = asRecord(value);
    if (!record) return;
    const usedPercent = clampPercent(asFiniteNumber(record.utilization));
    const resetsAt = isoFromString(record.resets_at);
    if (usedPercent === undefined && !resetsAt) return;
    const known =
      key === "five_hour"
        ? { window: "5h", windowKey: "session" as const, windowDurationMins: 300 }
        : key === "seven_day"
          ? { window: "Weekly", windowKey: "weekly" as const, windowDurationMins: 10_080 }
          : key === "seven_day_sonnet"
            ? {
                window: "Weekly",
                windowKey: "weekly" as const,
                scope: "Sonnet",
                windowDurationMins: 10_080,
              }
            : key === "seven_day_opus"
              ? {
                  window: "Weekly",
                  windowKey: "weekly" as const,
                  scope: "Opus",
                  windowDurationMins: 10_080,
                }
              : { window: titleCase(key), windowKey: "custom" as const };
    pushLimit({
      ...known,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
    });
  };
  const structuredLimits = Array.isArray(root?.limits) ? root.limits : [];
  for (const value of structuredLimits) {
    const record = asRecord(value);
    // Do not filter on is_active: enforceable scoped limits (e.g. the Fable
    // weekly carve-out) have been observed reporting is_active: false.
    if (!record) continue;
    const kind = asString(record.kind);
    const group = asString(record.group);
    if (!kind && !group) continue;
    const combined = `${kind ?? ""}_${group ?? ""}`.toLowerCase();
    const scopeRecord = asRecord(record.scope);
    const model = asRecord(scopeRecord?.model);
    const surface = asRecord(scopeRecord?.surface);
    const rawScope =
      asString(record.scope) ??
      asString(model?.display_name) ??
      asString(surface?.display_name) ??
      (group && !["session", "weekly", "monthly"].includes(group.toLowerCase())
        ? titleCase(group)
        : undefined);
    // "All models" scopes duplicate the unscoped weekly row; treat as unscoped
    // so the dedupe collapses them into it.
    const scope = rawScope?.toLowerCase() === "all models" ? undefined : rawScope;
    const descriptor = combined.includes("session")
      ? { window: "5h", windowKey: "session" as const, windowDurationMins: 300 }
      : combined.includes("weekly")
        ? { window: "Weekly", windowKey: "weekly" as const, windowDurationMins: 10_080 }
        : combined.includes("monthly")
          ? { window: "Monthly", windowKey: "monthly" as const }
          : { window: titleCase(kind ?? group ?? "custom"), windowKey: "custom" as const };
    const usedPercent = clampPercent(asFiniteNumber(record.percent));
    const resetsAt = isoFromString(record.resets_at);
    if (usedPercent === undefined && !resetsAt) continue;
    pushLimit({
      ...descriptor,
      ...(scope ? { scope } : {}),
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  for (const [key, value] of Object.entries(root ?? {})) {
    if (/^(?:five_hour|seven_day)(?:_|$)/u.test(key)) pushFlatWindow(key, value);
  }

  const usageLines: ServerProviderUsageLine[] = [];
  const extra = asRecord(root?.extra_usage);
  if (extra && extra.is_enabled !== false) {
    const usedCredits = asFiniteNumber(extra.used_credits);
    const monthlyLimit = asFiniteNumber(extra.monthly_limit);
    if (usedCredits !== undefined) {
      usageLines.push({
        label: "Extra usage",
        value:
          monthlyLimit !== undefined && monthlyLimit > 0
            ? `${formatUsd(usedCredits / 100)} of ${formatUsd(monthlyLimit / 100)}`
            : `${formatUsd(usedCredits / 100)} spent`,
      });
    }
  }
  return snapshot(ctx, {
    status: "ok",
    source: "claude-oauth-usage",
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

interface ClaudeAuth {
  readonly accessToken: string;
  readonly expiresAtMs?: number;
  readonly planName?: string;
}

function readClaudeAuth(value: unknown): ClaudeAuth | null {
  const oauth = asRecord(asRecord(value)?.claudeAiOauth);
  const accessToken = asString(oauth?.accessToken);
  if (!accessToken) return null;
  const subscription = asString(oauth?.subscriptionType);
  const tier = asString(oauth?.rateLimitTier);
  const planName = claudePlanName(subscription, tier);
  const expiresAtMs = asFiniteNumber(oauth?.expiresAt);
  return {
    accessToken,
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
    ...(planName ? { planName } : {}),
  };
}

async function resolveClaudeAuth(ctx: ProviderContext): Promise<ClaudeAuth[]> {
  const credentials: ClaudeAuth[] = [];
  const fileAuth = readClaudeAuth(
    await readJsonFile(NodePath.join(ctx.providerHomePath ?? ctx.homeDir, ".credentials.json")),
  );
  if (fileAuth) credentials.push(fileAuth);
  if (!ctx.useDefaultCredentialStore) return credentials;
  const account = asString(ctx.env.USER) ?? asString(ctx.env.LOGNAME);
  const accountValue = account
    ? await readKeychainPassword({
        service: "Claude Code-credentials",
        account,
        platform: ctx.platform,
      })
    : null;
  const keychainValue =
    accountValue ??
    (await readKeychainPassword({
      service: "Claude Code-credentials",
      platform: ctx.platform,
    }));
  const keychainAuth = keychainValue ? readClaudeAuth(decodeKeychainJson(keychainValue)) : null;
  if (keychainAuth) credentials.push(keychainAuth);
  return credentials;
}

function parseClaudeVersion(output: string): string | undefined {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)/iu)?.[1];
}

async function detectClaudeVersion(ctx: ProviderContext): Promise<string> {
  const commands = Array.from(
    new Set(ctx.providerBinaryPath ? [ctx.providerBinaryPath, "claude"] : ["claude"]),
  );
  const cacheKey = commands.join("\u0000");
  const cached = claudeVersionCache.get(cacheKey);
  if (cached) return cached;
  const pending = (async () => {
    for (const command of commands) {
      try {
        const version = parseClaudeVersion(await claudeVersionRunner(command, ctx.env));
        if (version) return version;
      } catch {
        continue;
      }
    }
    return FALLBACK_CLAUDE_VERSION;
  })();
  setBounded(claudeVersionCache, cacheKey, pending);
  return pending;
}

async function fetchClaudeUsageWithCredentials(
  ctx: ProviderContext,
  credentials: ReadonlyArray<ClaudeAuth>,
): Promise<ProviderFetchResult> {
  if (credentials.length === 0) return fetched(needsAuthSnapshot(ctx));
  const userAgent = `claude-code/${await detectClaudeVersion(ctx)}`;
  let lastNetworkError: ServerProviderUsageSnapshot | undefined;
  for (const auth of credentials) {
    if (auth.expiresAtMs !== undefined && auth.expiresAtMs <= ctx.nowMs) continue;
    try {
      const result = await fetchJson({
        url: "https://api.anthropic.com/api/oauth/usage",
        headers: {
          Authorization: `Bearer ${auth.accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          "User-Agent": userAgent,
        },
      });
      if (result.status === 401 || result.status === 403) continue;
      if (!result.ok) {
        return failedFetchResult(ctx, "claude-oauth-usage", "Claude", result);
      }
      return fetched(
        parseClaudeUsage({
          instanceId: ctx.instanceId,
          json: result.json,
          nowMs: ctx.nowMs,
          ...(auth.planName ? { planName: auth.planName } : {}),
        }),
      );
    } catch {
      lastNetworkError = errorSnapshot(
        ctx,
        "claude-oauth-usage",
        "Could not reach the Claude usage endpoint.",
      );
    }
  }
  return fetched(lastNetworkError ?? needsAuthSnapshot(ctx));
}

async function fetchClaudeUsage(ctx: ProviderContext): Promise<ProviderFetchResult> {
  return fetchClaudeUsageWithCredentials(ctx, await resolveClaudeAuth(ctx));
}

const importRuntimeModule = (specifier: string): Promise<unknown> =>
  Function("specifier", "return import(specifier)")(specifier) as Promise<unknown>;

async function readCursorState(dbPath: string): Promise<Record<string, string>> {
  interface Statement {
    get: (...params: ReadonlyArray<unknown>) => unknown;
  }
  interface Database {
    query?: (sql: string) => Statement;
    prepare?: (sql: string) => Statement;
    close: () => unknown;
  }
  let database: Database | null = null;
  const result: Record<string, string> = {};
  try {
    if (typeof Bun !== "undefined") {
      const { Database } = (await importRuntimeModule("bun:sqlite")) as {
        Database: new (path: string, options: { readonly: boolean }) => Database;
      };
      database = new Database(dbPath, { readonly: true });
    } else {
      const { DatabaseSync } = await import("node:sqlite");
      database = new DatabaseSync(dbPath, { readOnly: true }) as unknown as Database;
    }
    const statement =
      database.query?.("SELECT value FROM ItemTable WHERE key = ?") ??
      database.prepare?.("SELECT value FROM ItemTable WHERE key = ?");
    if (!statement) return result;
    for (const key of ["cursorAuth/accessToken", "cursorAuth/stripeMembershipType"]) {
      const row = statement.get(key) as { value?: unknown } | undefined;
      const value =
        typeof row?.value === "string"
          ? row.value
          : row?.value instanceof Uint8Array
            ? Buffer.from(row.value).toString("utf8")
            : undefined;
      if (value) result[key] = value;
    }
  } catch {
    return result;
  } finally {
    try {
      database?.close();
    } catch {
      // Read-only cleanup is best effort.
    }
  }
  return result;
}

export function parseCursorUsage(input: {
  instanceId: ServerGetProviderUsageInput["instanceId"];
  usage: unknown;
  credits?: unknown;
  planName?: string;
  nowMs: number;
}): ServerProviderUsageSnapshot {
  const ctx = { instanceId: input.instanceId, provider: "cursor" as const, nowMs: input.nowMs };
  const usage = asRecord(input.usage);
  const planUsage = asRecord(usage?.planUsage);
  const spendLimit = asRecord(usage?.spendLimitUsage);
  const limits: ServerProviderUsageLimit[] = [];
  const usedPercent = clampPercent(asFiniteNumber(planUsage?.totalPercentUsed));
  const resetsAt = isoFromUnixMillis(usage?.billingCycleEnd);
  if (usedPercent !== undefined || resetsAt) {
    limits.push({
      window: "Current",
      windowKey: "monthly",
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  const usageLines: ServerProviderUsageLine[] = [];
  const individualLimit = asFiniteNumber(spendLimit?.individualLimit);
  const individualRemaining = asFiniteNumber(spendLimit?.individualRemaining);
  if (individualLimit !== undefined && individualLimit > 0) {
    const used =
      individualRemaining === undefined
        ? undefined
        : Math.max(0, individualLimit - individualRemaining);
    usageLines.push({
      label: "On-demand",
      value:
        used === undefined
          ? `${formatUsd(individualLimit / 100)} limit`
          : `${formatUsd(used / 100)} of ${formatUsd(individualLimit / 100)}`,
    });
  }
  const credits = asRecord(input.credits);
  const totalCents = asFiniteNumber(credits?.totalCents);
  const usedCents = asFiniteNumber(credits?.usedCents);
  if (credits?.hasCreditGrants !== false && totalCents !== undefined && totalCents > 0) {
    const remaining = usedCents === undefined ? totalCents : Math.max(0, totalCents - usedCents);
    usageLines.push({
      label: "Credits",
      value: `${formatUsd(remaining / 100)} of ${formatUsd(totalCents / 100)} remaining`,
    });
  }
  return snapshot(ctx, {
    status: "ok",
    source: "cursor-dashboard",
    limits,
    usageLines,
    ...(input.planName ? { planName: input.planName } : {}),
  });
}

function cursorStatePath(ctx: Pick<ProviderContext, "env" | "homeDir" | "platform">): string {
  const segments = ["Cursor", "User", "globalStorage", "state.vscdb"];
  if (ctx.platform === "darwin") {
    return NodePath.join(ctx.homeDir, "Library", "Application Support", ...segments);
  }
  if (ctx.platform === "win32") {
    return NodePath.join(
      ctx.env.APPDATA ?? NodePath.join(ctx.homeDir, "AppData", "Roaming"),
      ...segments,
    );
  }
  return NodePath.join(ctx.homeDir, ".config", ...segments);
}

async function resolveCursorAuth(ctx: ProviderContext): Promise<{
  accessToken: string;
  planName?: string;
} | null> {
  const state = await readCursorState(cursorStatePath(ctx));
  const accessToken = asString(state["cursorAuth/accessToken"]);
  if (accessToken) {
    const plan = asString(state["cursorAuth/stripeMembershipType"]);
    return { accessToken, ...(plan ? { planName: titleCase(plan) } : {}) };
  }
  const keychain = await readKeychainPassword({
    service: "cursor-access-token",
    platform: ctx.platform,
  });
  return keychain ? { accessToken: keychain } : null;
}

async function fetchCursorUsage(ctx: ProviderContext): Promise<ProviderFetchResult> {
  const auth = await resolveCursorAuth(ctx);
  if (!auth) return fetched(needsAuthSnapshot(ctx));
  const expiresAt = decodeJwtExpMs(auth.accessToken);
  if (expiresAt !== null && expiresAt <= ctx.nowMs) return fetched(needsAuthSnapshot(ctx));
  const headers = {
    Authorization: `Bearer ${auth.accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    "Connect-Protocol-Version": "1",
  };
  try {
    const usage = await fetchJson({
      url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
      method: "POST",
      headers,
      body: {},
    });
    if (usage.status === 401 || usage.status === 403) return fetched(needsAuthSnapshot(ctx));
    if (!usage.ok) {
      return failedFetchResult(ctx, "cursor-dashboard", "Cursor", usage);
    }
    let credits: unknown;
    let creditsRetryAfterUntilMs: number | undefined;
    try {
      const result = await fetchJson({
        url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance",
        method: "POST",
        headers,
        body: {},
      });
      if (result.ok) {
        credits = result.json;
      } else if (result.status === 429) {
        creditsRetryAfterUntilMs = retryAfterUntilMs(result.headers.get("retry-after"), ctx.nowMs);
      }
    } catch {
      credits = undefined;
    }
    const snapshotValue = parseCursorUsage({
      instanceId: ctx.instanceId,
      usage: usage.json,
      credits,
      nowMs: ctx.nowMs,
      ...(auth.planName ? { planName: auth.planName } : {}),
    });
    return {
      snapshot:
        creditsRetryAfterUntilMs === undefined
          ? snapshotValue
          : {
              ...snapshotValue,
              detail: `Cursor credit refresh is rate limited until ${new Date(creditsRetryAfterUntilMs).toISOString()}.`,
            },
      ...(creditsRetryAfterUntilMs === undefined
        ? {}
        : { retryAfterUntilMs: creditsRetryAfterUntilMs }),
    };
  } catch {
    return fetched(errorSnapshot(ctx, "cursor-dashboard", "Could not reach the Cursor dashboard."));
  }
}

async function fetchProviderUsage(ctx: ProviderContext): Promise<ProviderFetchResult> {
  if (ctx.provider === "codex") return fetchCodexUsage(ctx);
  if (ctx.provider === "claudeAgent") return fetchClaudeUsage(ctx);
  return fetchCursorUsage(ctx);
}

function cacheTtl(snapshotValue: ServerProviderUsageSnapshot): number {
  return snapshotValue.status === "ok" && snapshotValue.stale !== true
    ? CACHE_TTL_MS
    : DEGRADED_CACHE_TTL_MS;
}

function cacheKeyFor(input: Pick<ServerProviderUsageSnapshot, "instanceId" | "provider">): string {
  return `${input.instanceId}:${input.provider}`;
}

function storeSnapshot(input: { snapshot: ServerProviderUsageSnapshot; fetchedAtMs: number }): {
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly changed: boolean;
} {
  const cacheKey = cacheKeyFor(input.snapshot);
  const current = snapshotCache.get(cacheKey);
  const currentIsPush = current?.snapshot.source === "codex-app-server-push";
  const incomingIsPush = input.snapshot.source === "codex-app-server-push";
  if (
    current &&
    (current.fetchedAtMs > input.fetchedAtMs ||
      (current.fetchedAtMs === input.fetchedAtMs && currentIsPush && !incomingIsPush))
  ) {
    return { snapshot: current.snapshot, changed: false };
  }
  setBounded(snapshotCache, cacheKey, {
    snapshot: input.snapshot,
    fetchedAtMs: input.fetchedAtMs,
  });
  return { snapshot: input.snapshot, changed: true };
}

function replacePushedLimit(
  limits: ReadonlyArray<ServerProviderUsageLimit>,
  incoming: ServerProviderUsageLimit | undefined,
  lane: "primary" | "secondary",
): ReadonlyArray<ServerProviderUsageLimit> {
  if (incoming === undefined) return limits;
  const expectedWindowKey = lane === "primary" ? "session" : "weekly";
  const index = limits.findIndex(
    (limit) =>
      limit.scope === undefined &&
      (limit.windowKey === expectedWindowKey ||
        (limit.windowKey === incoming.windowKey && limit.window === incoming.window)),
  );
  return index === -1
    ? [...limits, incoming]
    : limits.map((limit, limitIndex) => (limitIndex === index ? incoming : limit));
}

function mergePushedSnapshot(
  input: PushedProviderUsageSnapshot,
  current: ServerProviderUsageSnapshot | undefined,
): ProviderUsageSnapshotContent {
  const { primaryLimit, secondaryLimit, updatesUsageLines, ...snapshotInput } = input;
  if (current === undefined) return snapshotInput;
  const limits = replacePushedLimit(
    replacePushedLimit(current.limits, primaryLimit, "primary"),
    secondaryLimit,
    "secondary",
  );
  const planName = snapshotInput.planName ?? current.planName;
  return {
    ...snapshotInput,
    limits,
    usageLines: updatesUsageLines === true ? snapshotInput.usageLines : current.usageLines,
    ...(planName === undefined ? {} : { planName }),
  };
}

export const ingestPushedSnapshot = Effect.fn("ProviderUsage.ingestPushedSnapshot")(function* (
  input: PushedProviderUsageSnapshot,
  nowMs = Date.now(),
) {
  const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  const cacheKey = cacheKeyFor(input);
  const merged = mergePushedSnapshot(input, snapshotCache.get(cacheKey)?.snapshot);
  const stored = storeSnapshot({
    snapshot: {
      ...merged,
      source: "codex-app-server-push",
      updatedAt: now,
      fetchedAt: now,
    },
    fetchedAtMs: nowMs,
  });
  if (stored.changed) {
    yield* PubSub.publish(snapshotChanges, undefined);
  }
  return stored.snapshot;
});

async function resolveProviderUsage(
  ctx: ProviderContext,
  forceRefresh: boolean,
  fetchUsage: (ctx: ProviderContext) => Promise<ProviderFetchResult> = fetchProviderUsage,
): Promise<ServerProviderUsageSnapshot> {
  const cacheKey = cacheKeyFor(ctx);
  const blockedUntil = getLru(retryAfterGates, cacheKey);
  const cached = getLru(snapshotCache, cacheKey);
  if (blockedUntil !== undefined) {
    if (blockedUntil > ctx.nowMs) {
      const detail = `Provider usage refresh paused until ${new Date(blockedUntil).toISOString()} after a rate limit.`;
      return cached
        ? {
            ...cached.snapshot,
            ...(cached.snapshot.status === "ok" ? { stale: true } : {}),
            detail,
          }
        : errorSnapshot(ctx, "provider-rate-limit", detail);
    }
    retryAfterGates.delete(cacheKey);
  }
  const pending = getLru(inFlightFetches, cacheKey);
  if (pending && (!forceRefresh || pending.forced)) return pending.promise;
  if (!forceRefresh && cached && ctx.nowMs - cached.fetchedAtMs < cacheTtl(cached.snapshot)) {
    return cached.snapshot;
  }
  let entry: InFlightFetch;
  const request = fetchUsage(ctx).then(async (outcome) => {
    if (outcome.retryAfterUntilMs !== undefined) {
      setBounded(retryAfterGates, cacheKey, outcome.retryAfterUntilMs);
    }
    const result = outcome.snapshot;
    const resolved =
      result.status === "error" && cached?.snapshot.status === "ok"
        ? {
            ...cached.snapshot,
            stale: true,
            detail: result.detail ?? "Live usage could not be refreshed; showing the last values.",
          }
        : result;
    if (inFlightFetches.get(cacheKey) !== entry) return resolved;
    const stored = storeSnapshot({
      snapshot: resolved,
      fetchedAtMs:
        result.status === "error" && cached?.snapshot.status === "ok"
          ? cached.fetchedAtMs
          : ctx.nowMs,
    });
    if (stored.changed) {
      await Effect.runPromise(PubSub.publish(snapshotChanges, undefined));
    }
    return stored.snapshot;
  });
  entry = { forced: forceRefresh, promise: request };
  setBounded(inFlightFetches, cacheKey, entry);
  try {
    return await request;
  } finally {
    if (inFlightFetches.get(cacheKey) === entry) inFlightFetches.delete(cacheKey);
  }
}

export const getProviderUsage = Effect.fn("ProviderUsage.get")(function* (
  input: ServerGetProviderUsageInput,
) {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  const baseEnvironment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const ctx = buildContext(settings, input, baseEnvironment, platform);
  return yield* Effect.promise(() => resolveProviderUsage(ctx, input.forceRefresh === true));
});

function isProviderUsageDriver(driver: string): driver is ProviderUsageDriver {
  return driver === "codex" || driver === "claudeAgent" || driver === "cursor";
}

const configuredProviderUsageInputs = Effect.fn("ProviderUsage.configuredInputs")(function* () {
  const serverSettings = yield* ServerSettingsService;
  const settings = yield* serverSettings.getSettings;
  return Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) =>
    instance.enabled !== false && isProviderUsageDriver(instance.driver)
      ? [
          {
            instanceId: ProviderInstanceId.make(instanceId),
            provider: instance.driver,
          } satisfies ServerGetProviderUsageInput,
        ]
      : [],
  );
});

const readCachedProviderUsageList = Effect.fn("ProviderUsage.readCachedList")(function* () {
  const inputs = yield* configuredProviderUsageInputs();
  return inputs.flatMap((input) => {
    const cached = snapshotCache.get(cacheKeyFor(input));
    return cached ? [cached.snapshot] : [];
  });
});

const loadProviderUsageList = Effect.fn("ProviderUsage.loadList")(function* () {
  const inputs = yield* configuredProviderUsageInputs();
  yield* Effect.forEach(inputs, (input) => getProviderUsage(input).pipe(Effect.asVoid), {
    concurrency: "unbounded",
    discard: true,
  });
  return yield* readCachedProviderUsageList();
});

export const subscribeProviderUsage = () =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Match ScheduledTaskService: register first so a write during bootstrap
      // is buffered, then emit the complete current list before live updates.
      const subscription = yield* PubSub.subscribe(snapshotChanges);
      const current = yield* loadProviderUsageList();
      return Stream.concat(
        Stream.make(current),
        Stream.fromSubscription(subscription).pipe(
          Stream.mapEffect(() => readCachedProviderUsageList()),
        ),
      );
    }),
  );

function testingContext(input: {
  instanceId: ServerGetProviderUsageInput["instanceId"];
  provider: ProviderUsageDriver;
  nowMs: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
  providerHomePath?: string | null;
  providerBinaryPath?: string | null;
}): ProviderContext {
  const homeDir = input.homeDir ?? "/tmp/pathway-provider-usage-test";
  return {
    instanceId: input.instanceId,
    provider: input.provider,
    nowMs: input.nowMs,
    env: input.env ?? {},
    platform: input.platform ?? "linux",
    homeDir,
    providerHomePath: input.providerHomePath ?? null,
    providerBinaryPath: input.providerBinaryPath ?? null,
    useDefaultCredentialStore: false,
  };
}

export const providerUsageTestKit = {
  cacheSizes: () => ({
    snapshots: snapshotCache.size,
    inFlight: inFlightFetches.size,
    retryAfter: retryAfterGates.size,
  }),
  claudePlanNameFromAuth: (value: unknown) => readClaudeAuth(value)?.planName,
  cursorStatePath: (input: {
    env?: NodeJS.ProcessEnv;
    homeDir: string;
    platform: NodeJS.Platform;
  }) => cursorStatePath({ ...input, env: input.env ?? {} }),
  fetchClaude: (
    input: Parameters<typeof testingContext>[0],
    credentials: ReadonlyArray<ClaudeAuth>,
  ) => fetchClaudeUsageWithCredentials(testingContext(input), credentials),
  fetchCodex: (input: Parameters<typeof testingContext>[0]) =>
    fetchCodexUsage(testingContext(input)),
  loadList: loadProviderUsageList,
  resolve: (
    input: Parameters<typeof testingContext>[0] & { forceRefresh?: boolean },
    fetchUsage: () => Promise<ProviderFetchResult>,
  ) => resolveProviderUsage(testingContext(input), input.forceRefresh === true, () => fetchUsage()),
  retryAfterUntilMs,
  setClaudeVersionRunner: (runner: ClaudeVersionRunner) => {
    claudeVersionRunner = runner;
    claudeVersionCache.clear();
  },
};

/** Test-only cache reset. */
export function resetProviderUsageCache(): void {
  snapshotCache.clear();
  inFlightFetches.clear();
  retryAfterGates.clear();
  claudeVersionCache.clear();
  claudeVersionRunner = defaultClaudeVersionRunner;
}
