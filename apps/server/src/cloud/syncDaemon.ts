/**
 * The Pathway server's cloud-sync daemon: one long-lived {@link makeSyncEngine} for one company,
 * assembled out of the pieces the earlier phases landed and forked as a background root.
 *
 * Every part of cloud sync ships dark. This module is the single place where the parts are joined
 * — the server's SQLite replica (`./syncSqliteExecutor.ts`), the Convex transport over a
 * relay-minted service token (`./convexSyncTransport.ts`), and the issue domain adapter — and it is
 * also the single place that decides whether any of it runs at all. All four gates must hold:
 *
 * 1. `PATHWAY_CLOUD_SYNC=enabled`, the same flag the Convex deployment reads
 *    (`packages/backend/convex/lib/capability.ts`). One flag on both ends means a client can never
 *    be live against a deployment that would refuse it.
 * 2. `PATHWAY_CLOUD_SYNC_COMPANY_ID` names the company to replicate. Interim: nothing in the
 *    environment's link state carries a company today (the relay link is keyed by environment, and
 *    `RelayManagedEndpointRuntimeConfig` has no company field), so the company is configuration
 *    rather than something derived. When link state grows a company this gate moves there.
 * 3. `PATHWAY_CONVEX_URL` (or the build-time value) resolves to a deployment origin.
 * 4. The environment is linked: a relay URL, an environment credential, and the environment's link
 *    key pair are all in the secret store.
 *
 * A gate that does not hold is not an error. The layer logs one line and yields nothing, so a
 * server without the flag boots exactly as it did before — no tables created, no sockets opened,
 * no fibers forked.
 *
 * @module cloud/syncDaemon
 */
import type { EnvironmentId } from "@spiritdevs/contracts";
import { SyncClientId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  CloudSyncCapability,
  makeIssueSyncAdapter,
  makeSqliteSyncStore,
  makeSyncEngine,
  SyncStore,
  SyncTransport,
} from "@spiritdevs/client-runtime/sync";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Config from "effect/Config";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import type * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParked } from "../serverActivation.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import { generateDpopKeyPair, makeConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { makeConvexSyncTransport } from "./convexSyncTransport.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { convexUrlConfig } from "./publicConfig.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

// --------------------------------------------------------------------------
// Gates
// --------------------------------------------------------------------------

/** Same variable and same accepted value as the Convex deployment's capability gate. */
export const CLOUD_SYNC_CAPABILITY_ENV = "PATHWAY_CLOUD_SYNC";
export const CLOUD_SYNC_CAPABILITY_ENABLED_VALUE = "enabled";
/** Interim: the company to replicate is configuration until the link state carries one. */
export const CLOUD_SYNC_COMPANY_ID_ENV = "PATHWAY_CLOUD_SYNC_COMPANY_ID";

const CLOUD_SYNC_ENABLED = { enabled: true } as const;

/**
 * How long a stopped engine waits before resubscribing.
 *
 * `SyncEngine.run` returns normally when the `latestVersion` subscription fails — it records the
 * transport reason as a phase and ends — so without this the first offline blip would end cloud
 * sync for the life of the process.
 */
export const DEFAULT_SYNC_DAEMON_RESTART_DELAY = Duration.seconds(30);

const capabilityConfig = Config.string(CLOUD_SYNC_CAPABILITY_ENV).pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim() === CLOUD_SYNC_CAPABILITY_ENABLED_VALUE),
);

const companyIdConfig = Config.string(CLOUD_SYNC_COMPANY_ID_ENV).pipe(
  Config.withDefault(""),
  Config.map((value) => value.trim()),
);

/** Everything the daemon needs once every gate has held. */
export interface CloudSyncDaemonSettings {
  readonly companyId: CompanyId;
  readonly convexUrl: string;
  readonly relayBaseUrl: string;
  /** DPoP-bound credential the relay issued when this environment was linked. */
  readonly environmentCredential: string;
  /** PEM (pkcs8) Ed25519 private key of the environment link; it signs the token key binding. */
  readonly linkPrivateKey: string;
}

/**
 * Which gate stopped the daemon. Reported rather than thrown, because "not configured" is the
 * expected state of every server that has not opted in.
 */
export type CloudSyncDaemonDisabledReason =
  | "capability-disabled"
  | "company-not-configured"
  | "convex-url-unavailable"
  | "environment-not-linked";

export type CloudSyncDaemonResolution =
  | { readonly _tag: "Disabled"; readonly reason: CloudSyncDaemonDisabledReason }
  | { readonly _tag: "Enabled"; readonly settings: CloudSyncDaemonSettings };

const disabled = (reason: CloudSyncDaemonDisabledReason): CloudSyncDaemonResolution => ({
  _tag: "Disabled",
  reason,
});

/**
 * Reads every gate in cheapest-first order and answers whether the daemon runs.
 *
 * The order matters for more than speed: the environment link key pair is *created* when it is
 * missing, so it is only ever touched after the operator has asked for cloud sync by name. A
 * server without the flag never writes a key.
 */
export const resolveCloudSyncDaemon: Effect.Effect<
  CloudSyncDaemonResolution,
  never,
  ServerSecretStore.ServerSecretStore
> = Effect.gen(function* () {
  const enabled = yield* capabilityConfig.pipe(Effect.orElseSucceed(() => false));
  if (!enabled) return disabled("capability-disabled");

  const companyId = yield* companyIdConfig.pipe(Effect.orElseSucceed(() => ""));
  if (companyId.length === 0) return disabled("company-not-configured");

  const convexUrl = yield* convexUrlConfig.pipe(Effect.orElseSucceed(() => null));
  if (convexUrl === null) return disabled("convex-url-unavailable");

  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const readSecretString = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) => (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null)),
      Effect.orElseSucceed(() => null),
    );

  const [relayBaseUrl, environmentCredential] = yield* Effect.all([
    readSecretString(RELAY_URL_SECRET),
    readSecretString(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
  ]);
  if (!relayBaseUrl || !environmentCredential) return disabled("environment-not-linked");

  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (keyPair === null) return disabled("environment-not-linked");

  return {
    _tag: "Enabled",
    settings: {
      companyId: CompanyId.make(companyId),
      convexUrl,
      relayBaseUrl,
      environmentCredential,
      linkPrivateKey: keyPair.privateKey,
    },
  };
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
// Daemon
// --------------------------------------------------------------------------

export interface CloudSyncTransportInput {
  readonly settings: CloudSyncDaemonSettings;
  readonly environmentId: EnvironmentId;
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
}

/**
 * The production transport: a relay-minted service token plus a Convex client for the deployment.
 *
 * The DPoP key pair is generated per process rather than persisted. It is proof-of-possession for
 * tokens this process holds in memory, so it has no value beyond the process's own lifetime, and a
 * fresh pair means a restart cannot present a key an earlier run leaked.
 */
const defaultCloudSyncTransport = (
  input: CloudSyncTransportInput,
): Effect.Effect<SyncTransport["Service"], never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const dpopKeys = yield* Effect.sync(generateDpopKeyPair);
    const tokens = yield* makeConvexServiceTokenProvider({
      environmentId: input.environmentId,
      relayBaseUrl: input.settings.relayBaseUrl,
      environmentCredential: input.settings.environmentCredential,
      linkPrivateKey: input.settings.linkPrivateKey,
      dpopKeys,
    });
    return yield* makeConvexSyncTransport({ convexUrl: input.settings.convexUrl, tokens });
  });

/**
 * Builds the engine and parks its subscription loop at the activation boundary, or logs why it did
 * not. Returns as soon as the loop is forked; the fiber lives for the scope's lifetime.
 */
export const startCloudSyncDaemon = Effect.fn("cloud.sync_daemon.start")(function* (
  options: CloudSyncDaemonOptions = {},
) {
  const resolution = yield* resolveCloudSyncDaemon;
  if (resolution._tag === "Disabled") {
    yield* Effect.logDebug("Cloud sync daemon not started", { reason: resolution.reason });
    return;
  }
  const settings = resolution.settings;

  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  // The replica lands in the server's own database file: one `SqlClient`, one set of
  // `cloud_sync_*` tables, created here and only here — a server that never enables sync never
  // runs this migration.
  const executor = yield* makeSyncSqliteExecutor;
  const store = yield* makeSqliteSyncStore(executor);
  const transport = yield* (options.transport ?? defaultCloudSyncTransport)({
    settings,
    environmentId,
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

  const restartDelay = options.restartDelay ?? DEFAULT_SYNC_DAEMON_RESTART_DELAY;

  yield* forkParked(
    engine.run.pipe(
      // A store failure is the one error `run` surfaces; it means the replica is unreadable, which
      // is worth a warning and a retry rather than taking the server down with it.
      Effect.catch((error) =>
        Effect.logWarning("Cloud sync engine stopped on a store error", {
          companyId: settings.companyId,
          error,
        }),
      ),
      Effect.repeat(Schedule.spaced(restartDelay)),
      Effect.asVoid,
      Effect.provideService(CloudSyncCapability, CLOUD_SYNC_ENABLED),
    ),
  );

  yield* Effect.logInfo("Cloud sync daemon started", {
    companyId: settings.companyId,
    environmentId,
    convexUrl: settings.convexUrl,
  });
});

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
