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
} from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";

import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";

const execFileAsync = NodeUtil.promisify(NodeChildProcess.execFile);
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 5 * 60 * 1000;
const DEGRADED_CACHE_TTL_MS = 60 * 1000;

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
  readonly useDefaultCredentialStore: boolean;
  readonly nowMs: number;
}

interface CachedSnapshot {
  readonly snapshot: ServerProviderUsageSnapshot;
  readonly fetchedAtMs: number;
}

const snapshotCache = new Map<string, CachedSnapshot>();
const inFlightFetches = new Map<string, Promise<ServerProviderUsageSnapshot>>();

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
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
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
  input: Omit<ServerProviderUsageSnapshot, "instanceId" | "provider" | "updatedAt">,
): ServerProviderUsageSnapshot {
  return {
    instanceId: ctx.instanceId,
    provider: ctx.provider,
    updatedAt: new Date(ctx.nowMs).toISOString(),
    ...input,
  };
}

function needsAuthSnapshot(ctx: ProviderContext): ServerProviderUsageSnapshot {
  const providerName =
    ctx.provider === "claudeAgent" ? "Claude" : ctx.provider === "codex" ? "Codex" : "Cursor";
  return snapshot(ctx, {
    status: "needs-auth",
    source: "provider-credentials",
    limits: [],
    usageLines: [],
    detail: `Sign in with the ${providerName} CLI on this environment to see live usage.`,
  });
}

function errorSnapshot(
  ctx: ProviderContext,
  source: string,
  detail: string,
): ServerProviderUsageSnapshot {
  return snapshot(ctx, { status: "error", source, limits: [], usageLines: [], detail });
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
    useDefaultCredentialStore: true,
    nowMs: Date.now(),
  };
}

function resetFromWindow(
  window: Record<string, unknown> | null,
  nowMs: number,
): string | undefined {
  return (
    isoFromUnixSeconds(window?.reset_at) ??
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
  const pushWindow = (
    window: string,
    value: unknown,
    header: string,
    fallbackDurationMins: number,
  ) => {
    const record = asRecord(value);
    if (!record) return;
    const usedPercent =
      clampPercent(asFiniteNumber(headers[header])) ??
      clampPercent(asFiniteNumber(record.used_percent));
    const resetsAt = resetFromWindow(record, input.nowMs);
    const seconds = asFiniteNumber(record.limit_window_seconds);
    if (usedPercent === undefined && !resetsAt) return;
    limits.push({
      window,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins: seconds === undefined ? fallbackDurationMins : Math.round(seconds / 60),
    });
  };
  pushWindow("5h", rateLimit?.primary_window, "x-codex-primary-used-percent", 300);
  pushWindow("Weekly", rateLimit?.secondary_window, "x-codex-secondary-used-percent", 10_080);

  const usageLines: ServerProviderUsageLine[] = [];
  const credits = asRecord(root?.credits);
  const balance =
    asFiniteNumber(headers["x-codex-credits-balance"]) ?? asFiniteNumber(credits?.balance);
  if (balance !== undefined && (credits?.has_credits !== false || balance > 0)) {
    usageLines.push({ label: "Credits", value: `${formatUsd(balance)} remaining` });
  }
  const planType = asString(root?.plan_type);
  return snapshot(ctx, {
    status: "ok",
    source: "codex-wham-usage",
    limits,
    usageLines,
    ...(planType ? { planName: titleCase(planType) } : {}),
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

async function fetchCodexUsage(ctx: ProviderContext): Promise<ServerProviderUsageSnapshot> {
  const auth = await resolveCodexAuth(ctx);
  if (!auth) return needsAuthSnapshot(ctx);
  if (auth === "api-key") {
    return snapshot(ctx, {
      status: "unsupported",
      source: "codex-wham-usage",
      limits: [],
      usageLines: [],
      detail: "Codex API-key auth does not expose subscription usage. Sign in with ChatGPT.",
    });
  }
  const expiresAt = decodeJwtExpMs(auth.accessToken);
  if (expiresAt !== null && expiresAt <= ctx.nowMs) return needsAuthSnapshot(ctx);
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
    if (result.status === 401 || result.status === 403) return needsAuthSnapshot(ctx);
    if (!result.ok) {
      return errorSnapshot(
        ctx,
        "codex-wham-usage",
        `Codex usage request failed (${result.status}).`,
      );
    }
    return parseCodexUsage({
      instanceId: ctx.instanceId,
      json: result.json,
      headers: Object.fromEntries(result.headers),
      nowMs: ctx.nowMs,
    });
  } catch {
    return errorSnapshot(ctx, "codex-wham-usage", "Could not reach the Codex usage endpoint.");
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
  const pushWindow = (window: string, value: unknown, windowDurationMins: number) => {
    const record = asRecord(value);
    if (!record) return;
    const usedPercent = clampPercent(asFiniteNumber(record.utilization));
    const resetsAt = isoFromString(record.resets_at);
    if (usedPercent === undefined && !resetsAt) return;
    limits.push({
      window,
      ...(usedPercent === undefined ? {} : { usedPercent }),
      ...(resetsAt ? { resetsAt } : {}),
      windowDurationMins,
    });
  };
  pushWindow("5h", root?.five_hour, 300);
  pushWindow("Weekly", root?.seven_day, 10_080);
  pushWindow("Sonnet", root?.seven_day_sonnet, 10_080);
  pushWindow("Opus", root?.seven_day_opus, 10_080);

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
  const tier = asString(oauth?.rateLimitTier)
    ?.match(/(\d+x)/iu)?.[1]
    ?.toLowerCase();
  const planName = subscription
    ? `${titleCase(subscription)}${tier ? ` (${tier})` : ""}`
    : undefined;
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

async function fetchClaudeUsage(ctx: ProviderContext): Promise<ServerProviderUsageSnapshot> {
  const credentials = await resolveClaudeAuth(ctx);
  if (credentials.length === 0) return needsAuthSnapshot(ctx);
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
          "User-Agent": "claude-code/2.1.69",
        },
      });
      if (result.status === 401 || result.status === 403) continue;
      if (!result.ok) {
        return errorSnapshot(
          ctx,
          "claude-oauth-usage",
          `Claude usage request failed (${result.status}).`,
        );
      }
      return parseClaudeUsage({
        instanceId: ctx.instanceId,
        json: result.json,
        nowMs: ctx.nowMs,
        ...(auth.planName ? { planName: auth.planName } : {}),
      });
    } catch {
      return errorSnapshot(ctx, "claude-oauth-usage", "Could not reach the Claude usage endpoint.");
    }
  }
  return needsAuthSnapshot(ctx);
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

async function resolveCursorAuth(ctx: ProviderContext): Promise<{
  accessToken: string;
  planName?: string;
} | null> {
  const segments = ["Cursor", "User", "globalStorage", "state.vscdb"];
  const dbPath =
    ctx.platform === "darwin"
      ? NodePath.join(ctx.homeDir, "Library", "Application Support", ...segments)
      : ctx.platform === "win32" && ctx.env.APPDATA
        ? NodePath.join(ctx.env.APPDATA, ...segments)
        : NodePath.join(ctx.homeDir, ".config", ...segments);
  const state = await readCursorState(dbPath);
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

async function fetchCursorUsage(ctx: ProviderContext): Promise<ServerProviderUsageSnapshot> {
  const auth = await resolveCursorAuth(ctx);
  if (!auth) return needsAuthSnapshot(ctx);
  const expiresAt = decodeJwtExpMs(auth.accessToken);
  if (expiresAt !== null && expiresAt <= ctx.nowMs) return needsAuthSnapshot(ctx);
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
    if (usage.status === 401 || usage.status === 403) return needsAuthSnapshot(ctx);
    if (!usage.ok) {
      return errorSnapshot(
        ctx,
        "cursor-dashboard",
        `Cursor usage request failed (${usage.status}).`,
      );
    }
    let credits: unknown;
    try {
      const result = await fetchJson({
        url: "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCreditGrantsBalance",
        method: "POST",
        headers,
        body: {},
      });
      if (result.ok) credits = result.json;
    } catch {
      credits = undefined;
    }
    return parseCursorUsage({
      instanceId: ctx.instanceId,
      usage: usage.json,
      credits,
      nowMs: ctx.nowMs,
      ...(auth.planName ? { planName: auth.planName } : {}),
    });
  } catch {
    return errorSnapshot(ctx, "cursor-dashboard", "Could not reach the Cursor dashboard.");
  }
}

async function fetchProviderUsage(ctx: ProviderContext): Promise<ServerProviderUsageSnapshot> {
  if (ctx.provider === "codex") return fetchCodexUsage(ctx);
  if (ctx.provider === "claudeAgent") return fetchClaudeUsage(ctx);
  return fetchCursorUsage(ctx);
}

function cacheTtl(snapshotValue: ServerProviderUsageSnapshot): number {
  return snapshotValue.status === "ok" && snapshotValue.stale !== true
    ? CACHE_TTL_MS
    : DEGRADED_CACHE_TTL_MS;
}

async function resolveProviderUsage(
  ctx: ProviderContext,
  forceRefresh: boolean,
): Promise<ServerProviderUsageSnapshot> {
  const cacheKey = `${ctx.instanceId}:${ctx.provider}`;
  const pending = inFlightFetches.get(cacheKey);
  if (pending) return pending;
  const cached = snapshotCache.get(cacheKey);
  if (!forceRefresh && cached && ctx.nowMs - cached.fetchedAtMs < cacheTtl(cached.snapshot)) {
    return cached.snapshot;
  }
  const request = fetchProviderUsage(ctx).then((result) => {
    const resolved =
      result.status === "error" && cached?.snapshot.status === "ok"
        ? {
            ...cached.snapshot,
            updatedAt: new Date(ctx.nowMs).toISOString(),
            stale: true,
            detail: result.detail ?? "Live usage could not be refreshed; showing the last values.",
          }
        : result;
    snapshotCache.set(cacheKey, { snapshot: resolved, fetchedAtMs: ctx.nowMs });
    return resolved;
  });
  inFlightFetches.set(cacheKey, request);
  try {
    return await request;
  } finally {
    if (inFlightFetches.get(cacheKey) === request) inFlightFetches.delete(cacheKey);
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

/** Test-only cache reset. */
export function resetProviderUsageCache(): void {
  snapshotCache.clear();
  inFlightFetches.clear();
}
