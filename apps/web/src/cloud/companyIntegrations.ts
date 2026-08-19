/** Online Convex client for company-owned integrations and durable automation. */
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { IssueAutomationSettings } from "@spiritdevs/contracts/settings";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";

import type { ConvexAuthTokenFetcher } from "./syncTransport";

type Args = Record<string, unknown>;
export const COMPANY_INTEGRATIONS_QUERY_TIMEOUT_MS = 10_000;

// #region DEBUG
let nextCompanyIntegrationsDebugClientId = 1;

function debugCompanyIntegrations(
  hypothesis: string,
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  if (typeof window === "undefined") return;
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis, event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

export function withCompanyIntegrationsQueryTimeout<R>(
  request: Promise<R>,
  operation: string,
  timeoutMs = COMPANY_INTEGRATIONS_QUERY_TIMEOUT_MS,
): Promise<R> {
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      reject(new Error(`${operation} timed out. Check your cloud connection, then try again.`));
    }, timeoutMs);
    void request.then(resolve, reject).finally(() => globalThis.clearTimeout(timeout));
  });
}

const queryRef = <A extends Args, R>(name: string) => makeFunctionReference<"query", A, R>(name);
const mutationRef = <A extends Args, R>(name: string) =>
  makeFunctionReference<"mutation", A, R>(name);
const actionRef = <A extends Args, R>(name: string) => makeFunctionReference<"action", A, R>(name);

export interface CompanySlackIntegrationSummary {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceDomain: string | null;
  readonly state: "draft" | "active" | "disconnected";
  readonly activatedAt: number | null;
  readonly credentialPresent: boolean;
  readonly preferredEnvironmentId: string | null;
  readonly backupEnvironmentIds: ReadonlyArray<string>;
  readonly configurationRevision: number;
  readonly controllerEnvironmentId: string | null;
  readonly leaseGeneration: number;
  readonly leaseExpiresAt: number | null;
  readonly lastPollAt: number | null;
  readonly currentError: string | null;
  readonly blockedReason: string | null;
  readonly healthHistory: ReadonlyArray<{
    readonly at: number;
    readonly state: "healthy" | "error";
    readonly error: string | null;
  }>;
  readonly watchCount: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CompanySlackWatchSummary {
  readonly id: string;
  readonly integrationId: string;
  readonly channelId: string;
  readonly channelName: string;
  readonly cloudProjectId: string | null;
  readonly cycleId: string | null;
  readonly autoInvestigate: boolean;
  readonly autoAssign: boolean;
  readonly trigger: {
    readonly reactionRoutes: ReadonlyArray<{
      readonly emoji: string;
      readonly cloudProjectId: string | null;
      readonly autoInvestigate: boolean | null;
    }>;
    readonly everyMessage: boolean;
    readonly botMention: boolean;
  };
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CompanyAutomationSettingsSummary {
  readonly enabled: boolean;
  readonly activatedAt: number | null;
  readonly revision: number;
  readonly settings: IssueAutomationSettings;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface CompanyAutomationJobSummary {
  readonly id: string;
  readonly issueId: string;
  readonly kind: string;
  readonly state:
    | "pending"
    | "blocked"
    | "claimed"
    | "running"
    | "succeeded"
    | "failed"
    | "canceled";
  readonly targetEnvironmentId: string | null;
  readonly attempts: number;
  readonly blockCode: string | null;
  readonly diagnostic: string | null;
  readonly nextRetryAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

const refs = {
  list: queryRef<{ companyId: CompanyId }, ReadonlyArray<CompanySlackIntegrationSummary>>(
    "slackIntegrations:list",
  ),
  connect: actionRef<
    { companyId: CompanyId; token: string; expectedIntegrationId?: string },
    CompanySlackIntegrationSummary
  >("slackIntegrations:connect"),
  setControllerPool: mutationRef<
    {
      companyId: CompanyId;
      integrationId: string;
      preferredEnvironmentId: string | null;
      backupEnvironmentIds: ReadonlyArray<string>;
    },
    CompanySlackIntegrationSummary
  >("slackIntegrations:setControllerPool"),
  activate: mutationRef<
    { companyId: CompanyId; integrationId: string; legacyWatchersAcknowledged: boolean },
    CompanySlackIntegrationSummary
  >("slackIntegrations:activate"),
  disconnect: mutationRef<
    { companyId: CompanyId; integrationId: string },
    CompanySlackIntegrationSummary
  >("slackIntegrations:disconnect"),
  remove: mutationRef<
    { companyId: CompanyId; integrationId: string; confirmWorkspaceName: string },
    null
  >("slackIntegrations:remove"),
  listWatches: queryRef<
    { companyId: CompanyId; integrationId: string },
    ReadonlyArray<CompanySlackWatchSummary>
  >("slackOperations:listWatches"),
  createWatch: mutationRef<Args, CompanySlackWatchSummary>("slackOperations:createWatch"),
  updateWatch: mutationRef<Args, CompanySlackWatchSummary>("slackOperations:updateWatch"),
  deleteWatch: mutationRef<Args, null>("slackOperations:deleteWatch"),
  getAutomation: queryRef<{ companyId: CompanyId }, CompanyAutomationSettingsSummary | null>(
    "issueAutomation:getSettings",
  ),
  saveAutomation: mutationRef<
    { companyId: CompanyId; settings: IssueAutomationSettings; expectedRevision: number | null },
    CompanyAutomationSettingsSummary
  >("issueAutomation:saveSettings"),
  setAutomationEnabled: mutationRef<
    { companyId: CompanyId; enabled: boolean },
    CompanyAutomationSettingsSummary
  >("issueAutomation:setEnabled"),
  listJobs: queryRef<
    { companyId: CompanyId; limit?: number },
    ReadonlyArray<CompanyAutomationJobSummary>
  >("issueAutomation:listJobs"),
  attentionCount: queryRef<{ companyId: CompanyId }, number>("issueAutomation:attentionCount"),
  retryJob: mutationRef<{ companyId: CompanyId; jobId: string }, null>("issueAutomation:retry"),
  cancelJob: mutationRef<{ companyId: CompanyId; jobId: string }, null>("issueAutomation:cancel"),
} as const;

export interface CompanyIntegrationsClient {
  readonly list: (companyId: CompanyId) => Promise<ReadonlyArray<CompanySlackIntegrationSummary>>;
  readonly connect: (
    companyId: CompanyId,
    token: string,
    expectedIntegrationId?: string,
  ) => Promise<CompanySlackIntegrationSummary>;
  readonly setControllerPool: (args: Args) => Promise<CompanySlackIntegrationSummary>;
  readonly activate: (args: Args) => Promise<CompanySlackIntegrationSummary>;
  readonly disconnect: (args: Args) => Promise<CompanySlackIntegrationSummary>;
  readonly remove: (args: Args) => Promise<void>;
  readonly listWatches: (
    companyId: CompanyId,
    integrationId: string,
  ) => Promise<ReadonlyArray<CompanySlackWatchSummary>>;
  readonly createWatch: (args: Args) => Promise<CompanySlackWatchSummary>;
  readonly updateWatch: (args: Args) => Promise<CompanySlackWatchSummary>;
  readonly deleteWatch: (args: Args) => Promise<void>;
  readonly getAutomation: (
    companyId: CompanyId,
  ) => Promise<CompanyAutomationSettingsSummary | null>;
  readonly saveAutomation: (args: {
    companyId: CompanyId;
    settings: IssueAutomationSettings;
    expectedRevision: number | null;
  }) => Promise<CompanyAutomationSettingsSummary>;
  readonly setAutomationEnabled: (
    companyId: CompanyId,
    enabled: boolean,
  ) => Promise<CompanyAutomationSettingsSummary>;
  readonly listJobs: (companyId: CompanyId) => Promise<ReadonlyArray<CompanyAutomationJobSummary>>;
  readonly attentionCount: (companyId: CompanyId) => Promise<number>;
  readonly retryJob: (companyId: CompanyId, jobId: string) => Promise<void>;
  readonly cancelJob: (companyId: CompanyId, jobId: string) => Promise<void>;
  readonly close: () => Promise<void>;
}

interface CompanyIntegrationsClientLifetime {
  mounts: number;
  closed: boolean;
}

const companyIntegrationsClientLifetimes = new WeakMap<
  CompanyIntegrationsClient,
  CompanyIntegrationsClientLifetime
>();

/** Keeps Strict Mode's setup-cleanup-setup probe from closing a still-mounted client. */
export function retainCompanyIntegrationsClient(client: CompanyIntegrationsClient): () => void {
  const lifetime = companyIntegrationsClientLifetimes.get(client) ?? { mounts: 0, closed: false };
  lifetime.mounts += 1;
  companyIntegrationsClientLifetimes.set(client, lifetime);
  return () => {
    lifetime.mounts = Math.max(0, lifetime.mounts - 1);
    queueMicrotask(() => {
      if (lifetime.mounts !== 0 || lifetime.closed) return;
      lifetime.closed = true;
      companyIntegrationsClientLifetimes.delete(client);
      void client.close();
    });
  };
}

export function makeCompanyIntegrationsClient(options: {
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
}): CompanyIntegrationsClient {
  // #region DEBUG
  const debugClientId = nextCompanyIntegrationsDebugClientId++;
  debugCompanyIntegrations("H3", "integrations-client-created", { debugClientId });
  // #endregion DEBUG
  const client = new ConvexClient(options.convexUrl);
  client.setAuth(async (args) => {
    // #region DEBUG
    const startedAt = performance.now();
    debugCompanyIntegrations("H1", "integrations-token-fetch-started", {
      debugClientId,
      forceRefresh: args.forceRefreshToken,
    });
    // #endregion DEBUG
    const token = await options.fetchToken(args);
    // #region DEBUG
    debugCompanyIntegrations("H1", "integrations-token-fetch-finished", {
      debugClientId,
      forceRefresh: args.forceRefreshToken,
      hasToken: token !== null && token !== undefined,
      durationMs: Math.round(performance.now() - startedAt),
    });
    // #endregion DEBUG
    return token;
  });
  const query = <R>(reference: FunctionReference<"query">, args: Args, operation: string) => {
    // #region DEBUG
    const startedAt = performance.now();
    const stateBefore = client.connectionState();
    debugCompanyIntegrations("H2", "integrations-query-started", {
      debugClientId,
      operation,
      connected: stateBefore.isWebSocketConnected,
      hasEverConnected: stateBefore.hasEverConnected,
      connectionCount: stateBefore.connectionCount,
      connectionRetries: stateBefore.connectionRetries,
    });
    // #endregion DEBUG
    return withCompanyIntegrationsQueryTimeout(
      client.query(reference, args) as Promise<R>,
      operation,
    ).then(
      (result) => {
        // #region DEBUG
        debugCompanyIntegrations("H2", "integrations-query-succeeded", {
          debugClientId,
          operation,
          durationMs: Math.round(performance.now() - startedAt),
        });
        // #endregion DEBUG
        return result;
      },
      (error: unknown) => {
        // #region DEBUG
        const stateAfter = client.connectionState();
        debugCompanyIntegrations("H2", "integrations-query-failed", {
          debugClientId,
          operation,
          durationMs: Math.round(performance.now() - startedAt),
          errorName: error instanceof Error ? error.name : "unknown",
          connected: stateAfter.isWebSocketConnected,
          hasEverConnected: stateAfter.hasEverConnected,
          connectionCount: stateAfter.connectionCount,
          connectionRetries: stateAfter.connectionRetries,
          hasInflightRequests: stateAfter.hasInflightRequests,
        });
        // #endregion DEBUG
        throw error;
      },
    );
  };
  const mutation = <R>(reference: FunctionReference<"mutation">, args: Args) =>
    client.mutation(reference, args) as Promise<R>;
  const action = <R>(reference: FunctionReference<"action">, args: Args) =>
    client.action(reference, args) as Promise<R>;
  return {
    list: (companyId) => query(refs.list, { companyId }, "Loading integrations"),
    connect: (companyId, token, expectedIntegrationId) =>
      action(refs.connect, {
        companyId,
        token,
        ...(expectedIntegrationId === undefined ? {} : { expectedIntegrationId }),
      }),
    setControllerPool: (args) => mutation(refs.setControllerPool, args),
    activate: (args) => mutation(refs.activate, args),
    disconnect: (args) => mutation(refs.disconnect, args),
    remove: (args) => mutation<null>(refs.remove, args).then(() => undefined),
    listWatches: (companyId, integrationId) =>
      query(refs.listWatches, { companyId, integrationId }, "Loading watched channels"),
    createWatch: (args) => mutation(refs.createWatch, args),
    updateWatch: (args) => mutation(refs.updateWatch, args),
    deleteWatch: (args) => mutation<null>(refs.deleteWatch, args).then(() => undefined),
    getAutomation: (companyId) =>
      query(refs.getAutomation, { companyId }, "Loading issue automation"),
    saveAutomation: (args) => mutation(refs.saveAutomation, args),
    setAutomationEnabled: (companyId, enabled) =>
      mutation(refs.setAutomationEnabled, { companyId, enabled }),
    listJobs: (companyId) =>
      query(refs.listJobs, { companyId, limit: 100 }, "Loading automation jobs"),
    attentionCount: (companyId) =>
      query(refs.attentionCount, { companyId }, "Loading integration alerts"),
    retryJob: (companyId, jobId) =>
      mutation<null>(refs.retryJob, { companyId, jobId }).then(() => undefined),
    cancelJob: (companyId, jobId) =>
      mutation<null>(refs.cancelJob, { companyId, jobId }).then(() => undefined),
    close: () => {
      // #region DEBUG
      debugCompanyIntegrations("H3", "integrations-client-closed", { debugClientId });
      // #endregion DEBUG
      return client.close();
    },
  };
}
