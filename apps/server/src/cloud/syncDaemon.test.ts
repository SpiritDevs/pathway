/**
 * The cloud-sync daemon's gates, its one wired-up cycle, and the lifecycle around both.
 *
 * Four things are worth proving here and nowhere else. First, that a server which has not opted in
 * is *untouched*: the assertion for that is the database, because the replica's tables are created
 * by the very first thing the enabled path does, so their absence is proof no part of the daemon
 * ran. Second, that the enabled path is really wired — the server's SQLite executor, the issue
 * adapter, and a transport meet in one engine, an operation left in the outbox reaches the wire,
 * and what the wire answers is durable afterwards. Third, that the daemon follows the environment's
 * link instead of a snapshot of it: a relink is presented to the relay, an unlink stops sync, and a
 * link that arrives after boot starts it. Fourth, that the supervisor is honest — a defect is a
 * restart, and a refusal the operator asked for is a warning.
 *
 * The transport is a fake throughout. Nothing in this file may touch the relay or a deployment.
 */
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@spiritdevs/contracts";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncEntityId,
  SyncOperationId,
  type SyncApplyOperationsRequest,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  makeSqliteSyncStore,
  SyncTransport,
  SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import { CloudSyncEngineRegistry, makeCloudSyncEngineRegistry } from "./CloudSyncEngineRegistry.ts";
import {
  CLOUD_SYNC_CAPABILITY_ENV,
  CLOUD_SYNC_COMPANY_ID_ENV,
  cloudSyncActor,
  cloudSyncClientId,
  cloudSyncDaemonLayer,
  makeCloudSyncTokenProvider,
  readCloudSyncLink,
  resolveCloudSyncDaemon,
  startCloudSyncDaemon,
  type CloudSyncTransportInput,
} from "./syncDaemon.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

const COMPANY_ID = CompanyId.make("company-daemon");
const ENVIRONMENT_ID = EnvironmentId.make("env-daemon");
const CONVEX_URL = "https://daemon.convex.cloud";
const RELAY_URL = "https://relay.example.test";
const ENVIRONMENT_CREDENTIAL = "environment-credential";

/** Every gate satisfied. Individual tests drop one key to exercise a refusal. */
const ENABLED_ENV = {
  [CLOUD_SYNC_CAPABILITY_ENV]: "enabled",
  [CLOUD_SYNC_COMPANY_ID_ENV]: COMPANY_ID,
  PATHWAY_CONVEX_URL: CONVEX_URL,
} as const;

// --------------------------------------------------------------------------
// Fakes
// --------------------------------------------------------------------------

const unusedSecretStoreOperation = () =>
  Effect.die(new Error("unexpected secret store operation")) as never;

const encode = (value: string) => new TextEncoder().encode(value);

/**
 * An in-memory secret store. `create` is a plain write rather than a create-if-absent: the only
 * caller here is the environment key pair, which reads before it writes.
 */
function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
  const values = new Map<string, Uint8Array>(
    Array.from(initial, ([name, value]) => [name, encode(value)] as const),
  );
  const set = (name: string, value: Uint8Array) =>
    Effect.sync(() => {
      values.set(name, value);
    });
  const store: ServerSecretStore.ServerSecretStore["Service"] = {
    get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
    set,
    create: set,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: (name) =>
      Effect.sync(() => {
        values.delete(name);
      }),
  };
  return { store, values };
}

/** The secrets a linked environment has; the key pair is created on first use. */
const linkedSecrets = [
  [RELAY_URL_SECRET, RELAY_URL],
  [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, ENVIRONMENT_CREDENTIAL],
] as const;

const serverEnvironmentLayer = Layer.succeed(
  ServerEnvironment.ServerEnvironment,
  ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(ENVIRONMENT_ID),
    getDescriptor: Effect.die(new Error("unexpected environment descriptor read")),
  }),
);

interface FakeConvexServer {
  readonly transport: SyncTransport["Service"];
  readonly submissions: Ref.Ref<ReadonlyArray<SyncOperationEnvelope>>;
  /**
   * Completed at the start of the *second* cycle's drain. `Stream.runForEach` pulls the next head
   * only after the previous cycle returned, so by then everything the first cycle wrote is
   * committed and the test can assert against the database without racing the engine.
   */
  readonly secondCycleStarted: Deferred.Deferred<void>;
}

/**
 * A deployment that seeds one label, accepts whatever is submitted at version 2, and then has
 * nothing more to say. The change feed answers empty pages with an advanced cursor, which is a
 * shape the protocol allows and which keeps this fake free of hand-built entity payloads.
 */
const makeFakeConvexServer = Effect.fn("makeFakeConvexServer")(function* () {
  const submissions = yield* Ref.make<ReadonlyArray<SyncOperationEnvelope>>([]);
  const secondCycleStarted = yield* Deferred.make<void>();

  const seededLabel = {
    version: CompanyVersion.make(1),
    entityKind: "issueLabel" as const,
    entityId: SyncEntityId.make("label-seeded"),
    changeKind: "upsert" as const,
    payload: {
      entityKind: "issueLabel",
      id: "label-seeded",
      teamId: null,
      name: "Seeded",
      color: "#f97316",
      createdAt: 1,
      updatedAt: 1,
    },
  };

  const transport = SyncTransport.of({
    bootstrap: () =>
      Effect.succeed({
        version: CompanyVersion.make(1),
        authorizationEpoch: AuthorizationEpoch.make(1),
        entities: [seededLabel],
        cursor: null,
        isDone: true,
      }),

    // One head per cycle, then a stream that never ends — so `run` stays subscribed and the scope's
    // interruption is what stops it, which is exactly the teardown this test wants to exercise.
    latestVersion: () =>
      Stream.make(
        { version: CompanyVersion.make(1), authorizationEpoch: AuthorizationEpoch.make(1) },
        { version: CompanyVersion.make(2), authorizationEpoch: AuthorizationEpoch.make(1) },
      ).pipe(Stream.concat(Stream.never)),

    listChanges: (input) =>
      Effect.gen(function* () {
        if (input.cursor >= 2) {
          yield* Deferred.succeed(secondCycleStarted, undefined);
        }
        return {
          _tag: "Changes" as const,
          changes: [],
          cursor: CompanyVersion.make(2),
          hasMore: false,
          latestVersion: CompanyVersion.make(2),
          authorizationEpoch: AuthorizationEpoch.make(1),
        };
      }),

    applyOperations: (input: SyncApplyOperationsRequest) =>
      Effect.gen(function* () {
        yield* Ref.update(submissions, (current) => [...current, ...input.operations]);
        return {
          receipts: input.operations.map((operation) => ({
            operationId: operation.operationId,
            status: "accepted" as const,
            duplicate: false,
            firstVersion: CompanyVersion.make(2),
            lastVersion: CompanyVersion.make(2),
          })),
          versionFrom: CompanyVersion.make(1),
          versionTo: CompanyVersion.make(2),
          authorizationEpoch: AuthorizationEpoch.make(1),
        };
      }),

    reserveIssueKeys: () => Effect.die(new Error("unexpected reserveIssueKeys")),
  });

  return { transport, submissions, secondCycleStarted } satisfies FakeConvexServer;
});

/**
 * A deployment that answers the one subscription the supervisor's loop depends on and dies on
 * everything else, so a test that means to exercise the loop cannot silently exercise a cycle.
 */
const makeHeadOnlyTransport = (
  latestVersion: SyncTransport["Service"]["latestVersion"],
): SyncTransport["Service"] =>
  SyncTransport.of({
    bootstrap: () => Effect.die(new Error("unexpected bootstrap")),
    latestVersion,
    listChanges: () => Effect.die(new Error("unexpected listChanges")),
    applyOperations: () => Effect.die(new Error("unexpected applyOperations")),
    reserveIssueKeys: () => Effect.die(new Error("unexpected reserveIssueKeys")),
  });

/** A transport seam that fails the test if the daemon ever reaches for it. */
const forbiddenTransport = (_input: CloudSyncTransportInput) =>
  Effect.die(new Error("the disabled daemon must not build a transport")) as never;

/**
 * The relay's token exchange, refusing every time. A refusal is enough for these tests: what is
 * being asserted is *which credential was presented*, and a refused exchange is never cached, so
 * every call is observable.
 */
const makeTokenExchangeLayer = (exchanges: Array<URLSearchParams>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        exchanges.push(new URLSearchParams(body));
        return HttpClientResponse.fromWeb(
          request,
          new Response('{"error":"invalid_client","code":"auth_invalid"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

interface CapturedLog {
  readonly level: string;
  readonly parts: ReadonlyArray<unknown>;
}

/** Flattens a log's message and its annotations, causes included, into searchable text. */
const describeLogPart = (part: unknown): string => {
  if (typeof part === "string") return part;
  if (typeof part === "object" && part !== null) {
    return `${String(part)} ${Object.values(part).map(describeLogPart).join(" ")}`;
  }
  return String(part);
};

/** Captures every log the daemon emits, level included, without writing to the test output. */
function makeLogCapture() {
  const entries: Array<CapturedLog> = [];
  const logger = Logger.make<unknown, void>((options) => {
    entries.push({
      level: String(options.logLevel),
      parts: Array.isArray(options.message) ? options.message : [options.message],
    });
  });
  const text = (entry: CapturedLog) => entry.parts.map(describeLogPart).join(" ");
  return {
    entries,
    layer: Logger.layer([logger], { mergeWithExisting: false }),
    find: (level: string, needle: string) =>
      entries.find((entry) => entry.level === level && text(entry).includes(needle)),
  };
}

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

const provideDaemon = (input: {
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly logger?: Layer.Layer<never>;
}) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(ServerSecretStore.ServerSecretStore, input.secrets),
      serverEnvironmentLayer,
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env })),
      // Never called by the tests that supply their own transport. It is here because the default
      // transport's type puts an `HttpClient` in the daemon's requirements.
      FetchHttpClient.layer,
      input.logger ?? Layer.empty,
    ),
  );

/**
 * The `cloud_sync_*` tables. Their absence is the proof that no part of the enabled path ran: the
 * store's migration is the first thing {@link startCloudSyncDaemon} does once it has a link.
 */
const cloudSyncTableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ readonly name: string }>(
    `SELECT name FROM sqlite_master
      WHERE type = 'table' AND name LIKE 'cloud_sync_%' ORDER BY name`,
    [],
  );
  return rows.map((row) => row.name);
});

/**
 * Waits for something a forked fiber does. The live-clock blocks below run the daemon's schedules
 * on real millisecond delays, so the test polls rather than adjusts a clock it does not own.
 */
const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 2_000; attempt++) {
      if (predicate()) return;
      yield* Effect.sleep(Duration.millis(1));
    }
    return yield* Effect.die(new Error(`Timed out waiting for ${label}.`));
  });

const pendingIssueCreate: SyncOperationEnvelope = {
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make("op-pending-create"),
  companyId: COMPANY_ID,
  clientId: cloudSyncClientId(ENVIRONMENT_ID),
  environmentId: ENVIRONMENT_ID,
  actor: cloudSyncActor(ENVIRONMENT_ID),
  localSequence: LocalSequence.make(1),
  baseVersion: CompanyVersion.make(0),
  entityId: SyncEntityId.make("issue-pending"),
  dependsOn: [],
  kind: "issue.create",
  args: { title: "written while the daemon was down" },
};

const layer = it.layer(NodeSqliteClient.layerMemory());
/** Real timers: the supervisor's restart and link-wait schedules are what these tests drive. */
const liveLayer = it.layer(NodeSqliteClient.layerMemory(), { excludeTestServices: true });

// --------------------------------------------------------------------------
// Gates
// --------------------------------------------------------------------------

describe("cloud sync daemon gates", () => {
  const resolveWith = (input: {
    readonly env: Readonly<Record<string, string>>;
    readonly secrets?: Iterable<readonly [string, string]>;
  }) =>
    resolveCloudSyncDaemon.pipe(
      provideDaemon({
        env: input.env,
        secrets: makeMemorySecretStore(input.secrets ?? linkedSecrets).store,
      }),
    );

  it.effect("is off with no configuration at all", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ env: {} })).toEqual({
        _tag: "Disabled",
        reason: "capability-disabled",
        optedIn: false,
      });
    }),
  );

  it.effect("refuses the flag on its own, and the flag plus a deployment", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ env: { [CLOUD_SYNC_CAPABILITY_ENV]: "enabled" } })).toEqual({
        _tag: "Disabled",
        reason: "company-not-configured",
        optedIn: true,
      });

      // A company but no deployment to reach.
      expect(
        yield* resolveWith({
          env: {
            [CLOUD_SYNC_CAPABILITY_ENV]: "enabled",
            [CLOUD_SYNC_COMPANY_ID_ENV]: COMPANY_ID,
          },
        }),
      ).toMatchObject({ reason: "convex-url-unavailable", optedIn: true });

      // A deployment that is not an origin is the same *answer* as no deployment, but it is not
      // the same refusal: the operator typo'd something and the detail has to say so.
      const invalid = yield* resolveWith({
        env: { ...ENABLED_ENV, PATHWAY_CONVEX_URL: "https://daemon.convex.cloud/api" },
      });
      expect(invalid).toMatchObject({ reason: "convex-url-unavailable", optedIn: true });
      expect(invalid._tag === "Disabled" ? invalid.detail : "").toContain("absolute HTTPS origin");
    }),
  );

  it.effect("refuses an environment that is not linked", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ env: ENABLED_ENV, secrets: [] })).toEqual({
        _tag: "Disabled",
        reason: "environment-not-linked",
        optedIn: true,
      });

      // A relay URL without the credential the token exchange presents is still not linked.
      expect(
        yield* resolveWith({ env: ENABLED_ENV, secrets: [[RELAY_URL_SECRET, RELAY_URL]] }),
      ).toMatchObject({ reason: "environment-not-linked", optedIn: true });
    }),
  );

  it.effect("resolves once every gate holds", () =>
    Effect.gen(function* () {
      const resolution = yield* resolveWith({ env: ENABLED_ENV });
      expect(resolution).toEqual({
        _tag: "Enabled",
        settings: { companyId: COMPANY_ID, convexUrl: CONVEX_URL },
      });
    }),
  );

  it.effect(
    "reads the link out of the secret store rather than freezing it into the settings",
    () =>
      Effect.gen(function* () {
        const { store } = makeMemorySecretStore(linkedSecrets);

        const first = yield* readCloudSyncLink(store);
        expect(first).toMatchObject({
          relayBaseUrl: RELAY_URL,
          environmentCredential: ENVIRONMENT_CREDENTIAL,
        });
        // Created on demand, and only after the operator asked for cloud sync by name.
        expect(first?.linkPrivateKey).toContain("BEGIN PRIVATE KEY");

        // A relink replaces the credential; the next read is the new one.
        yield* store.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("environment-credential-2"));
        expect((yield* readCloudSyncLink(store))?.environmentCredential).toBe(
          "environment-credential-2",
        );

        // An unlink removes it; the next read says so instead of answering with the old one.
        yield* store.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
        expect(yield* readCloudSyncLink(store)).toBeNull();
      }),
  );

  it.effect("does not create a key pair for an environment that is not linked", () =>
    Effect.gen(function* () {
      const { store, values } = makeMemorySecretStore([]);
      expect(yield* readCloudSyncLink(store)).toBeNull();
      expect([...values.keys()]).toEqual([]);
    }),
  );

  it.effect("names the client and the actor after the environment", () =>
    Effect.gen(function* () {
      expect(cloudSyncClientId(ENVIRONMENT_ID)).toBe("pathway-environment-env-daemon");
      expect(cloudSyncActor(ENVIRONMENT_ID)).toEqual({
        kind: "environment",
        environmentId: ENVIRONMENT_ID,
      });
    }),
  );
});

// --------------------------------------------------------------------------
// Tokens
// --------------------------------------------------------------------------

describe("cloud sync service tokens", () => {
  it.effect("presents the credential the secret store holds now, not the one it started with", () =>
    Effect.gen(function* () {
      const exchanges: Array<URLSearchParams> = [];
      const { store } = makeMemorySecretStore(linkedSecrets);

      const tokens = yield* makeCloudSyncTokenProvider({
        environmentId: ENVIRONMENT_ID,
        secrets: store,
      }).pipe(Effect.provide(makeTokenExchangeLayer(exchanges)));

      const refused = yield* Effect.flip(tokens.token);
      expect(refused.reason).toBe("unauthorized");

      // What the startup relink does on every boot of a linked environment: mint a replacement
      // credential and store it, seconds after this daemon was assembled.
      yield* store.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("environment-credential-2"));
      yield* Effect.flip(tokens.token);

      expect(exchanges.map((params) => params.get("subject_token"))).toEqual([
        ENVIRONMENT_CREDENTIAL,
        "environment-credential-2",
      ]);
    }),
  );

  it.effect("fails closed, without an exchange, once the environment is unlinked", () =>
    Effect.gen(function* () {
      const exchanges: Array<URLSearchParams> = [];
      const { store } = makeMemorySecretStore(linkedSecrets);

      const tokens = yield* makeCloudSyncTokenProvider({
        environmentId: ENVIRONMENT_ID,
        secrets: store,
      }).pipe(Effect.provide(makeTokenExchangeLayer(exchanges)));

      yield* Effect.flip(tokens.token);
      expect(exchanges).toHaveLength(1);

      yield* store.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
      const refused = yield* Effect.flip(tokens.token);
      expect(refused.reason).toBe("unauthorized");
      expect(refused.message).toContain("not linked");
      // Nothing left the process: an unlinked environment has nothing to present.
      expect(exchanges).toHaveLength(1);
    }),
  );
});

// --------------------------------------------------------------------------
// Layer behaviour
// --------------------------------------------------------------------------

layer("cloud sync daemon layer", (it) => {
  it.effect("builds as a no-op without the capability flag", () =>
    Effect.gen(function* () {
      const { store, values } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();

      yield* Effect.scoped(
        Layer.build(cloudSyncDaemonLayer({ transport: forbiddenTransport })).pipe(
          provideDaemon({ env: {}, secrets: store, logger: logs.layer }),
        ),
      );

      // No replica, and no environment key pair either: the disabled path writes nothing.
      expect(yield* cloudSyncTableNames).toEqual([]);
      expect([...values.keys()].sort()).toEqual(
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET].sort(),
      );
      // A server that never asked for cloud sync is not warned about not having it.
      expect(logs.entries.filter((entry) => entry.level === "Warn")).toEqual([]);
    }),
  );

  it.effect("warns when the operator opted in and a later gate refused", () =>
    Effect.gen(function* () {
      const { store } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();

      yield* Effect.scoped(
        Layer.build(cloudSyncDaemonLayer({ transport: forbiddenTransport })).pipe(
          provideDaemon({
            // The flag is on, the company is named, and the deployment URL has a path typo'd onto
            // it. Without a warning this server boots byte-identically to one with no flag at all.
            env: { ...ENABLED_ENV, PATHWAY_CONVEX_URL: "https://daemon.convex.cloud/api" },
            secrets: store,
            logger: logs.layer,
          }),
        ),
      );

      const refusal = logs.find("Warn", "convex-url-unavailable");
      expect(refusal).toBeDefined();
      expect(refusal?.parts.map((part) => JSON.stringify(part)).join(" ")).toContain(
        "absolute HTTPS origin",
      );
      expect(yield* cloudSyncTableNames).toEqual([]);
    }),
  );

  it.effect("degrades to a no-op when the deployment URL is missing", () =>
    Effect.gen(function* () {
      const { store } = makeMemorySecretStore(linkedSecrets);

      yield* Effect.scoped(
        Layer.build(cloudSyncDaemonLayer({ transport: forbiddenTransport })).pipe(
          provideDaemon({
            env: {
              [CLOUD_SYNC_CAPABILITY_ENV]: "enabled",
              [CLOUD_SYNC_COMPANY_ID_ENV]: COMPANY_ID,
            },
            secrets: store,
          }),
        ),
      );

      expect(yield* cloudSyncTableNames).toEqual([]);
    }),
  );

  it.effect("degrades to a no-op when the environment is not linked", () =>
    Effect.gen(function* () {
      const { store, values } = makeMemorySecretStore([]);

      yield* Effect.scoped(
        Layer.build(
          // One check and no more: the wait for a late link is what the live-clock block covers.
          cloudSyncDaemonLayer({ transport: forbiddenTransport, linkWaitAttempts: 0 }),
        ).pipe(provideDaemon({ env: ENABLED_ENV, secrets: store })),
      );

      expect(yield* cloudSyncTableNames).toEqual([]);
      expect([...values.keys()]).toEqual([]);
    }),
  );

  it.effect("says out loud that an enabled server is not linked, instead of dying quietly", () =>
    Effect.gen(function* () {
      const { store } = makeMemorySecretStore([]);
      const logs = makeLogCapture();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: forbiddenTransport,
            linkWaitAttempts: 0,
          });
          expect(fiber).not.toBeNull();
          if (fiber === null) return;
          // The daemon gives up after its single check; the warning is what an operator has to
          // find when they wonder why the flag they set did nothing.
          yield* Fiber.await(fiber);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets: store, logger: logs.layer }));

      expect(logs.find("Warn", "environment-not-linked")).toBeDefined();
      expect(logs.find("Warn", "restart the server")).toBeDefined();
    }),
  );
});

// --------------------------------------------------------------------------
// The enabled path
// --------------------------------------------------------------------------

layer("cloud sync daemon", (it) => {
  it.effect("runs one cycle over the server's own database and tears down with its scope", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);

      // An operation the user made while the daemon was down. It is the outbound half of the
      // round trip, and it only reaches the wire if the daemon opened the same database.
      const seedStore = yield* makeSqliteSyncStore(yield* makeSyncSqliteExecutor);
      yield* seedStore.service.commit(COMPANY_ID, {
        upsertOutbox: [{ envelope: pendingIssueCreate, status: { _tag: "Pending" } }],
        localSequenceHighWater: LocalSequence.make(1),
      });

      const server = yield* makeFakeConvexServer();
      const registry = yield* makeCloudSyncEngineRegistry;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startCloudSyncDaemon({ transport: () => Effect.succeed(server.transport) });
          yield* Deferred.await(server.secondCycleStarted);
        }),
      ).pipe(
        provideDaemon({ env: ENABLED_ENV, secrets }),
        Effect.provideService(CloudSyncEngineRegistry, registry),
      );

      const shared = yield* registry.issueEngine(COMPANY_ID);
      expect(shared).not.toBeNull();
      expect(shared?.environmentId).toBe(ENVIRONMENT_ID);

      // Outbound: the pending operation was submitted exactly as it was stored.
      const submitted = yield* Ref.get(server.submissions);
      expect(submitted.map((envelope) => envelope.operationId)).toEqual(["op-pending-create"]);
      expect(submitted[0]).toMatchObject({
        kind: "issue.create",
        clientId: "pathway-environment-env-daemon",
        actor: { kind: "environment", environmentId: ENVIRONMENT_ID },
        environmentId: ENVIRONMENT_ID,
      });

      // Inbound and durable: the seeded entity, the advanced cursor, and an outbox the confirming
      // drain pruned are all in the database the rest of the server uses.
      const stored = yield* seedStore.service.read(COMPANY_ID);
      expect(stored.entities.map((entity) => entity.entityId)).toEqual(["label-seeded"]);
      expect(stored.checkpoint).toMatchObject({ cursor: 2, bootstrapped: true });
      expect(stored.outbox).toEqual([]);
      expect(stored.rejected).toEqual([]);
      expect(stored.quarantined).toEqual([]);
    }),
  );

  it.effect("hands the transport the secret store rather than a copy of the link", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const server = yield* makeFakeConvexServer();
      let seen: CloudSyncTransportInput | null = null;

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startCloudSyncDaemon({
            transport: (input) =>
              Effect.sync(() => {
                seen = input;
                return server.transport;
              }),
          });
          yield* Deferred.await(server.secondCycleStarted);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets }));

      const input = seen as CloudSyncTransportInput | null;
      expect(input?.secrets).toBe(secrets);
      expect(input?.settings).toEqual({ companyId: COMPANY_ID, convexUrl: CONVEX_URL });
    }),
  );
});

// --------------------------------------------------------------------------
// Supervision
// --------------------------------------------------------------------------

liveLayer("cloud sync daemon supervision", (it) => {
  const offlineHead = () =>
    Stream.fail(new SyncTransportError({ reason: "offline", message: "stub relay is offline" }));

  const refusedHead = (reason: "unauthorized" | "upgrade-required", message: string) => () =>
    Stream.fail(new SyncTransportError({ reason, message }));

  /** Runs a daemon to its own end, or fails the test if it never ends. */
  const awaitDaemonEnd = (fiber: Fiber.Fiber<void>) =>
    Fiber.await(fiber).pipe(
      Effect.timeoutOption(Duration.seconds(5)),
      Effect.map(Option.getOrUndefined),
    );

  it.effect("restarts the engine after a defect, not just after a store failure", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();
      let subscriptions = 0;

      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        // The first run dies. Nothing in `run`'s error channel carries a defect, so a loop that
        // only catches failures loses the fiber here and cloud sync never comes back.
        return subscriptions === 1
          ? Stream.fromEffect(Effect.die(new Error("engine defect")))
          : offlineHead();
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: () => Effect.succeed(transport),
            restartDelay: Duration.millis(1),
            linkWaitAttempts: 0,
          });
          expect(fiber).not.toBeNull();
          yield* awaitUntil(() => subscriptions >= 3, "the engine to restart after a defect");
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets, logger: logs.layer }));

      expect(subscriptions).toBeGreaterThanOrEqual(3);
      expect(logs.find("Warn", "engine defect")).toBeDefined();
    }),
  );

  it.effect("stops for good once the environment is unlinked", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();
      let subscriptions = 0;

      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        return offlineHead();
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: () => Effect.succeed(transport),
            restartDelay: Duration.millis(1),
            linkWaitAttempts: 0,
          });
          expect(fiber).not.toBeNull();
          if (fiber === null) return;

          yield* awaitUntil(() => subscriptions >= 2, "the restart loop to turn");

          // `pathway connect unlink` / the desktop unlink: the link secrets are removed from a
          // server whose daemon is already running.
          yield* secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET);
          yield* secrets.remove(RELAY_URL_SECRET);

          const exit = yield* Fiber.await(fiber).pipe(
            Effect.timeoutOption(Duration.seconds(5)),
            Effect.map(Option.getOrUndefined),
          );
          expect(exit).toBeDefined();
          expect(exit === undefined ? false : Exit.isSuccess(exit)).toBe(true);

          // And it stays stopped: nothing resubscribes after the daemon reported it was over.
          const settled = subscriptions;
          yield* Effect.sleep(Duration.millis(50));
          expect(subscriptions).toBe(settled);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets, logger: logs.layer }));

      expect(logs.find("Warn", "no longer linked")).toBeDefined();
    }),
  );

  it.effect("stops for good when the deployment answers upgrade-required", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();
      let subscriptions = 0;

      // The deployment refuses this build outright — cloud sync switched off there, or a protocol
      // version it will not speak. A restart timer can only reproduce the refusal.
      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        return refusedHead("upgrade-required", "this deployment refuses protocol version 1")();
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: () => Effect.succeed(transport),
            restartDelay: Duration.millis(1),
            linkWaitAttempts: 0,
          });
          expect(fiber).not.toBeNull();
          if (fiber === null) return;

          const exit = yield* awaitDaemonEnd(fiber);
          expect(exit).toBeDefined();
          expect(exit === undefined ? false : Exit.isSuccess(exit)).toBe(true);

          // Once, and never again: the restart delay is a millisecond here, so a loop that ignored
          // the reason would have run dozens of times by the end of this sleep.
          expect(subscriptions).toBe(1);
          yield* Effect.sleep(Duration.millis(50));
          expect(subscriptions).toBe(1);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets, logger: logs.layer }));

      const refusal = logs.find("Warn", "will not restart");
      expect(refusal).toBeDefined();
      const text = refusal?.parts.map((part) => JSON.stringify(part)).join(" ") ?? "";
      expect(text).toContain("upgrade-required");
      expect(text).toContain(COMPANY_ID);
      // The terminal stop is reported on its own terms, not as an unlink.
      expect(logs.find("Warn", "no longer linked")).toBeUndefined();
    }),
  );

  it.effect("gives a refused token a bounded number of retries, then stops for good", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();
      let subscriptions = 0;

      // A relay that refuses the token exchange every time. The budget exists for the relink race,
      // where the next read of the secret store carries a credential that works — this one never
      // does, so the daemon has to give up rather than ask forever.
      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        return refusedHead("unauthorized", "token exchange returned HTTP 401")();
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: () => Effect.succeed(transport),
            restartDelay: Duration.millis(1),
            linkWaitAttempts: 0,
            unauthorizedRestarts: 2,
          });
          expect(fiber).not.toBeNull();
          if (fiber === null) return;

          const exit = yield* awaitDaemonEnd(fiber);
          expect(exit).toBeDefined();
          expect(exit === undefined ? false : Exit.isSuccess(exit)).toBe(true);

          // The first run plus the two the budget paid for, and nothing after that.
          expect(subscriptions).toBe(3);
          yield* Effect.sleep(Duration.millis(50));
          expect(subscriptions).toBe(3);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets, logger: logs.layer }));

      expect(logs.entries.filter((entry) => entry.level === "Warn")).toHaveLength(3);
      expect(logs.find("Warn", "fresh service token")).toBeDefined();
      const refusal = logs.find("Warn", "will not restart");
      expect(refusal).toBeDefined();
      expect(refusal?.parts.map((part) => JSON.stringify(part)).join(" ")).toContain(
        "unauthorized",
      );
    }),
  );

  it.effect("keeps restarting after a retryable stop, and forgets the refusals before it", () =>
    Effect.gen(function* () {
      const { store: secrets } = makeMemorySecretStore(linkedSecrets);
      const logs = makeLogCapture();
      let subscriptions = 0;

      // Refusal, blip, refusal, blip… With a budget of one, a daemon that never forgot a refusal
      // would stop on the third subscription; one that resets on a retryable stop runs forever.
      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        return subscriptions % 2 === 1
          ? refusedHead("unauthorized", "the relay is mid-relink")()
          : offlineHead();
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* startCloudSyncDaemon({
            transport: () => Effect.succeed(transport),
            restartDelay: Duration.millis(1),
            linkWaitAttempts: 0,
            unauthorizedRestarts: 1,
          });
          expect(fiber).not.toBeNull();
          yield* awaitUntil(() => subscriptions >= 6, "the restart loop to keep turning");
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets, logger: logs.layer }));

      expect(subscriptions).toBeGreaterThanOrEqual(6);
      // Still running when the scope closed: nothing declared this daemon over.
      expect(logs.find("Warn", "will not restart")).toBeUndefined();
    }),
  );

  it.effect("starts once a link arrives after boot", () =>
    Effect.gen(function* () {
      // A server that has never been linked: `pathway connect link` writes the secrets over HTTP
      // long after this layer was built.
      const { store: secrets } = makeMemorySecretStore([]);
      let subscriptions = 0;
      let transportBuilds = 0;

      const transport = makeHeadOnlyTransport(() => {
        subscriptions += 1;
        return Stream.never;
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startCloudSyncDaemon({
            transport: () =>
              Effect.sync(() => {
                transportBuilds += 1;
                return transport;
              }),
            restartDelay: Duration.millis(1),
            linkWaitInterval: Duration.millis(1),
            linkWaitAttempts: 5_000,
          });

          // Nothing has run: no link, so no transport and no subscription.
          yield* Effect.sleep(Duration.millis(10));
          expect(transportBuilds).toBe(0);
          expect(subscriptions).toBe(0);

          yield* secrets.set(RELAY_URL_SECRET, encode(RELAY_URL));
          yield* secrets.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode(ENVIRONMENT_CREDENTIAL));

          yield* awaitUntil(() => subscriptions >= 1, "the daemon to start after the link arrived");
          expect(transportBuilds).toBe(1);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets }));
    }),
  );
});
