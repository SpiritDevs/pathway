/**
 * The Pathway server's cloud-sync daemon: one long-lived {@link makeSyncEngine} for every company
 * that registered this environment, assembled and reconciled as background roots.
 * This module is the single place where the parts are joined
 * — the server's SQLite replica (`./syncSqliteExecutor.ts`), the Convex transport over a
 * relay-minted service token (`./convexSyncTransport.ts`), and the issue domain adapter — and it is
 * also the single place that decides whether its required configuration is available:
 *
 * 1. `PATHWAY_CONVEX_URL` (or the build-time value) resolves to a deployment origin.
 * 2. The environment is linked: a relay URL, an environment credential, and the environment's link
 *    key pair are all in the secret store.
 * 3. Convex discovers every active company registration for the environment and its proof key.
 *
 * Only the Convex URL is fixed configuration and is read once at layer build. The link and company
 * registrations are mutable state: token exchange re-reads link secrets, and the company
 * supervisor periodically re-reads Convex's registration listing rather than snapshotting either:
 *
 * - `applyCloudRelayConfig` (`./http.ts`) mints and stores a **new** environment credential on
 *   every relink, and the startup relink runs *after* this layer is built, so a credential captured
 *   at build time is the one the relay just revoked. Every token exchange therefore reads the
 *   credential and the link key that are in the secret store *now*, the way
 *   `relay/AgentAwarenessRelay.readRelayConfig` re-reads its config on every publish.
 * - Unlinking removes those same secrets. A daemon that had already started fails its next token
 *   exchange closed, and the supervisor sees the missing link and stops for good rather than
 *   spinning against a cloud this environment is no longer part of.
 * - A link that arrives *after* boot (`pathway connect link` against a running server, or the
 *   startup relink of a desired link) is picked up: the parked daemon re-checks for one on a
 *   bounded schedule before it gives up and asks for a restart.
 * - A company registration added or revoked while the process is running starts or interrupts that
 *   company's worker on the next reconciliation without disturbing the other companies.
 * - A deployment that answers `upgrade-required`, or that refuses this environment for good, ends
 *   the daemon rather than being asked again every restart interval: the supervisor reads *why*
 *   the engine stopped off its published state and only restarts for reasons another run could
 *   change (see {@link isRetryableSyncStop}).
 *
 * Missing required configuration is logged and yields no daemon. There is no feature flag: cloud
 * sync is part of every configured online Pathway environment.
 *
 * @module cloud/syncDaemon
 */
import { api } from "@spiritdevs/backend/convexApi";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { SyncClientId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  makeIssueSyncAdapter,
  makeSqliteSyncStore,
  makeSyncEngine,
  SyncStore,
  SyncTransport,
  SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProcessRunner from "../processRunner.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import {
  ConvexServiceTokenError,
  makeConvexServiceTokenProvider,
  type ConvexServiceTokenProvider,
  type DpopKeyPair,
} from "./convexServiceToken.ts";
import {
  classifyConvexFailure,
  convexHttpClientLike,
  makeConvexSyncTransport,
  type ConvexClientLike,
} from "./convexSyncTransport.ts";
import {
  CloudSyncEngineRegistry,
  makeCloudSyncEngineRegistry,
  type CloudSyncEngineRegistryShape,
} from "./CloudSyncEngineRegistry.ts";
import {
  getOrCreateCloudSyncDpopKeyPairFromSecretStore,
  getOrCreateEnvironmentKeyPairFromSecretStore,
} from "./environmentKeys.ts";
import { convexUrlConfig } from "./publicConfig.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";
import {
  authoritativeEnvironmentRepositories,
  authoritativeEnvironmentRepositoryIntentKey,
  reconcileAuthoritativeEnvironmentRepositoriesWithRetry,
  reconcileRevokedEnvironmentProjects,
  revokedEnvironmentProjectIntentKey,
  revokedEnvironmentProjects,
} from "./cloudProjectReconciler.ts";

// --------------------------------------------------------------------------
// Gates
// --------------------------------------------------------------------------

/**
 * How long a stopped engine waits before resubscribing.
 *
 * `SyncEngine.run` returns normally when the `latestVersion` subscription fails — it records the
 * transport reason as a phase and ends — so without this the first offline blip would end cloud
 * sync for the life of the process. Only a *retryable* stop waits and comes back; see
 * {@link isRetryableSyncStop}.
 */
export const DEFAULT_SYNC_DAEMON_RESTART_DELAY = Duration.seconds(30);

/**
 * How often, and for how long, a configured-but-unlinked daemon re-checks for a link.
 *
 * The window exists because the link this daemon needs is routinely written *after* the layer that
 * builds it: the startup reconcile of a desired cloud link runs at the activation boundary this
 * fiber parks on, and `pathway connect link` writes the same secrets over HTTP into a server that
 * is already up. Two minutes covers both of those without leaving a server that will never link
 * polling its secret store forever.
 */
export const DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL = Duration.seconds(5);
export const DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS = 24;

/**
 * How many times a daemon restarts after an `unauthorized` stop before it gives up for good.
 *
 * The web runtime treats `unauthorized` as terminal on the first answer, and for a browser that is
 * right: its token comes from a Clerk session that a restart cannot improve. The server's does not.
 * A server's `unauthorized` is produced in two very different places:
 *
 * - The deployment refused the call (`UNAUTHORIZED_CODES` in `./convexSyncTransport.ts`): not a
 *   member, environment not registered, key mismatch. Terminal, exactly as on the web.
 * - The *relay* refused the token exchange with 400/401/403 (`./convexServiceToken.ts` maps those
 *   to `unauthorized`). One of those is routinely transient: `applyCloudRelayConfig` relinks by
 *   minting a replacement environment credential, and the relay revokes the old one as it issues
 *   the new one — so an exchange that lands in that window is refused with a credential that is
 *   about to be replaced in the secret store. The transport's own once-only refresh does not cover
 *   it (both attempts read the same not-yet-written credential), and the daemon is the only party
 *   that can wait for the new secret to land.
 *
 * A small budget covers the second without reviving the loop the first needs stopped: three
 * restarts spaced by {@link DEFAULT_SYNC_DAEMON_RESTART_DELAY} is a minute and a half of grace,
 * after which the daemon stops and says so once. `upgrade-required` gets no budget at all — a
 * deployment with cloud sync switched off, or one that refuses this protocol version, answers the
 * same way to a process that has not been rebuilt.
 */
export const DEFAULT_SYNC_DAEMON_UNAUTHORIZED_RESTARTS = 3;

/** How often the server asks Convex for registration additions and revocations. */
export const DEFAULT_SYNC_DAEMON_COMPANY_RECONCILE_INTERVAL = Duration.seconds(15);
export const DEFAULT_CLOUD_PROJECT_RECONCILE_INTERVAL = Duration.minutes(1);
/** Bounded recovery attempts after a per-company worker returns or fails unexpectedly. */
export const DEFAULT_CLOUD_COMPANY_WORKER_RESTARTS = 3;

/** The configuration half of the gates: fixed for the life of the process. */
export interface CloudSyncDaemonSettings {
  readonly convexUrl: string;
}

/**
 * The link half of the gates, as it stands in the secret store *right now*.
 *
 * Never cached by anything that outlives one token exchange: relinking replaces the credential and
 * the relay revokes the one it replaced, and unlinking removes it altogether.
 */
export interface CloudSyncLink {
  /** Relay base URL the token exchange is addressed to. */
  readonly relayBaseUrl: string;
  /** DPoP-bound credential the relay issued when this environment was last linked. */
  readonly environmentCredential: string;
  /** PEM (pkcs8) Ed25519 private key of the environment link; it signs the token key binding. */
  readonly linkPrivateKey: string;
}

/**
 * Which gate stopped the daemon. Reported rather than thrown, because "not configured" is the
 * expected state of every server that has not opted in.
 */
export type CloudSyncDaemonDisabledReason = "convex-url-unavailable" | "environment-not-linked";

export interface CloudSyncDaemonDisabled {
  readonly _tag: "Disabled";
  readonly reason: CloudSyncDaemonDisabledReason;
  /** What the gate actually objected to, when the reason alone cannot say — a rejected URL. */
  readonly detail?: string;
}

export type CloudSyncDaemonResolution =
  | CloudSyncDaemonDisabled
  | { readonly _tag: "Enabled"; readonly settings: CloudSyncDaemonSettings };

/** The configuration gates on their own: everything that cannot change while the process runs. */
export type CloudSyncConfigResolution =
  | CloudSyncDaemonDisabled
  | { readonly _tag: "Configured"; readonly settings: CloudSyncDaemonSettings };

const disabled = (
  reason: CloudSyncDaemonDisabledReason,
  detail?: string,
): CloudSyncDaemonDisabled => ({
  _tag: "Disabled",
  reason,
  ...(detail ? { detail } : {}),
});

/**
 * Reads the environment-variable gates, cheapest first.
 *
 * A `PATHWAY_CONVEX_URL` that is present but not an origin is not the same thing as an absent one,
 * so the config error's own message rides along as `detail`: an operator who typo'd a path onto
 * their deployment URL gets told that, instead of a server that boots as if the flag was never set.
 */
export const resolveCloudSyncConfig: Effect.Effect<CloudSyncConfigResolution> = Effect.gen(
  function* () {
    const convexUrl = yield* convexUrlConfig.pipe(
      Effect.map((url) => ({ url, detail: undefined as string | undefined })),
      Effect.catch((error) => Effect.succeed({ url: undefined, detail: error.message })),
    );
    if (convexUrl.url === undefined) {
      return disabled("convex-url-unavailable", convexUrl.detail);
    }

    return {
      _tag: "Configured",
      settings: { convexUrl: convexUrl.url },
    };
  },
);

/**
 * The link material as the secret store holds it at this instant, or `null` when the environment
 * is not linked.
 *
 * The order is deliberate: the environment link key pair is *created* when it is missing, so it is
 * only ever touched once a relay URL and a credential prove the operator linked this environment.
 * An unlinked server never writes a key, and a server that was unlinked answers `null` here, which
 * is what fails the next token exchange closed and stops the daemon.
 */
export const readCloudSyncLink = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<CloudSyncLink | null> =>
  Effect.gen(function* () {
    const readSecretString = (name: string) =>
      secrets.get(name).pipe(
        Effect.map((bytes) =>
          Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null,
        ),
        Effect.orElseSucceed(() => null),
      );

    const [relayBaseUrl, environmentCredential] = yield* Effect.all([
      readSecretString(RELAY_URL_SECRET),
      readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    ]);
    if (!relayBaseUrl || !environmentCredential) return null;

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (keyPair === null) return null;

    return { relayBaseUrl, environmentCredential, linkPrivateKey: keyPair.privateKey };
  });

/**
 * Every gate at once: what a caller asks when it wants a yes/no about cloud sync right now.
 *
 * The daemon itself does not use this — it keeps the configuration answer and re-reads the link —
 * but the answer is the same one it would give at this instant.
 */
export const resolveCloudSyncDaemon: Effect.Effect<
  CloudSyncDaemonResolution,
  never,
  ServerSecretStore.ServerSecretStore
> = Effect.gen(function* () {
  const config = yield* resolveCloudSyncConfig;
  if (config._tag === "Disabled") return config;

  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const link = yield* readCloudSyncLink(secrets);
  if (link === null) return disabled("environment-not-linked");

  return { _tag: "Enabled", settings: config.settings };
});

// --------------------------------------------------------------------------
// Identity
// --------------------------------------------------------------------------

/**
 * The outbox's identity. One per environment, derived rather than stored: the local sequence space
 * and the server's per-client deduplication both key off it, so it has to survive a restart, and
 * the environment id already does — it is persisted with the rest of the environment's state and
 * is what the relay bound this environment's credential to.
 */
export function cloudSyncClientId(environmentId: EnvironmentId): SyncClientId {
  return SyncClientId.make(`pathway-environment-${environmentId}`);
}

/**
 * Attribution stamped on every operation this server authors. Convex re-derives the authoritative
 * actor from the service token, so this is what the audit trail shows, never what authorization
 * trusts — and the server acts with its own service identity, not on any person's behalf.
 */
export function cloudSyncActor(environmentId: EnvironmentId): SyncActor {
  return { kind: "environment", environmentId };
}

// --------------------------------------------------------------------------
// Tokens
// --------------------------------------------------------------------------

const sameLink = (left: CloudSyncLink, right: CloudSyncLink): boolean =>
  left.relayBaseUrl === right.relayBaseUrl &&
  left.environmentCredential === right.environmentCredential &&
  left.linkPrivateKey === right.linkPrivateKey;

export interface CloudSyncTokenProviderInput {
  readonly environmentId: EnvironmentId;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  /** The durable proof identity named by this environment's Convex registration. */
  readonly dpopKeys: DpopKeyPair;
}

/**
 * A {@link ConvexServiceTokenProvider} that follows the environment's link instead of a snapshot
 * of it.
 *
 * `makeConvexServiceTokenProvider` binds one credential for its lifetime, which is right for one
 * exchange identity and wrong for a daemon that outlives relinks. This wraps it: the link is read
 * from the secret store on the way to every token, and the inner provider — with its cache, its
 * refresh margin and its single-flight exchange — is rebuilt only when the material underneath it
 * actually changed. A relink is picked up on the next call; an unlink fails `unauthorized`, which
 * is the transport's terminal reason, before a single request leaves the process.
 */
export const makeCloudSyncTokenProvider = Effect.fn("cloud.sync_daemon.token_provider")(function* (
  input: CloudSyncTokenProviderInput,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const dpopKeys = input.dpopKeys;
  const current = yield* Ref.make<{
    readonly link: CloudSyncLink;
    readonly provider: ConvexServiceTokenProvider;
  } | null>(null);
  const rebuildLock = yield* Semaphore.make(1);

  const providerFor = (
    link: CloudSyncLink,
  ): Effect.Effect<ConvexServiceTokenProvider, ConvexServiceTokenError> =>
    Effect.gen(function* () {
      const cached = yield* Ref.get(current);
      if (cached !== null && sameLink(cached.link, link)) return cached.provider;
      return yield* rebuildLock.withPermits(1)(
        Effect.gen(function* () {
          // Re-check on the far side of the lock: a burst of callers that arrived on the same
          // rotation must share one provider, or they each get their own token cache.
          const settled = yield* Ref.get(current);
          if (settled !== null && sameLink(settled.link, link)) return settled.provider;
          const provider = yield* makeConvexServiceTokenProvider({
            environmentId: input.environmentId,
            relayBaseUrl: link.relayBaseUrl,
            environmentCredential: link.environmentCredential,
            linkPrivateKey: link.linkPrivateKey,
            dpopKeys,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          yield* Ref.set(current, { link, provider });
          return provider;
        }),
      );
    });

  const token: Effect.Effect<string, ConvexServiceTokenError> = Effect.gen(function* () {
    const link = yield* readCloudSyncLink(input.secrets);
    if (link === null) {
      yield* Ref.set(current, null);
      return yield* new ConvexServiceTokenError({
        reason: "unauthorized",
        message: "this environment is not linked to the cloud, so no service token can be minted",
      });
    }
    const provider = yield* providerFor(link);
    return yield* provider.token;
  });

  const invalidate = (staleToken?: string): Effect.Effect<void> =>
    Ref.get(current).pipe(
      Effect.flatMap((held) =>
        held === null ? Effect.void : held.provider.invalidate(staleToken),
      ),
    );

  return { token, invalidate } satisfies ConvexServiceTokenProvider;
});

export interface DiscoverCloudSyncCompanyIdsInput {
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  /** Test seam; production builds one authenticated HTTP client for this discovery call. */
  readonly client?: ConvexClientLike;
}

/**
 * Asks Convex which active companies registered this authenticated environment and proof key.
 *
 * This is the server's company-routing boundary. Callers must not infer a company from local
 * configuration or from stale SQLite rows: Convex owns registration and revocation state.
 */
export const discoverCloudSyncCompanyIds = Effect.fn("cloud.sync_daemon.discover_companies")(
  function* (input: DiscoverCloudSyncCompanyIdsInput) {
    const client = input.client ?? convexHttpClientLike(input.convexUrl);
    const call = (token: string) =>
      Effect.tryPromise({
        try: () => {
          client.setAuth(token);
          return client.query(api.environments.listRegisteredCompanies, {});
        },
        catch: (cause) =>
          new SyncTransportError({
            reason: classifyConvexFailure(cause),
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });

    const token = yield* input.tokens.token.pipe(
      Effect.mapError(
        (error) => new SyncTransportError({ reason: error.reason, message: error.message }),
      ),
    );
    const companyIds = yield* call(token).pipe(
      Effect.catchIf(
        (error) => error.reason === "unauthorized",
        () =>
          input.tokens.invalidate(token).pipe(
            Effect.andThen(input.tokens.token),
            Effect.mapError(
              (error) => new SyncTransportError({ reason: error.reason, message: error.message }),
            ),
            Effect.flatMap(call),
          ),
      ),
    );
    return companyIds.map((companyId) => CompanyId.make(companyId));
  },
);

// --------------------------------------------------------------------------
// Daemon
// --------------------------------------------------------------------------

export interface CloudSyncTransportInput {
  readonly settings: CloudSyncDaemonSettings;
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  /** The secret store itself, so the transport's tokens follow the link rather than snapshot it. */
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly tokens: ConvexServiceTokenProvider;
}

export interface CloudSyncCompanyDiscoveryInput {
  readonly settings: CloudSyncDaemonSettings;
  readonly environmentId: EnvironmentId;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly tokens: ConvexServiceTokenProvider;
}

export interface CloudSyncDaemonOptions {
  /**
   * Test seam. The default mints a `pathway-convex` service token per the environment's relay link
   * and calls the deployment over a real `ConvexHttpClient`; nothing in the tests may do that.
   */
  readonly transport?: (
    input: CloudSyncTransportInput,
  ) => Effect.Effect<SyncTransport["Service"], never, HttpClient.HttpClient>;
  /** Defaults to {@link DEFAULT_SYNC_DAEMON_RESTART_DELAY}. */
  readonly restartDelay?: Duration.Input;
  /** Defaults to {@link DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL}. */
  readonly linkWaitInterval?: Duration.Input;
  /** Defaults to {@link DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS}; `0` means "check once". */
  readonly linkWaitAttempts?: number;
  /**
   * Defaults to {@link DEFAULT_SYNC_DAEMON_UNAUTHORIZED_RESTARTS}; `0` makes an `unauthorized`
   * stop terminal on the first answer, the way the web runtime treats it.
   */
  readonly unauthorizedRestarts?: number;
  /** Test seam for the Convex-owned environment registration listing. */
  readonly discoverCompanies?: (
    input: CloudSyncCompanyDiscoveryInput,
  ) => Effect.Effect<ReadonlyArray<CompanyId>, SyncTransportError>;
  /** Defaults to {@link DEFAULT_SYNC_DAEMON_COMPANY_RECONCILE_INTERVAL}. */
  readonly companyReconcileInterval?: Duration.Input;
}

/**
 * Why the engine stopped, and whether starting it again could change anything.
 *
 * `engine.run` does not fail on a transport error — it records the reason on its published state
 * and returns — so the answer has to be read back off {@link SyncEngine.state} rather than caught.
 */
interface CloudSyncEngineStop {
  readonly retryable: boolean;
  readonly error: SyncTransportError | null;
}

/**
 * Whether another run could answer differently, from the transport reason the engine ended on.
 *
 * The same split the web runtime makes (`apps/web/src/cloud/syncRuntime.ts`): `offline` and
 * `transport` are the pipe, and the pipe changes. `unauthorized` and `upgrade-required` are
 * verdicts about this environment or this build, and a timer cannot argue with either. No error at
 * all is the ordinary "the subscription ended" stop this loop exists for.
 */
export function isRetryableSyncStop(error: SyncTransportError | null): boolean {
  return error === null || error.reason === "offline" || error.reason === "transport";
}

/**
 * The production transport: link-following service tokens plus a Convex client for the deployment.
 *
 * The DPoP key pair is the durable proof identity named by the company's environment registration.
 * Access tokens remain short lived and in memory, while the proof key survives restarts in the
 * same mode-0600 secret store as the environment link key.
 */
const defaultCloudSyncTransport = (
  input: CloudSyncTransportInput,
): Effect.Effect<SyncTransport["Service"], never> =>
  makeConvexSyncTransport({ convexUrl: input.settings.convexUrl, tokens: input.tokens });

/**
 * The link, waited for rather than demanded: the first check is immediate and the rest are the
 * daemon's answer to a link that lands after boot. `null` means the window closed without one.
 */
export const awaitCloudSyncLink = (input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly interval: Duration.Input;
  readonly attempts: number;
}): Effect.Effect<CloudSyncLink | null> =>
  readCloudSyncLink(input.secrets).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(input.interval),
      while: (link) => link === null,
      times: Math.max(0, input.attempts),
    }),
  );

export interface CloudSyncCompanySupervisorOptions<DiscoveryError, WorkerError, R> {
  readonly discover: () => Effect.Effect<ReadonlyArray<CompanyId>, DiscoveryError>;
  readonly runCompany: (companyId: CompanyId) => Effect.Effect<void, WorkerError, R>;
  readonly workerLabel: string;
  readonly reconcileInterval?: Duration.Input;
  readonly workerRestartDelay?: Duration.Input;
  readonly workerRestarts?: number;
}

/**
 * Reconciles long-lived server workers against Convex-owned environment registrations.
 *
 * A failed listing leaves existing workers alone: an offline deployment is not evidence that an
 * environment was revoked. A successful listing is authoritative, so removed companies are
 * interrupted and newly registered companies start without a server restart. A worker failure is
 * isolated to that company and receives a bounded restart budget, allowing a later credential or
 * deployment recovery without turning a permanent refusal into a tight loop. Once that budget is
 * exhausted, the worker completes; a later successful registration listing may start a fresh
 * bounded run at the ordinary reconciliation interval.
 */
export function superviseCloudSyncCompanies<DiscoveryError, WorkerError, R>(
  options: CloudSyncCompanySupervisorOptions<DiscoveryError, WorkerError, R>,
): Effect.Effect<void, never, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      const running = new Map<CompanyId, Fiber.Fiber<void, never>>();
      const interval = options.reconcileInterval ?? DEFAULT_SYNC_DAEMON_COMPANY_RECONCILE_INTERVAL;
      const workerRestartDelay = options.workerRestartDelay ?? interval;
      const workerRestarts = Math.max(
        0,
        options.workerRestarts ?? DEFAULT_CLOUD_COMPANY_WORKER_RESTARTS,
      );

      const reconcile = (companyIds: ReadonlyArray<CompanyId>) =>
        Effect.gen(function* () {
          const desired = new Set(companyIds);
          for (const [companyId, worker] of running) {
            if (desired.has(companyId)) continue;
            running.delete(companyId);
            yield* Fiber.interrupt(worker);
            yield* Effect.logInfo("Cloud company worker stopped after registration removal", {
              companyId,
              worker: options.workerLabel,
            });
          }
          for (const companyId of desired) {
            const held = running.get(companyId);
            if (held !== undefined && held.pollUnsafe() === undefined) continue;
            if (held !== undefined) {
              running.delete(companyId);
              yield* Fiber.interrupt(held);
            }
            const reportWorkerStop = (cause: unknown) =>
              Effect.logWarning("Cloud company worker stopped; retrying within its budget", {
                companyId,
                worker: options.workerLabel,
                cause,
              });
            const runOnce = Effect.scoped(options.runCompany(companyId)).pipe(
              Effect.catch(reportWorkerStop),
              Effect.catchDefect(reportWorkerStop),
            );
            const worker = runOnce.pipe(
              Effect.repeat({
                schedule: Schedule.spaced(workerRestartDelay),
                times: workerRestarts,
              }),
              Effect.andThen(
                Effect.logWarning("Cloud company worker exhausted its restart budget", {
                  companyId,
                  worker: options.workerLabel,
                  restarts: workerRestarts,
                }),
              ),
            );
            running.set(companyId, yield* Effect.forkScoped(worker));
          }
        });

      const discoverAndReconcile = options.discover().pipe(
        Effect.flatMap(reconcile),
        Effect.catch((error) =>
          Effect.logWarning("Cloud company discovery failed; keeping current workers", {
            worker: options.workerLabel,
            error,
          }),
        ),
        Effect.catchDefect((cause) =>
          Effect.logWarning("Cloud company discovery failed; keeping current workers", {
            worker: options.workerLabel,
            cause,
          }),
        ),
      );

      yield* discoverAndReconcile.pipe(
        Effect.repeat({ schedule: Schedule.spaced(interval) }),
        Effect.asVoid,
      );
    }),
  );
}

/** State changes reconcile immediately; the periodic snapshot retries intents after a quiet failure. */
export function cloudProjectReconciliationStates<A>(
  state: SubscriptionRef.SubscriptionRef<A>,
  interval: Duration.Input = DEFAULT_CLOUD_PROJECT_RECONCILE_INTERVAL,
): Stream.Stream<A> {
  const periodic = Stream.tick(interval).pipe(Stream.mapEffect(() => SubscriptionRef.get(state)));
  return Stream.merge(SubscriptionRef.changes(state), periodic);
}

/**
 * Builds the engine and parks it at the activation boundary, or logs why it did not.
 *
 * Returns the supervisor fiber — the caller's handle on a daemon that otherwise lives and dies
 * with the scope — or `null` when a configuration gate refused.
 */
const runCloudSyncCompany = Effect.fn("cloud.sync_daemon.run_company")(function* (input: {
  readonly companyId: CompanyId;
  readonly settings: CloudSyncDaemonSettings;
  readonly environmentId: EnvironmentId;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly tokens: ConvexServiceTokenProvider;
  readonly store: SyncStore["Service"];
  readonly engineRegistry: CloudSyncEngineRegistryShape;
  readonly transport: NonNullable<CloudSyncDaemonOptions["transport"]>;
  readonly restartDelay: Duration.Input;
  readonly unauthorizedRestarts: number;
}) {
  const projects = yield* Effect.serviceOption(ProjectService.ProjectService);
  const orchestration = yield* Effect.serviceOption(OrchestrationEngineService);
  const processRunner = yield* Effect.serviceOption(ProcessRunner.ProcessRunner);
  const transport = yield* input.transport({
    settings: input.settings,
    companyId: input.companyId,
    environmentId: input.environmentId,
    secrets: input.secrets,
    tokens: input.tokens,
  });
  const clock = yield* Clock.clockWith(Effect.succeed);
  const engine = yield* makeSyncEngine({
    companyId: input.companyId,
    clientId: cloudSyncClientId(input.environmentId),
    actor: cloudSyncActor(input.environmentId),
    environmentId: input.environmentId,
    adapter: makeIssueSyncAdapter({
      actor: cloudSyncActor(input.environmentId),
      now: () => clock.currentTimeMillisUnsafe(),
    }),
  }).pipe(
    Effect.provideService(SyncStore, input.store),
    Effect.provideService(SyncTransport, transport),
  );
  const reconciledProjectDeletions = yield* Ref.make<ReadonlySet<string>>(new Set());
  const reconciledProjectRepositories = yield* Ref.make<ReadonlySet<string>>(new Set());
  const reconcileCloudProjects =
    Option.isSome(projects) && Option.isSome(orchestration)
      ? cloudProjectReconciliationStates(engine.state).pipe(
          Stream.runForEach((state) =>
            Effect.gen(function* () {
              const settled = yield* Ref.get(reconciledProjectDeletions);
              const pending = revokedEnvironmentProjects(
                state.confirmed.values(),
                input.environmentId,
              ).filter((binding) => !settled.has(revokedEnvironmentProjectIntentKey(binding)));
              if (pending.length > 0) {
                const reconciled = yield* reconcileRevokedEnvironmentProjects({
                  companyId: input.companyId,
                  environmentId: input.environmentId,
                  revoked: pending,
                  projects: projects.value,
                  orchestration: orchestration.value,
                });
                if (reconciled.length > 0) {
                  yield* Ref.update(
                    reconciledProjectDeletions,
                    (current) => new Set([...current, ...reconciled]),
                  );
                }
              }
              if (Option.isNone(processRunner)) return;
              const settledRepositories = yield* Ref.get(reconciledProjectRepositories);
              const pendingRepositories = authoritativeEnvironmentRepositories(
                state.confirmed.values(),
                input.environmentId,
              ).filter(
                (repository) =>
                  !settledRepositories.has(authoritativeEnvironmentRepositoryIntentKey(repository)),
              );
              if (pendingRepositories.length === 0) return;
              const reconciledRepositories =
                yield* reconcileAuthoritativeEnvironmentRepositoriesWithRetry({
                  repositories: pendingRepositories,
                  projects: projects.value,
                  processRunner: processRunner.value,
                });
              if (reconciledRepositories.length > 0) {
                yield* Ref.update(
                  reconciledProjectRepositories,
                  (current) => new Set([...current, ...reconciledRepositories]),
                );
              }
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Cloud project reconciliation failed; it will retry", {
                  companyId: input.companyId,
                  environmentId: input.environmentId,
                  cause,
                }),
              ),
            ),
          ),
        )
      : Effect.never;
  const supervise = Effect.gen(function* () {
    yield* Effect.logInfo("Cloud sync company engine started", {
      companyId: input.companyId,
      environmentId: input.environmentId,
      convexUrl: input.settings.convexUrl,
    });
    const runEngine = engine.run.pipe(
      Effect.andThen(SubscriptionRef.get(engine.state)),
      Effect.map(
        ({ lastError }) =>
          ({
            retryable: isRetryableSyncStop(lastError),
            error: lastError,
          }) satisfies CloudSyncEngineStop,
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Cloud sync engine stopped; restarting", {
              companyId: input.companyId,
              cause,
            }).pipe(Effect.as({ retryable: true, error: null } satisfies CloudSyncEngineStop)),
      ),
    );
    const refusals = yield* Ref.make(0);
    const turn = Effect.gen(function* () {
      const stop = yield* runEngine;
      if ((yield* readCloudSyncLink(input.secrets)) === null) {
        yield* Effect.logWarning("Cloud sync stopped: this environment is no longer linked", {
          companyId: input.companyId,
        });
        return false;
      }
      if (stop.retryable) {
        yield* Ref.set(refusals, 0);
        return true;
      }
      if (stop.error?.reason === "unauthorized") {
        const attempt = yield* Ref.updateAndGet(refusals, (count) => count + 1);
        if (attempt <= input.unauthorizedRestarts) {
          yield* Effect.logWarning("Cloud sync was refused; retrying with a fresh service token", {
            companyId: input.companyId,
            attempt,
            of: input.unauthorizedRestarts,
            reason: stop.error.reason,
            message: stop.error.message,
          });
          return true;
        }
      }
      yield* Effect.logWarning(
        "Cloud sync stopped and will not restart; re-link this environment or update this server",
        {
          companyId: input.companyId,
          reason: stop.error?.reason,
          message: stop.error?.message,
        },
      );
      return false;
    });
    yield* turn.pipe(
      Effect.repeat({ schedule: Schedule.spaced(input.restartDelay), while: (again) => again }),
      Effect.asVoid,
    );
  });
  yield* input.engineRegistry.withIssueEngine(
    { environmentId: input.environmentId, engine },
    Effect.raceFirst(supervise, reconcileCloudProjects),
  );
});

export const startCloudSyncDaemon = Effect.fn("cloud.sync_daemon.start")(function* (
  options: CloudSyncDaemonOptions = {},
) {
  const config = yield* resolveCloudSyncConfig;
  if (config._tag === "Disabled") {
    yield* Effect.logWarning("Cloud sync could not start", {
      reason: config.reason,
      ...(config.detail === undefined ? {} : { detail: config.detail }),
    });
    return null;
  }
  const settings = config.settings;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const engineRegistry =
    Option.match(yield* Effect.serviceOption(CloudSyncEngineRegistry), {
      onNone: () => null,
      onSome: (registry) => registry,
    }) ?? (yield* makeCloudSyncEngineRegistry);
  yield* engineRegistry.expectIssueRouting(environmentId);
  const restartDelay = options.restartDelay ?? DEFAULT_SYNC_DAEMON_RESTART_DELAY;
  const linkWaitInterval = options.linkWaitInterval ?? DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL;
  const linkWaitAttempts = options.linkWaitAttempts ?? DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS;
  const unauthorizedRestarts = Math.max(
    0,
    options.unauthorizedRestarts ?? DEFAULT_SYNC_DAEMON_UNAUTHORIZED_RESTARTS,
  );

  const daemon = Effect.gen(function* () {
    if (
      (yield* awaitCloudSyncLink({
        secrets,
        interval: linkWaitInterval,
        attempts: linkWaitAttempts,
      })) === null
    ) {
      yield* Effect.logWarning(
        "Cloud sync is enabled but this environment is not linked; link it, then restart the server",
        { reason: "environment-not-linked" satisfies CloudSyncDaemonDisabledReason },
      );
      return;
    }

    const store = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets).pipe(
      Effect.orDie,
    );
    const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
    const discoveryInput = { settings, environmentId, secrets, tokens };
    const discover =
      options.discoverCompanies ??
      ((input: CloudSyncCompanyDiscoveryInput) =>
        discoverCloudSyncCompanyIds({ convexUrl: input.settings.convexUrl, tokens: input.tokens }));

    yield* superviseCloudSyncCompanies({
      discover: () => discover(discoveryInput),
      runCompany: (companyId) =>
        runCloudSyncCompany({
          companyId,
          settings,
          environmentId,
          secrets,
          tokens,
          store: store.service,
          engineRegistry,
          transport: options.transport ?? defaultCloudSyncTransport,
          restartDelay,
          unauthorizedRestarts,
        }),
      workerLabel: "sync-engine",
      ...(options.companyReconcileInterval === undefined
        ? {}
        : { reconcileInterval: options.companyReconcileInterval }),
    });
  });

  return yield* forkParkedFiber(
    daemon.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Cloud sync daemon stopped; continuing without cloud sync", {
              cause,
            }),
      ),
    ),
  );
});

export type CloudSyncDaemonFiber = Fiber.Fiber<void>;

/**
 * The layer `server.ts` merges in.
 *
 * Failures are absorbed on purpose: the daemon is an addition to a server that worked without it,
 * so a bad deployment URL, an unreadable secret, or a replica that will not open must degrade to
 * "no cloud sync" rather than to "no server".
 */
export const cloudSyncDaemonLayer = (
  options: CloudSyncDaemonOptions = {},
): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | SqlClient.SqlClient
  | HttpClient.HttpClient
> =>
  Layer.effectDiscard(
    startCloudSyncDaemon(options).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud sync daemon failed to start; continuing without cloud sync", {
          cause,
        }),
      ),
    ),
  );
