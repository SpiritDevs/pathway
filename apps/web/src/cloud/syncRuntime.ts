/**
 * The browser host for the cloud-sync engine: one engine per company the signed-in person is a
 * member of, all of them behind a leader election so only one tab writes the replica.
 *
 * Three gates stand between this module and any network work, and all three are off by default:
 * the deployment's public config must carry the cloud values *and* the explicit
 * `VITE_PATHWAY_CLOUD_SYNC` opt-in *and* a Convex deployment URL; a Clerk session must be active
 * (its account id is the storage scope); and the person must be a member of at least one company.
 * Importing this module opens no socket and touches no storage — {@link useCloudSyncRuntime} is
 * what starts anything, and only when {@link hasCloudSyncPublicConfig} agrees.
 *
 * Everything durable is scoped by the Clerk account id, matching the IndexedDB database name
 * (`pathway:cloud-sync/<scope>/<companyId>`) and the Web Locks leader name, so signing in as
 * somebody else never reads the previous person's replica.
 *
 * @module cloud/syncRuntime
 */
import { useAuth } from "@clerk/react";
import {
  managedRelaySessionAtom,
  type ManagedRelaySession,
} from "@spiritdevs/client-runtime/relay";
import {
  CloudSyncCapability,
  makeIssueSyncAdapter,
  makeSyncEngine,
  makeWebLeaderElection,
  SyncStore,
  SyncTransport,
  SYNC_INDEXED_DB_PREFIX,
  whileLeader,
  type WebLeaderElection,
} from "@spiritdevs/client-runtime/sync";
import { makeIndexedDbSyncStore } from "@spiritdevs/client-runtime/sync/indexeddb";
import { SyncClientId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { hasCloudSyncPublicConfig, resolveCloudSyncConvexUrl } from "./publicConfig";
import {
  classifyConvexSyncTransportError,
  convexFunctionName,
  makeConvexSyncTransport,
  type ConvexArgs,
  type ConvexAuthTokenFetcher,
  type ConvexClientLike,
} from "./syncTransport";
import { makeClerkConvexTokenFetcher, managedRelayClerkTokenFetcher } from "./syncTransportAuth";
import type { SyncTransportError } from "@spiritdevs/client-runtime/sync";

/** How long a stopped engine waits before it is started again (a lost socket, a lost lock). */
const ENGINE_RESTART_DELAY = Duration.seconds(5);

/** How long the company subscription waits before reconnecting after a retryable failure. */
const COMPANIES_RETRY_DELAY = Duration.seconds(15);

// ---------------------------------------------------------------------------
// Scope and client identity
// ---------------------------------------------------------------------------

/**
 * The storage scope: the Clerk account id of the active managed-relay session, or `null` when
 * nobody is signed in. Everything else keys off this — the IndexedDB databases, the leader lock,
 * and the client id — so a sign-out stops the engines and a different account starts fresh ones.
 */
export function cloudSyncScope(session: ManagedRelaySession | null): string | null {
  const accountId = session?.accountId.trim();
  return accountId ? accountId : null;
}

/** `pathway:cloud-sync/<scope>/client-id`, the same namespace the replica databases live under. */
export function cloudSyncClientIdStorageKey(scope: string): string {
  return `${SYNC_INDEXED_DB_PREFIX}/${scope}/client-id`;
}

/** The slice of `Storage` the client id needs; a test passes a plain object. */
export interface CloudSyncClientIdStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

export interface ReadCloudSyncClientIdOptions {
  readonly scope: string;
  /** `null` means "no storage": the id is generated per page load and outboxes are not shared. */
  readonly storage?: CloudSyncClientIdStorage | null;
  readonly generateId?: () => string;
}

function ambientLocalStorage(): CloudSyncClientIdStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    // Storage access can throw outright (a blocked third-party context, a hardened profile).
    return null;
  }
}

/**
 * The installation's stable {@link SyncClientId}, generated once per browser profile per account.
 *
 * It has to survive reloads: the id scopes the outbox's local sequence, and a client that renames
 * itself on every load would restart that sequence beside its own unsent operations. When storage
 * is unavailable a fresh id is returned rather than failing — sync with a per-load identity is
 * still correct, it just cannot recognize its own earlier outbox.
 */
export function readCloudSyncClientId(options: ReadCloudSyncClientIdOptions): SyncClientId {
  const key = cloudSyncClientIdStorageKey(options.scope);
  const storage = options.storage === undefined ? ambientLocalStorage() : options.storage;
  const generate = options.generateId ?? randomUUID;

  if (storage !== null) {
    try {
      const stored = storage.getItem(key)?.trim();
      if (stored) return SyncClientId.make(stored);
    } catch {
      // Fall through to a generated id; a read that throws is a storage we cannot use.
    }
  }

  const generated = generate();
  if (storage !== null) {
    try {
      storage.setItem(key, generated);
    } catch {
      // Private-mode quota errors: keep the id for this page load rather than failing to sync.
    }
  }
  return SyncClientId.make(generated);
}

// ---------------------------------------------------------------------------
// Company discovery
// ---------------------------------------------------------------------------

/** The `companies.listMine` query, named the way Convex names a function (`module:export`). */
export const COMPANIES_LIST_MINE_FUNCTION = "companies.listMine";

const companiesListMineReference = makeFunctionReference<"query", ConvexArgs, unknown>(
  convexFunctionName(COMPANIES_LIST_MINE_FUNCTION),
);

/**
 * The fields of a `companies.listMine` row this runtime needs. Decoded structurally rather than
 * against the backend's validator, because the web app deliberately does not depend on
 * `@spiritdevs/backend`; unknown extra fields are ignored, and a row that is missing either id is
 * dropped instead of failing the whole listing.
 */
const CloudSyncCompanySummary = Schema.Struct({
  id: Schema.String,
  membershipId: Schema.String,
});

const decodeCompanySummary = Schema.decodeUnknownOption(CloudSyncCompanySummary);

/** A company to sync, with the actor its operations are attributed to. */
export interface CloudSyncCompany {
  readonly companyId: CompanyId;
  readonly actor: SyncActor;
}

/**
 * Turns a `companies.listMine` result into the companies to run engines for.
 *
 * Duplicates (the same company reached through two membership rows) collapse to the first, and a
 * row without a membership id is skipped: an operation carries an actor, and inventing one would
 * put a wrong name in the audit trail.
 */
export function decodeCloudSyncCompanies(value: unknown): ReadonlyArray<CloudSyncCompany> {
  if (!Array.isArray(value)) return [];
  const companies: Array<CloudSyncCompany> = [];
  const seen = new Set<string>();
  for (const row of value) {
    const decoded = decodeCompanySummary(row);
    if (Option.isNone(decoded)) continue;
    const { id, membershipId } = decoded.value;
    if (id.trim().length === 0 || membershipId.trim().length === 0 || seen.has(id)) continue;
    seen.add(id);
    companies.push({
      companyId: CompanyId.make(id),
      actor: { kind: "member", membershipId: MembershipId.make(membershipId) },
    });
  }
  return companies;
}

function sameCompanies(
  left: ReadonlyArray<CloudSyncCompany>,
  right: ReadonlyArray<CloudSyncCompany>,
): boolean {
  return (
    left.length === right.length &&
    left.every((company, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        company.companyId === other.companyId &&
        actorKey(company.actor) === actorKey(other.actor)
      );
    })
  );
}

function actorKey(actor: SyncActor): string {
  switch (actor.kind) {
    case "member":
      return `member:${actor.membershipId}`;
    case "environment":
      return `environment:${actor.environmentId}`;
    case "agent":
      return `agent:${actor.provider}:${actor.onBehalfOfMembershipId ?? ""}`;
    case "system":
      return `system:${actor.source}`;
  }
}

/**
 * The live membership listing as a stream: Convex re-runs the query whenever a membership changes,
 * so joining or leaving a company reconfigures the engines without a reload. Identical results are
 * dropped, because Convex replays the current value on every reconnect.
 */
export function cloudSyncCompaniesStream(
  client: ConvexClientLike,
): Stream.Stream<ReadonlyArray<CloudSyncCompany>, SyncTransportError> {
  return Stream.callback<unknown, SyncTransportError>((queue) =>
    Effect.gen(function* () {
      const unsubscribe = client.onUpdate(
        companiesListMineReference,
        {},
        (value) => {
          Queue.offerUnsafe(queue, value);
        },
        (error) => {
          Queue.failCauseUnsafe(queue, Cause.fail(classifyConvexSyncTransportError(error)));
        },
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          unsubscribe();
        }),
      );
    }),
  ).pipe(Stream.map(decodeCloudSyncCompanies), Stream.changesWith(sameCompanies));
}

// ---------------------------------------------------------------------------
// Engine set reconciliation
// ---------------------------------------------------------------------------

export interface CloudSyncEngineReconciliation {
  readonly start: ReadonlyArray<CloudSyncCompany>;
  readonly stop: ReadonlyArray<CompanyId>;
}

/**
 * What has to change for the running engines to match the current membership listing.
 *
 * A company whose actor changed (a membership removed and re-created) is both stopped and started:
 * the actor is baked into the engine's adapter, and a restart is cheaper to reason about than a
 * live swap. The replica survives it — it lives in IndexedDB, not in the engine.
 */
export function reconcileCloudSyncEngines(
  running: ReadonlyMap<CompanyId, CloudSyncCompany>,
  desired: ReadonlyArray<CloudSyncCompany>,
): CloudSyncEngineReconciliation {
  const desiredById = new Map(desired.map((company) => [company.companyId, company] as const));
  const start = desired.filter((company) => {
    const current = running.get(company.companyId);
    return current === undefined || actorKey(current.actor) !== actorKey(company.actor);
  });
  const stop = [...running.entries()]
    .filter(([companyId, current]) => {
      const next = desiredById.get(companyId);
      return next === undefined || actorKey(next.actor) !== actorKey(current.actor);
    })
    .map(([companyId]) => companyId);
  return { start, stop };
}

// ---------------------------------------------------------------------------
// The engine supervisor
// ---------------------------------------------------------------------------

interface RunningEngine {
  readonly company: CloudSyncCompany;
  readonly scope: Scope.Closeable;
}

/**
 * Everything a leader tab needs from the network: the transport its engines speak, and the live
 * membership listing that says which engines to run. Both come from one Convex connection.
 */
export interface CloudSyncConnection {
  readonly transport: SyncTransport["Service"];
  readonly companies: Stream.Stream<ReadonlyArray<CloudSyncCompany>, SyncTransportError>;
}

export interface CloudSyncEnginesOptions {
  readonly clientId: SyncClientId;
  readonly election: WebLeaderElection;
  /**
   * Opens the Convex connection. Run *inside* the leadership body and released with it, because a
   * follower tab has no work for a socket to do: it would sit authenticated and subscription-less
   * for the life of the tab, and every tab of the account would independently drive Clerk's token
   * refresh. Reclaiming leadership opens a fresh connection, which is also how a tab recovers from
   * a client that has given up on authenticating.
   */
  readonly connect: Effect.Effect<CloudSyncConnection, never, Scope.Scope>;
  /** Overridable so a test does not have to wait out the real backoff. */
  readonly restartDelay?: Duration.Input;
}

/**
 * Why a company's engine stopped, and whether starting it again could change anything.
 *
 * `engine.run` does not fail on a transport error — it records the phase and returns — so the
 * reason has to be read back off the engine's published state rather than caught.
 */
interface CloudSyncEngineStop {
  readonly retryable: boolean;
  readonly error: SyncTransportError | null;
}

/**
 * Runs one engine per company, for as long as this tab holds the scope's leadership and the
 * surrounding scope is open.
 *
 * Leadership is taken once, around the whole engine set, rather than per engine. Two reasons: the
 * companies of one account share a single IndexedDB database, so "one writer" is a property of the
 * scope and not of a company; and {@link WebLeaderElection} admits one leadership body per context
 * by design, so N bodies over one election would serialize into a single running engine.
 *
 * Inside that body each company gets its own {@link Scope}, so a membership change interrupts
 * exactly its engine. Engines are *built* inside the body too: construction reads and can write the
 * store (it quarantines unreadable outbox rows), which a follower tab must never do.
 *
 * The capability is provided here as enabled. It is a deliberate inversion of the default: nothing
 * reaches this function unless the public-config flag already said yes, and an engine that ran with
 * the capability off would be a silent no-op that looks like a working sync.
 */
export const runCloudSyncEngines = Effect.fn("web.cloudSync.engines")(function* (
  options: CloudSyncEnginesOptions,
) {
  const clock = yield* Clock.clockWith(Effect.succeed);
  const restartDelay = options.restartDelay ?? ENGINE_RESTART_DELAY;

  /**
   * Runs one engine to a stop and reports why it stopped.
   *
   * `engine.run` ends normally when the change feed drops — the engine records the phase and the
   * error on its state and returns — so the reason is read back off {@link SyncEngine.state} rather
   * than caught. No error at all (an interrupted subscription, a clean end) counts as retryable:
   * that is the ordinary "socket went away" ending this loop exists for.
   */
  const engineProgram = (company: CloudSyncCompany) =>
    Effect.gen(function* () {
      const engine = yield* makeSyncEngine({
        companyId: company.companyId,
        clientId: options.clientId,
        actor: company.actor,
        adapter: makeIssueSyncAdapter({
          actor: company.actor,
          now: () => clock.currentTimeMillisUnsafe(),
        }),
      });
      yield* engine.run;
      const { lastError } = yield* SubscriptionRef.get(engine.state);
      return {
        retryable: lastError === null || isRetryableTransportError(lastError),
        error: lastError,
      } satisfies CloudSyncEngineStop;
    });

  /**
   * Restarts a company's engine for as long as restarting it could change the answer, and one
   * company's trouble never stops the others.
   *
   * A dropped socket or an offline device is worth another try shortly. An `unauthorized` or
   * `upgrade-required` answer is not: the same token and the same build would be refused again, so
   * a timer would only reproduce the refusal every {@link restartDelay} for the life of the tab
   * while hiding the one thing the operator needs to see. Those stop, loudly and once — the engine
   * keeps its `failed` phase for the UI, and the next reload (or the next leadership pass, which
   * rebuilds the engine set) is what retries.
   *
   * Only typed failures are caught: a defect still kills the fiber, and an interrupt still ends the
   * loop. A store failure is treated as retryable — it is the local replica, not a verdict from the
   * server.
   */
  const superviseCompany = (company: CloudSyncCompany) =>
    engineProgram(company).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Cloud sync engine stopped; retrying.", {
          companyId: company.companyId,
          error,
        }).pipe(Effect.as({ retryable: true, error: null } satisfies CloudSyncEngineStop)),
      ),
      Effect.tap((stop) =>
        stop.retryable
          ? Effect.void
          : Effect.logError("Cloud sync engine stopped and will not retry.", {
              companyId: company.companyId,
              reason: stop.error?.reason,
              error: stop.error,
            }),
      ),
      Effect.repeat({
        schedule: Schedule.spaced(restartDelay),
        while: (stop: CloudSyncEngineStop) => stop.retryable,
      }),
      Effect.withSpan("web.cloudSync.company", { attributes: { companyId: company.companyId } }),
    );

  /** One pass of leadership: the connection, and the engine set reconciled against its listing. */
  const leadershipBody = Effect.gen(function* () {
    const connection = yield* options.connect;
    const running = yield* Ref.make(new Map<CompanyId, RunningEngine>());

    const stopCompany = Effect.fn("web.cloudSync.stopCompany")(function* (companyId: CompanyId) {
      const current = yield* Ref.get(running);
      const entry = current.get(companyId);
      if (entry === undefined) return;
      const next = new Map(current);
      next.delete(companyId);
      yield* Ref.set(running, next);
      yield* Scope.close(entry.scope, Exit.void);
    });

    // Uninterruptible: a scope created but never recorded would leak its engine fiber past the
    // reconciliation that was supposed to own it.
    const startCompany = Effect.fn("web.cloudSync.startCompany")(function* (
      company: CloudSyncCompany,
    ) {
      const scope = yield* Scope.make();
      yield* superviseCompany(company).pipe(
        Effect.provideService(SyncTransport, connection.transport),
        Effect.forkIn(scope),
      );
      yield* Ref.update(running, (current) =>
        new Map(current).set(company.companyId, { company, scope }),
      );
    }, Effect.uninterruptible);

    const reconcile = Effect.fn("web.cloudSync.reconcile")(function* (
      desired: ReadonlyArray<CloudSyncCompany>,
    ) {
      const current = yield* Ref.get(running);
      const { start, stop } = reconcileCloudSyncEngines(
        new Map([...current].map(([companyId, entry]) => [companyId, entry.company] as const)),
        desired,
      );
      yield* Effect.forEach(stop, stopCompany, { discard: true });
      yield* Effect.forEach(start, startCompany, { discard: true });
    });

    yield* Effect.addFinalizer(() =>
      Ref.get(running).pipe(
        Effect.flatMap((current) =>
          Effect.forEach(current.values(), (entry) => Scope.close(entry.scope, Exit.void), {
            discard: true,
          }),
        ),
        Effect.flatMap(() => Ref.set(running, new Map<CompanyId, RunningEngine>())),
      ),
    );

    yield* Stream.runForEach(connection.companies, reconcile);
  }).pipe(Effect.scoped, Effect.provideService(CloudSyncCapability, { enabled: true }));

  /**
   * Losing the lock is ordinary — another tab took over, or this one was backgrounded — so it waits
   * and asks again. A transport failure is not swallowed here: the runtime above decides whether
   * reconnecting is worth it.
   */
  yield* whileLeader(options.election, leadershipBody).pipe(
    Effect.catch((error) =>
      error._tag === "WebLeaderError"
        ? Effect.logWarning("Cloud sync lost leadership; waiting to reclaim it.", { error })
        : Effect.fail(error),
    ),
    Effect.repeat(Schedule.spaced(restartDelay)),
  );
});

// ---------------------------------------------------------------------------
// The whole runtime
// ---------------------------------------------------------------------------

export interface CloudSyncRuntimeOptions {
  /** The Clerk account id; scopes the replica databases, the leader lock, and the client id. */
  readonly scope: string;
  readonly convexUrl: string;
  readonly fetchToken: ConvexAuthTokenFetcher;
  /** Injectable so a test can drive the runtime without a socket or a browser profile. */
  readonly client?: ConvexClientLike;
  readonly clientId?: SyncClientId;
  readonly indexedDb?: IDBFactory;
  readonly restartDelay?: Duration.Input;
  readonly retryDelay?: Duration.Input;
}

/** Retryable transport trouble is worth reconnecting for; an authorization answer is not. */
function isRetryableTransportError(error: SyncTransportError): boolean {
  return error.reason === "offline" || error.reason === "transport";
}

/**
 * The complete browser runtime: one leader election, one IndexedDB store, and — only once this tab
 * is the leader — one Convex connection with an engine per company, all owned by the surrounding
 * scope.
 *
 * The Convex client is constructed here rather than left to the transport so the same socket
 * carries both the sync functions and the membership subscription. It is constructed *lazily*,
 * inside the leadership body: `new ConvexClient(url)` opens a WebSocket in its constructor and
 * `setAuth` immediately mints a Clerk token, so building it eagerly would have every open tab hold
 * an authenticated, subscription-less socket. An injected client (a test) is shared across
 * leadership passes and left for its owner to close.
 */
export const runCloudSyncRuntime = Effect.fn("web.cloudSync.run")(function* (
  options: CloudSyncRuntimeOptions,
) {
  const store = yield* makeIndexedDbSyncStore({
    scope: options.scope,
    ...(options.indexedDb === undefined ? {} : { factory: options.indexedDb }),
  });
  yield* Effect.addFinalizer(() => store.close);
  const election = yield* makeWebLeaderElection({ scope: options.scope });
  const clientId = options.clientId ?? readCloudSyncClientId({ scope: options.scope });

  const connect = Effect.gen(function* () {
    const client =
      options.client ??
      (yield* Effect.acquireRelease(
        Effect.sync(() => new ConvexClient(options.convexUrl) as ConvexClientLike),
        (owned) => Effect.tryPromise(() => owned.close()).pipe(Effect.ignore),
      ));
    const transport = yield* makeConvexSyncTransport({
      convexUrl: options.convexUrl,
      fetchToken: options.fetchToken,
      client,
    });
    return { transport, companies: cloudSyncCompaniesStream(client) } satisfies CloudSyncConnection;
  });

  const engines = runCloudSyncEngines({
    clientId,
    election,
    connect,
    ...(options.restartDelay === undefined ? {} : { restartDelay: options.restartDelay }),
  }).pipe(Effect.provideService(SyncStore, store.service));

  const reconnecting = Effect.retry(
    engines.pipe(
      Effect.tapError((error) =>
        Effect.logWarning("Cloud sync company subscription stopped.", { error }),
      ),
    ),
    {
      while: isRetryableTransportError,
      schedule: Schedule.spaced(options.retryDelay ?? COMPANIES_RETRY_DELAY),
    },
  );

  yield* reconnecting.pipe(
    Effect.catch((error) => Effect.logError("Cloud sync stopped.", { error })),
  );
});

// ---------------------------------------------------------------------------
// React wiring
// ---------------------------------------------------------------------------

/**
 * The Convex socket authenticates with a Clerk token minted from the `convex` JWT template, which
 * only the signed-in React tree can produce. The runtime holds this stable indirection and reads
 * whatever the provider last registered, so the layer never has to be rebuilt when Clerk's
 * `getToken` identity changes across renders. Before a provider registers one, the relay token is
 * the fallback — it is refused by a deployment that has not also registered the relay template,
 * which is the intended, visible failure rather than a silent unauthenticated socket.
 */
let registeredConvexTokenFetcher: ConvexAuthTokenFetcher | null = null;

export function activateCloudSyncConvexTokenFetcher(fetcher: ConvexAuthTokenFetcher): void {
  registeredConvexTokenFetcher = fetcher;
}

export function deactivateCloudSyncConvexTokenFetcher(): void {
  registeredConvexTokenFetcher = null;
}

const cloudSyncConvexTokenFetcher: ConvexAuthTokenFetcher = (args) =>
  (registeredConvexTokenFetcher ?? managedRelayClerkTokenFetcher)(args);

const cloudSyncAtomRuntime = Atom.runtime(Layer.empty);

/**
 * One runtime per scope. The atom's lifetime is the engines' lifetime: it starts when a component
 * first reads it and everything — sockets, engines, the leader lock — is released when the last
 * reader goes away, which is what makes sign-out a stop rather than a leak.
 */
const cloudSyncRuntimeAtom = Atom.family((scope: string) =>
  cloudSyncAtomRuntime
    .atom(
      Effect.suspend(() => {
        const convexUrl = resolveCloudSyncConvexUrl();
        return convexUrl === null
          ? Effect.void
          : runCloudSyncRuntime({ scope, convexUrl, fetchToken: cloudSyncConvexTokenFetcher });
      }),
    )
    .pipe(Atom.withLabel(`cloud-sync:${scope}`)),
);

const CLOUD_SYNC_IDLE_ATOM = Atom.make(AsyncResult.success<void>(undefined)).pipe(
  Atom.keepAlive,
  Atom.withLabel("cloud-sync:disabled"),
);

/**
 * Reads an atom from the app's own {@link appAtomRegistry}, rather than from whichever registry
 * happens to be in React context above the caller.
 *
 * The managed-relay session is *written* imperatively into `appAtomRegistry` by
 * `cloud/managedAuth.tsx` (`setManagedRelaySession(appAtomRegistry, …)`), so it is only visible to
 * a reader that names the same registry. `useAtomValue` resolves its registry from
 * `RegistryContext`, whose default value is a private registry the app never writes to — a reader
 * mounted outside `AppAtomRegistryProvider` would therefore sit on a permanently empty session and
 * never start sync, silently. Naming the registry makes the answer independent of where this hook
 * is mounted, which matters because the runtime deliberately mounts high in the tree (inside the
 * auth provider, above the app's registry provider).
 *
 * The subscription is what keeps the atom's node alive, so the runtime atom's lifetime is still the
 * mounted lifetime of the component that reads it.
 */
function useAppAtomValue<A>(atom: Atom.Atom<A>): A {
  const store = useMemo(
    () => ({
      subscribe: (onStoreChange: () => void) => appAtomRegistry.subscribe(atom, onStoreChange),
      snapshot: () => appAtomRegistry.get(atom),
      serverSnapshot: () => Atom.getServerValue(atom, appAtomRegistry),
    }),
    [atom],
  );
  return useSyncExternalStore(store.subscribe, store.snapshot, store.serverSnapshot);
}

/**
 * The storage scope cloud sync would run under right now: the signed-in account, or `null`. Read
 * from the app's registry, which is where `ManagedRelayAuthProvider` publishes the session.
 */
export function useCloudSyncScope(): string | null {
  return cloudSyncScope(useAppAtomValue(managedRelaySessionAtom));
}

/**
 * Starts cloud sync for the signed-in account while the calling component is mounted, and stops it
 * on sign-out. With the flag off (or no session) this subscribes to an inert atom: no Convex
 * client is constructed, no database is opened, and no lock is taken.
 */
export function useCloudSyncRuntime(): void {
  const scope = useCloudSyncScope();
  const atom =
    scope !== null && hasCloudSyncPublicConfig()
      ? cloudSyncRuntimeAtom(scope)
      : CLOUD_SYNC_IDLE_ATOM;
  useAppAtomValue(atom);
}

/**
 * Mounts the runtime and supplies its token source. Belongs inside `ManagedRelayAuthProvider`,
 * which is itself inside `ClerkProvider` — this component calls `useAuth`, and reads the session
 * that provider publishes.
 *
 * It renders nothing and takes no children on purpose: the whole module (this file, the engine, and
 * `convex/browser`) is loaded lazily by `main.tsx`, and a wrapper would have had the app tree
 * unmount and remount as the chunk resolved.
 */
export function CloudSyncRuntime(): null {
  const { getToken } = useAuth();

  useEffect(() => {
    activateCloudSyncConvexTokenFetcher(makeClerkConvexTokenFetcher(getToken));
    return () => {
      deactivateCloudSyncConvexTokenFetcher();
    };
  }, [getToken]);

  useCloudSyncRuntime();

  return null;
}
