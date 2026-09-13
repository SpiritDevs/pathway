/** Shared account guards are checked by the runtime independently of open clients. */
import { makeFunctionReference } from "convex/server";
import {
  ThreadId,
  type EnvironmentId,
  type OrchestrationV2ThreadShell,
  type ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderUsageSnapshot,
} from "@spiritdevs/contracts";
import {
  ProviderAllowanceBudget,
  budgetAdmission,
  type ProviderAllowanceScope,
} from "@spiritdevs/contracts/providerAllowanceBudget";
import type { OrchestratorAssignmentOrigin } from "@spiritdevs/contracts/aiOrchestrator";
import {
  quotesAllowanceInstruction,
  type AllocateAgentAllowanceInput,
} from "@spiritdevs/contracts/providerAllowance";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { convexHttpClientLike } from "../cloud/convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "../cloud/environmentKeys.ts";
import {
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
} from "../cloud/syncDaemon.ts";
import { getProviderUsage } from "./ProviderUsageService.ts";

export interface AllowanceAdmission {
  readonly canStart: boolean;
  readonly shouldInterrupt: boolean;
  readonly detail: string;
  readonly budgets: readonly ProviderAllowanceBudget[];
  readonly account?: { readonly provider: string; readonly accountKey?: string };
}
const unavailable: AllowanceAdmission = {
  canStart: false,
  shouldInterrupt: true,
  detail: "Allowance authorization is unavailable. Work is held until Pathway Cloud reconnects.",
  budgets: [],
};
const noGuard: AllowanceAdmission = {
  canStart: true,
  shouldInterrupt: false,
  detail: "No allowance guard applies to this assignment.",
  budgets: [],
};
type ScopeRequest = {
  companyId: string;
  scopes: ProviderAllowanceScope[];
  origin?: OrchestratorAssignmentOrigin;
};
const forScopesRef = makeFunctionReference<"query", ScopeRequest, unknown>(
  "providerAllowanceBudgets:forScopes",
);
const inheritRef = makeFunctionReference<
  "mutation",
  ScopeRequest & {
    target: { kind: "thread"; environmentId: string; threadId: string };
  },
  unknown
>("providerAllowanceBudgets:inherit");
const observeRef = makeFunctionReference<
  "mutation",
  ScopeRequest & {
    budgetId: string;
    revision: number;
    snapshot: ServerProviderUsageSnapshot | null;
  },
  unknown
>("providerAllowanceBudgets:observe");
const decodeBudgets = Schema.decodeUnknownEffect(Schema.Array(ProviderAllowanceBudget));
const decodeBudget = Schema.decodeUnknownEffect(ProviderAllowanceBudget);
const allocateRef = makeFunctionReference<
  "mutation",
  {
    companyId: string;
    threadId: string;
    messageId: string;
    text: string;
    quote: string;
    title: string;
    windowKey: string;
    authorizedPercent: number;
    snapshot: ServerProviderUsageSnapshot;
  },
  unknown
>("providerAllowanceBudgets:allocateForThread");

export class AllowanceInheritanceError extends Schema.TaggedErrorClass<AllowanceInheritanceError>()(
  "AllowanceInheritanceError",
  { message: Schema.String, cause: Schema.Defect() },
) {}

export class ProviderAllowanceRuntime extends Context.Service<
  ProviderAllowanceRuntime,
  {
    readonly allocateThread: (
      threadId: ThreadId,
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      input: AllocateAgentAllowanceInput,
    ) => Effect.Effect<ProviderAllowanceBudget, AllowanceInheritanceError>;
    readonly inheritThread: (
      parentThreadId: ThreadId,
      targetEnvironmentId: EnvironmentId,
      targetThreadId: ThreadId,
    ) => Effect.Effect<void, AllowanceInheritanceError>;
    readonly checkThread: (
      threadId: ThreadId,
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) => Effect.Effect<AllowanceAdmission>;
    readonly checkChat: (
      companyId: string,
      chatId: string,
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) => Effect.Effect<AllowanceAdmission>;
  }
>()("@spiritdevs/pathway/providerUsage/AllowanceRuntime/ProviderAllowanceRuntime") {}

/** Waiting retains the accepted run and exits promptly after cancellation or attempt replacement. */
export const awaitAllowanceAdmission = Effect.fn("allowance.awaitAdmission")(function* (
  check: Effect.Effect<AllowanceAdmission>,
  stillCurrent: Effect.Effect<boolean>,
  onHold: (state: AllowanceAdmission) => Effect.Effect<void>,
  wait: Effect.Effect<void> = Effect.sleep("10 seconds"),
) {
  while (yield* stillCurrent) {
    const state = yield* check;
    if (state.canStart) return true;
    yield* onHold(state);
    yield* wait;
  }
  return false;
});

export const layer = Layer.effect(
  ProviderAllowanceRuntime,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const environmentId = yield* environment.getEnvironmentId;
    const store = yield* ProjectionStoreV2;
    const settings = yield* ServerSettingsService;
    const httpClient = yield* HttpClient.HttpClient;
    const config = yield* resolveCloudSyncConfig;
    const connect = yield* Effect.cached(
      Effect.gen(function* () {
        if (config._tag !== "Configured")
          return yield* Effect.fail("Cloud configuration is unavailable");
        const keys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
        const tokens = yield* makeCloudSyncTokenProvider({
          environmentId,
          secrets,
          dpopKeys: keys,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
        return {
          tokens,
          url: config.settings.convexUrl,
          client: convexHttpClientLike(config.settings.convexUrl),
          lock: yield* Semaphore.make(1),
        };
      }),
    );
    const companies = yield* Effect.cachedWithTTL(
      Effect.gen(function* () {
        const backend = yield* connect;
        return yield* discoverCloudSyncCompanyIds({
          convexUrl: backend.url,
          tokens: backend.tokens,
        });
      }),
      "30 seconds",
    );
    const readings = new Map<
      string,
      { at: number; snapshot: ServerProviderUsageSnapshot | null }
    >();
    const usageLock = yield* Semaphore.make(1);
    const snapshotFor = (instanceId: ProviderInstanceId, driver: ProviderDriverKind) =>
      usageLock.withPermits(1)(
        Effect.gen(function* () {
          if (driver !== "codex" && driver !== "claudeAgent" && driver !== "cursor") return null;
          const now = yield* Clock.currentTimeMillis;
          const previous = readings.get(instanceId);
          if (previous && now - previous.at < 30_000) return previous.snapshot;
          const snapshot = yield* getProviderUsage({
            instanceId,
            provider: driver === "codex" ? "codex" : driver === "cursor" ? "cursor" : "claudeAgent",
            forceRefresh: true,
          }).pipe(
            Effect.provideService(ServerSettingsService, settings),
            Effect.orElseSucceed(() => null),
          );
          readings.set(instanceId, { at: now, snapshot });
          return snapshot;
        }),
      );
    const call = <A>(
      f: (backend: { client: ReturnType<typeof convexHttpClientLike> }) => Promise<A>,
    ) =>
      Effect.gen(function* () {
        const backend = yield* connect;
        const token = yield* backend.tokens.token;
        return yield* backend.lock.withPermits(1)(
          Effect.tryPromise(() => {
            backend.client.setAuth(token);
            return f(backend);
          }),
        );
      });
    const check = Effect.fn("allowance.checkScopes")(function* (
      requests: ScopeRequest[],
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
    ) {
      const held: Array<{ request: ScopeRequest; budget: ProviderAllowanceBudget }> = [];
      for (const request of requests) {
        const budgets = yield* call((backend) => backend.client.query(forScopesRef, request)).pipe(
          Effect.flatMap(decodeBudgets),
        );
        for (const budget of budgets) held.push({ request, budget });
      }
      if (!held.length) return noGuard;
      const snapshot = yield* snapshotFor(instanceId, driver);
      const now = yield* Clock.currentTimeMillis;
      const scheduledProviders = new Set(
        held.flatMap(({ budget }) =>
          budget.scheduledResume && budget.scheduledResume.at <= now
            ? budget.scheduledResume.allocations.map((allocation) => allocation.provider)
            : [],
        ),
      );
      const extraSnapshots: ServerProviderUsageSnapshot[] = [];
      if (scheduledProviders.size)
        for (const [id, config] of Object.entries(
          (yield* settings.getSettings).providerInstances,
        )) {
          if (id === instanceId || !scheduledProviders.has(config.driver)) continue;
          const reading = yield* snapshotFor(ProviderInstanceId.make(id), config.driver);
          if (reading) extraSnapshots.push(reading);
        }
      const budgets: ProviderAllowanceBudget[] = [];
      for (const { request, budget } of held) {
        let updated = yield* call((backend) =>
          backend.client.mutation(observeRef, {
            ...request,
            budgetId: budget.id,
            revision: budget.revision,
            snapshot,
          }),
        ).pipe(Effect.flatMap(decodeBudget));
        if (updated.scheduledResume && updated.scheduledResume.at <= now)
          for (const reading of extraSnapshots) {
            updated = yield* call((backend) =>
              backend.client.mutation(observeRef, {
                ...request,
                budgetId: budget.id,
                revision: updated.revision,
                snapshot: reading,
              }),
            ).pipe(Effect.flatMap(decodeBudget));
            if (!updated.scheduledResume) break;
          }
        budgets.push(updated);
      }
      const states = budgets.map((budget) =>
        budgetAdmission(budget, { provider: driver, accountKey: snapshot?.accountKey }, now),
      );
      return {
        canStart: states.every((s) => s.canStart),
        shouldInterrupt: states.some((s) => s.shouldInterrupt),
        detail: states.find((s) => !s.canStart)?.detail ?? "Allowance is available.",
        budgets,
        ...(snapshot
          ? {
              account: {
                provider: snapshot.provider,
                ...(snapshot.accountKey ? { accountKey: snapshot.accountKey } : {}),
              },
            }
          : {}),
      };
    });
    const threadRequests = Effect.fn("allowance.threadRequests")(function* (threadId: ThreadId) {
      const scopes: ProviderAllowanceScope[] = [];
      const seen = new Set<string>();
      let cursor: ThreadId | null = threadId;
      let origin: OrchestratorAssignmentOrigin | undefined;
      let companyId: string | undefined;
      while (cursor && !seen.has(cursor) && seen.size < 32) {
        seen.add(cursor);
        scopes.push({ kind: "thread", environmentId, threadId: cursor });
        const shell: OrchestrationV2ThreadShell | null = yield* store.getThreadShell(cursor);
        if (!shell) return yield* Effect.fail("The originating thread is unavailable.");
        origin ??= shell.orchestratorOrigin;
        companyId ??= shell.conversationCompanyId ?? undefined;
        cursor = shell.lineage.parentThreadId;
      }
      if (cursor) return yield* Effect.fail("The assignment ancestry exceeds the supported depth.");
      const companyIds = origin ? [origin.companyId] : companyId ? [companyId] : yield* companies;
      if (!companyIds.length) return yield* Effect.fail("No registered workspace is available.");
      return companyIds.map((companyId) => ({ companyId, scopes, ...(origin ? { origin } : {}) }));
    });
    return ProviderAllowanceRuntime.of({
      allocateThread: (threadId, instanceId, driver, input) =>
        Effect.gen(function* () {
          const projection = yield* store.getThreadProjection(threadId);
          const run = projection?.runs.find((run) => run.status === "running");
          const source =
            run && projection?.messages.find((message) => message.id === run.userMessageId);
          if (
            !source ||
            source.role !== "user" ||
            source.createdBy !== "user" ||
            !quotesAllowanceInstruction(source.text, input.sourceQuote, input.authorizedPercent)
          )
            return yield* Effect.fail(
              "Quote the numeric allowance from this turn's current human instruction.",
            );
          const requests = yield* threadRequests(threadId);
          const companyId =
            input.companyId ?? (requests.length === 1 ? requests[0]!.companyId : undefined);
          if (!companyId || !requests.some((request) => request.companyId === companyId))
            return yield* Effect.fail("Choose the workspace that owns this assignment.");
          const snapshot = yield* snapshotFor(instanceId, driver);
          if (!snapshot)
            return yield* Effect.fail("The selected provider has no supported allowance reading.");
          return yield* call((backend) =>
            backend.client.mutation(allocateRef, {
              companyId,
              threadId,
              messageId: source.id,
              text: source.text.slice(0, 32000),
              quote: input.sourceQuote,
              title: input.title,
              windowKey: input.windowKey,
              authorizedPercent: input.authorizedPercent,
              snapshot,
            }),
          ).pipe(Effect.flatMap(decodeBudget));
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            (cause) =>
              new AllowanceInheritanceError({
                message:
                  "Could not allocate allowance from this human instruction. Check the selected workspace, current instruction and account reading.",
                cause,
              }),
          ),
        ),
      inheritThread: (parentThreadId, targetEnvironmentId, targetThreadId) =>
        Effect.gen(function* () {
          for (const request of yield* threadRequests(parentThreadId)) {
            yield* call((backend) =>
              backend.client.mutation(inheritRef, {
                ...request,
                target: {
                  kind: "thread",
                  environmentId: targetEnvironmentId,
                  threadId: targetThreadId,
                },
              }),
            );
          }
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError(
            (cause) =>
              new AllowanceInheritanceError({
                message:
                  "Could not preserve the originating allowance. The child has not been launched.",
                cause,
              }),
          ),
        ),
      checkChat: (companyId, chatId, instanceId, driver) =>
        check([{ companyId, scopes: [{ kind: "chat", chatId }] }], instanceId, driver).pipe(
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() => unavailable),
        ),
      checkThread: (threadId, instanceId, driver) =>
        threadRequests(threadId).pipe(
          Effect.flatMap((requests) => check(requests, instanceId, driver)),
          Effect.timeout("15 seconds"),
          Effect.orElseSucceed(() => unavailable),
        ),
    });
  }),
);
