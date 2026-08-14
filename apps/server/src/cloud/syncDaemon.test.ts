/**
 * The cloud-sync daemon's gates and its one wired-up cycle.
 *
 * Two things are worth proving here and nowhere else. First, that a server which has not opted in
 * is *untouched*: the assertion for that is the database, because the replica's tables are created
 * by the very first thing the enabled path does, so their absence is proof no part of the daemon
 * ran. Second, that the enabled path is really wired — the server's SQLite executor, the issue
 * adapter, and a transport meet in one engine, an operation left in the outbox reaches the wire,
 * and what the wire answers is durable afterwards.
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
import { makeSqliteSyncStore, SyncTransport } from "@spiritdevs/client-runtime/sync";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import {
  CLOUD_SYNC_CAPABILITY_ENV,
  CLOUD_SYNC_COMPANY_ID_ENV,
  cloudSyncActor,
  cloudSyncClientId,
  cloudSyncDaemonLayer,
  resolveCloudSyncDaemon,
  startCloudSyncDaemon,
  type CloudSyncTransportInput,
} from "./syncDaemon.ts";
import { makeSyncSqliteExecutor } from "./syncSqliteExecutor.ts";

const COMPANY_ID = CompanyId.make("company-daemon");
const ENVIRONMENT_ID = EnvironmentId.make("env-daemon");
const CONVEX_URL = "https://daemon.convex.cloud";
const RELAY_URL = "https://relay.example.test";

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

/**
 * An in-memory secret store. `create` is a plain write rather than a create-if-absent: the only
 * caller here is the environment key pair, which reads before it writes.
 */
function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
  const values = new Map<string, Uint8Array>(
    Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
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
  [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "environment-credential"],
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

/** A transport seam that fails the test if the daemon ever reaches for it. */
const forbiddenTransport = (_input: CloudSyncTransportInput) =>
  Effect.die(new Error("the disabled daemon must not build a transport")) as never;

// --------------------------------------------------------------------------
// Harness
// --------------------------------------------------------------------------

const provideDaemon = (input: {
  readonly env: Readonly<Record<string, string>>;
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
}) =>
  Effect.provide(
    Layer.mergeAll(
      Layer.succeed(ServerSecretStore.ServerSecretStore, input.secrets),
      serverEnvironmentLayer,
      ConfigProvider.layer(ConfigProvider.fromEnv({ env: input.env })),
      // Never called: every test supplies its own transport. It is here only because the default
      // transport's type puts an `HttpClient` in the daemon's requirements.
      FetchHttpClient.layer,
    ),
  );

/**
 * The `cloud_sync_*` tables. Their absence is the proof that no part of the enabled path ran: the
 * store's migration is the first thing {@link startCloudSyncDaemon} does after its gates pass.
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
      });
    }),
  );

  it.effect("refuses the flag on its own, and the flag plus a deployment", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ env: { [CLOUD_SYNC_CAPABILITY_ENV]: "enabled" } })).toMatchObject(
        { reason: "company-not-configured" },
      );

      // A company but no deployment to reach.
      expect(
        yield* resolveWith({
          env: {
            [CLOUD_SYNC_CAPABILITY_ENV]: "enabled",
            [CLOUD_SYNC_COMPANY_ID_ENV]: COMPANY_ID,
          },
        }),
      ).toMatchObject({ reason: "convex-url-unavailable" });

      // A deployment that is not an origin is the same answer as no deployment.
      expect(
        yield* resolveWith({
          env: { ...ENABLED_ENV, PATHWAY_CONVEX_URL: "http://elsewhere.example.test" },
        }),
      ).toMatchObject({ reason: "convex-url-unavailable" });
    }),
  );

  it.effect("refuses an environment that is not linked", () =>
    Effect.gen(function* () {
      expect(yield* resolveWith({ env: ENABLED_ENV, secrets: [] })).toEqual({
        _tag: "Disabled",
        reason: "environment-not-linked",
      });

      // A relay URL without the credential the token exchange presents is still not linked.
      expect(
        yield* resolveWith({ env: ENABLED_ENV, secrets: [[RELAY_URL_SECRET, RELAY_URL]] }),
      ).toMatchObject({ reason: "environment-not-linked" });
    }),
  );

  it.effect("resolves once every gate holds", () =>
    Effect.gen(function* () {
      const resolution = yield* resolveWith({ env: ENABLED_ENV });
      expect(resolution._tag).toBe("Enabled");
      if (resolution._tag !== "Enabled") return;
      expect(resolution.settings).toMatchObject({
        companyId: COMPANY_ID,
        convexUrl: CONVEX_URL,
        relayBaseUrl: RELAY_URL,
        environmentCredential: "environment-credential",
      });
      // Created on demand, and only after the operator asked for cloud sync by name.
      expect(resolution.settings.linkPrivateKey).toContain("BEGIN PRIVATE KEY");
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
// Layer behaviour
// --------------------------------------------------------------------------

layer("cloud sync daemon layer", (it) => {
  it.effect("builds as a no-op without the capability flag", () =>
    Effect.gen(function* () {
      const { store, values } = makeMemorySecretStore(linkedSecrets);

      yield* Effect.scoped(
        Layer.build(cloudSyncDaemonLayer({ transport: forbiddenTransport })).pipe(
          provideDaemon({ env: {}, secrets: store }),
        ),
      );

      // No replica, and no environment key pair either: the disabled path writes nothing.
      expect(yield* cloudSyncTableNames).toEqual([]);
      expect([...values.keys()].sort()).toEqual(
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET].sort(),
      );
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
      const { store } = makeMemorySecretStore([]);

      yield* Effect.scoped(
        Layer.build(cloudSyncDaemonLayer({ transport: forbiddenTransport })).pipe(
          provideDaemon({ env: ENABLED_ENV, secrets: store }),
        ),
      );

      expect(yield* cloudSyncTableNames).toEqual([]);
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

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* startCloudSyncDaemon({ transport: () => Effect.succeed(server.transport) });
          yield* Deferred.await(server.secondCycleStarted);
        }),
      ).pipe(provideDaemon({ env: ENABLED_ENV, secrets }));

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
});
