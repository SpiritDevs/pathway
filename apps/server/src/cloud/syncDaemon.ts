/**
 * The Pathway server's cloud-sync daemon: one long-lived {@link makeSyncEngine} for one company,
 * assembled out of the pieces the earlier phases landed and forked as a background root.
 * This module is the single place where the parts are joined
 * — the server's SQLite replica (`./syncSqliteExecutor.ts`), the Convex transport over a
 * relay-minted service token (`./convexSyncTransport.ts`), and the issue domain adapter — and it is
 * also the single place that decides whether its required configuration is available:
 *
 * 1. `PATHWAY_CLOUD_SYNC_COMPANY_ID` names the company to replicate. Interim: nothing in the
 *    environment's link state carries a company today (the relay link is keyed by environment, and
 *    `RelayManagedEndpointRuntimeConfig` has no company field), so the company is configuration
 *    rather than something derived. When link state grows a company this gate moves there.
 * 2. `PATHWAY_CONVEX_URL` (or the build-time value) resolves to a deployment origin.
 * 3. The environment is linked: a relay URL, an environment credential, and the environment's link
 *    key pair are all in the secret store.
 *
 * The first two are *configuration*: they are fixed for the life of the process, so they are read
 * once, at layer build. The fourth is *state* — the secret store is rewritten while the server runs
 * — so it is never snapshotted:
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
import type { EnvironmentId } from "@spiritdevs/contracts";
import { SyncClientId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  makeIssueSyncAdapter,
  makeSqliteSyncStore,
  makeSyncEngine,
  SyncStore,
  SyncTransport,
  type SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Config from "effect/Config";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import {
  ConvexServiceTokenError,
  generateDpopKeyPair,
  makeConvexServiceTokenProvider,
  type ConvexServiceTokenProvider,
  type DpopKeyPair,
} from "./convexServiceToken.ts";
import { makeConvexSyncTransport } from "./convexSyncTransport.ts";
import { CloudSyncEngineRegistry, makeCloudSyncEngineRegistry } from "./CloudSyncEngineRegistry.ts";
import {
  getOrCreateCloudSyncDpopKeyPairFromSecretStore,
  getOrCreateEnvironmentKeyPairFromSecretStore,
} from "./environmentKeys.ts";
import { convexUrlConfig } from "./publicConfig.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

// --------------------------------------------------------------------------
// Gates
// --------------------------------------------------------------------------

/** Interim: the company to replicate is configuration until the link state carries one. */
export const CLOUD_SYNC_COMPANY_ID_ENV = "PATHWAY_CLOUD_SYNC_COMPANY_ID";

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

const companyIdConfig = Config.string(CLOUD_SYNC_COMPANY_ID_ENV).pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim()),
);

/** The configuration half of the gates: fixed for the life of the process. */
export interface CloudSyncDaemonSettings {
  readonly companyId: CompanyId;
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
export type CloudSyncDaemonDisabledReason =
  | "company-not-configured"
  | "convex-url-unavailable"
  | "environment-not-linked";

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
    const companyId = yield* companyIdConfig.pipe(Effect.orElseSucceed(() => ""));
    if (companyId.length === 0) return disabled("company-not-configured");

    const convexUrl = yield* convexUrlConfig.pipe(
      Effect.map((url) => ({ url, detail: undefined as string | undefined })),
      Effect.catch((error) => Effect.succeed({ url: undefined, detail: error.message })),
    );
    if (convexUrl.url === undefined) {
      return disabled("convex-url-unavailable", convexUrl.detail);
    }

    return {
      _tag: "Configured",
      settings: { companyId: CompanyId.make(companyId), convexUrl: convexUrl.url },
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
  /** Defaults to a fresh per-process pair; separable so a test can pin the thumbprint. */
  readonly dpopKeys?: DpopKeyPair;
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
  const dpopKeys = input.dpopKeys ?? (yield* Effect.sync(generateDpopKeyPair));
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

// --------------------------------------------------------------------------
// Daemon
// --------------------------------------------------------------------------

export interface CloudSyncTransportInput {
  readonly settings: CloudSyncDaemonSettings;
  readonly environmentId: EnvironmentId;
  /** The secret store itself, so the transport's tokens follow the link rather than snapshot it. */
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
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
): Effect.Effect<SyncTransport["Service"], never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(input.secrets).pipe(
      Effect.orDie,
    );
    const tokens = yield* makeCloudSyncTokenProvider({
      environmentId: input.environmentId,
      secrets: input.secrets,
      dpopKeys,
    });
    return yield* makeConvexSyncTransport({ convexUrl: input.settings.convexUrl, tokens });
  });

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

/**
 * Builds the engine and parks it at the activation boundary, or logs why it did not.
 *
 * Returns the supervisor fiber — the caller's handle on a daemon that otherwise lives and dies
 * with the scope — or `null` when a configuration gate refused.
 */
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
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;
  const engineRegistry =
    Option.match(yield* Effect.serviceOption(CloudSyncEngineRegistry), {
      onNone: () => null,
      onSome: (registry) => registry,
    }) ?? (yield* makeCloudSyncEngineRegistry);

  const restartDelay = options.restartDelay ?? DEFAULT_SYNC_DAEMON_RESTART_DELAY;
  const linkWaitInterval = options.linkWaitInterval ?? DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL;
  const linkWaitAttempts = options.linkWaitAttempts ?? DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS;
  const unauthorizedRestarts = Math.max(
    0,
    options.unauthorizedRestarts ?? DEFAULT_SYNC_DAEMON_UNAUTHORIZED_RESTARTS,
  );

  const daemon = Effect.gen(function* () {
    // Everything below the activation boundary, because everything below it can be written by the
    // boot that is still finishing: the startup relink mints this environment's credential after
    // this fiber parks, and `pathway connect link` can write the first one minutes later.
    const link = yield* awaitCloudSyncLink({
      secrets,
      interval: linkWaitInterval,
      attempts: linkWaitAttempts,
    });
    if (link === null) {
      yield* Effect.logWarning(
        "Cloud sync is enabled but this environment is not linked; link it, then restart the server",
        {
          companyId: settings.companyId,
          reason: "environment-not-linked" satisfies CloudSyncDaemonDisabledReason,
        },
      );
      return;
    }

    // The replica lands in the server's own database file: one `SqlClient`, one set of
    // `cloud_sync_*` tables, created here and only here — a server that never enables sync never
    // runs this migration.
    const executor = yield* makeSyncSqliteExecutor;
    const store = yield* makeSqliteSyncStore(executor);
    const transport = yield* (options.transport ?? defaultCloudSyncTransport)({
      settings,
      environmentId,
      secrets,
    });

    const clock = yield* Clock.clockWith(Effect.succeed);
    const engine = yield* makeSyncEngine({
      companyId: settings.companyId,
      clientId: cloudSyncClientId(environmentId),
      actor: cloudSyncActor(environmentId),
      environmentId,
      // The same actor the engine reports must be the one optimistic rows are stamped with, should
      // server code ever originate writes through this adapter.
      adapter: makeIssueSyncAdapter({
        actor: cloudSyncActor(environmentId),
        now: () => clock.currentTimeMillisUnsafe(),
      }),
    }).pipe(
      Effect.provideService(SyncStore, store.service),
      Effect.provideService(SyncTransport, transport),
    );
    yield* engineRegistry.registerIssueEngine({ environmentId, engine });

    yield* Effect.logInfo("Cloud sync daemon started", {
      companyId: settings.companyId,
      environmentId,
      convexUrl: settings.convexUrl,
    });

    /**
     * One run of the engine, to a stop, with the reason it stopped.
     *
     * `run` returns *normally* when the head subscription fails — it records the transport reason
     * as a phase and ends — so the reason lives on the engine's state, not in an error channel.
     */
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
        // Interruption is the scope closing and has to pass through. Everything else — the store
        // failure `run` declares, and any defect raised under it — is a warning and another turn
        // of the loop, because a fiber that dies here is cloud sync gone for the process lifetime
        // with nothing in the log to say so. Neither is a verdict from the deployment, so both are
        // retryable: the local replica is what broke, and it can come back.
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("Cloud sync engine stopped; restarting", {
              companyId: settings.companyId,
              cause,
            }).pipe(Effect.as({ retryable: true, error: null } satisfies CloudSyncEngineStop)),
      ),
    );

    const refusals = yield* Ref.make(0);

    /**
     * One turn of the supervisor: run the engine, then decide whether there is any point running
     * it again. `true` schedules another turn; `false` ends the daemon for the life of the process.
     *
     * The unlink check comes first and is unchanged: an unlink makes the token exchange fail
     * `unauthorized` before a request leaves the process, and "this environment is no longer
     * linked" is the accurate thing to tell an operator about that, not "the cloud refused us".
     *
     * After it, a stop the transport classified as terminal ends the daemon rather than being
     * re-tried every restart interval until the process dies — which would hide the one thing
     * the operator needs to see behind a log line repeated forever, and would keep asking a
     * deployment that answered `upgrade-required` a question it has already answered.
     * `unauthorized` gets a bounded budget first; see
     * {@link DEFAULT_SYNC_DAEMON_UNAUTHORIZED_RESTARTS} for why the server differs from the web
     * runtime here.
     */
    const turn = Effect.gen(function* () {
      const stop = yield* runEngine;

      // The link is re-read between runs, so an unlink ends the daemon instead of leaving it to
      // retry forever against a cloud this environment left.
      const current = yield* readCloudSyncLink(secrets);
      if (current === null) {
        yield* Effect.logWarning("Cloud sync stopped: this environment is no longer linked", {
          companyId: settings.companyId,
        });
        return false;
      }

      if (stop.retryable) {
        // A run that ended on the pipe rather than on a verdict clears the refusal budget: the
        // next `unauthorized` is a new episode, not the continuation of an old one.
        yield* Ref.set(refusals, 0);
        return true;
      }

      if (stop.error?.reason === "unauthorized") {
        const attempt = yield* Ref.updateAndGet(refusals, (count) => count + 1);
        if (attempt <= unauthorizedRestarts) {
          yield* Effect.logWarning("Cloud sync was refused; retrying with a fresh service token", {
            companyId: settings.companyId,
            attempt,
            of: unauthorizedRestarts,
            reason: stop.error.reason,
            message: stop.error.message,
          });
          return true;
        }
      }

      yield* Effect.logWarning(
        "Cloud sync stopped and will not restart; re-link this environment or update this server",
        {
          companyId: settings.companyId,
          reason: stop.error?.reason,
          message: stop.error?.message,
        },
      );
      return false;
    });

    yield* turn.pipe(
      Effect.repeat({ schedule: Schedule.spaced(restartDelay), while: (again) => again }),
      Effect.asVoid,
    );
  });

  return yield* forkParkedFiber(
    daemon.pipe(
      // The daemon is an addition to a server that worked without it: a replica that will not
      // migrate, or an engine that will not build, must degrade to "no cloud sync" rather than to
      // a fiber that vanishes without a word.
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.void
          : Effect.logWarning("Cloud sync daemon stopped; continuing without cloud sync", {
              companyId: settings.companyId,
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
