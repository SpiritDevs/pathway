/**
 * The browser host for the cloud-sync engine: one engine per company the signed-in person is a
 * member of, all of them behind a leader election so only one tab writes the replica.
 *
 * Three concrete prerequisites stand between this module and any network work: the deployment's
 * public config must carry a configured Convex deployment URL; a Clerk session must be active
 * (its account id is the storage scope); and the person must be a member of at least one company.
 * Importing this module opens no socket and touches no storage — {@link useCloudSyncRuntime} is
 * what starts anything, and only when {@link hasCloudSyncPublicConfig} agrees.
 *
 * Everything durable is scoped by the Clerk account id, matching the IndexedDB database name
 * (`pathway:cloud-sync/<scope>/<companyId>`) and the Web Locks leader name. Signing out marks the
 * scope for a full reset (`syncReset.ts`); the next sign-in discards the replica and every scoped
 * storage key before connecting, so a returning session re-bootstraps everything from Convex —
 * the same fresh start a first install gets.
 *
 * @module cloud/syncRuntime
 */
import { useAuth } from "@clerk/react";
import {
  type CompanyRegistryReplicaState,
  RelayConnectionRegistration,
  RelayConnectionTarget,
} from "@spiritdevs/client-runtime/connection";
import {
  managedRelaySessionAtom,
  type ManagedRelaySession,
} from "@spiritdevs/client-runtime/relay";
import {
  makeIssueSyncAdapter,
  makeSyncEngine,
  makeWebLeaderElection,
  SyncStore,
  SyncStoreError,
  SyncTransport,
  SyncTransportError,
  SYNC_INDEXED_DB_PREFIX,
  whileLeader,
  type WebLeaderElection,
} from "@spiritdevs/client-runtime/sync";
import { makeIndexedDbSyncStore } from "@spiritdevs/client-runtime/sync/indexeddb";
import { runAtomCommand } from "@spiritdevs/client-runtime/state/runtime";
import { SyncClientId, type SyncActor } from "@spiritdevs/contracts/cloudSync";
import { CompanyId, MembershipId } from "@spiritdevs/contracts/company";
import { EnvironmentId } from "@spiritdevs/contracts";
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
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { randomUUID } from "../lib/utils";
import { environmentCatalog, localEnvironmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { relayEnvironmentDiscovery } from "../state/relay";
import {
  companyRegistryReplicasAtom,
  publishCompanyRegistryMembershipId,
  publishCompanyRegistryReplica,
} from "./companyRegistryReplica";
import {
  publishCompanySyncEngineHandle,
  type CompanySyncEngineMutationHandle,
} from "./companySyncEngines";
import {
  isEnvironmentRegistration,
  readPrimaryEnvironmentRegistrationInfo,
  registerEnvironmentAutomatically,
} from "./environmentRegistration";
import { hasCloudSyncPublicConfig, resolveCloudSyncConvexUrl } from "./publicConfig";
import {
  clearCloudSyncNamespaceKeys,
  clearCloudSyncReset,
  readCloudSyncReset,
  type SyncResetStorage,
} from "./syncReset";
import { publishCloudSyncTabState, publishCompanySyncStatus } from "./syncStatus";
import { deriveCompanySyncStatus, type CompanySyncStatus } from "./syncStatus.logic";
import {
  classifyConvexSyncTransportError,
  convexFunctionName,
  makeConvexSyncTransport,
  type ConvexArgs,
  type ConvexAuthTokenFetcher,
  type ConvexClientLike,
} from "./syncTransport";
import { makeClerkConvexTokenFetcher, managedRelayClerkTokenFetcher } from "./syncTransportAuth";
import { usePrimaryCloudLinkState } from "./primaryCloudLinkState";
import { useEnvironmentControl } from "./useEnvironmentControl";
import { automaticCloudRetryDelayMs, useAlwaysOnCloudLink } from "./useCloudLinkController";

/** How long a stopped engine waits before it is started again (a lost socket, a lost lock). */
const ENGINE_RESTART_DELAY = Duration.seconds(5);

/** How long the company subscription waits before reconnecting after a retryable failure. */
const COMPANIES_RETRY_DELAY = Duration.seconds(15);

// #region DEBUG
type CloudSyncDebugField = string | number | boolean | null;

function debugCloudSync(
  hypothesis: `H${number}`,
  event: string,
  fields: Readonly<Record<string, CloudSyncDebugField>> = {},
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis, event, fields }),
  }).catch(() => undefined);
}

function debugCloudSyncErrorFields(error: unknown): Readonly<Record<string, CloudSyncDebugField>> {
  if (typeof error !== "object" || error === null) return { kind: typeof error };
  const record = error as Record<string, unknown>;
  return {
    tag: typeof record._tag === "string" ? record._tag : null,
    reason: typeof record.reason === "string" ? record.reason : null,
    name: typeof record.name === "string" ? record.name : null,
  };
}

function debugBootstrapCursorFields(
  cursor: string | null,
): Readonly<Record<string, CloudSyncDebugField>> {
  if (cursor === null) return { cursorPresent: false, cursorLength: 0 };
  try {
    const parsed: unknown = JSON.parse(cursor);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { cursorPresent: true, cursorLength: cursor.length, cursorShape: "non-object" };
    }
    const record = parsed as Record<string, unknown>;
    return {
      cursorPresent: true,
      cursorLength: cursor.length,
      cursorKind: typeof record.k === "string" ? record.k : null,
      afterIdLength: typeof record.a === "string" ? record.a.length : null,
      snapshotVersionIsInteger:
        typeof record.v === "number" ? Number.isSafeInteger(record.v) : false,
    };
  } catch {
    return { cursorPresent: true, cursorLength: cursor.length, cursorShape: "invalid-json" };
  }
}
// #endregion DEBUG

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
/** Repairs bootstrap data for an existing workspace without creating a default one. */
export const COMPANIES_REPAIR_CURRENT_USER_WORKSPACE_FUNCTION =
  "companies.repairCurrentUserWorkspace";

const companiesListMineReference = makeFunctionReference<"query", ConvexArgs, unknown>(
  convexFunctionName(COMPANIES_LIST_MINE_FUNCTION),
);
const companiesRepairCurrentUserWorkspaceReference = makeFunctionReference<
  "mutation",
  ConvexArgs,
  unknown
>(convexFunctionName(COMPANIES_REPAIR_CURRENT_USER_WORKSPACE_FUNCTION));

/** Runs before company discovery so every engine starts from a complete company bootstrap. */
export const repairCloudSyncCurrentUserWorkspace = Effect.fn("web.cloudSync.repairCurrentUser")(
  function* (client: Pick<ConvexClientLike, "mutation">) {
    return yield* Effect.tryPromise({
      try: () => client.mutation(companiesRepairCurrentUserWorkspaceReference, {}),
      catch: classifyConvexSyncTransportError,
    });
  },
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
 * A decoded membership listing. Only `decodedCleanly: true` is proof that absence means removal;
 * a malformed row may be a company the current client simply failed to understand.
 */
export interface CloudSyncCompanyListing {
  readonly companies: ReadonlyArray<CloudSyncCompany>;
  readonly decodedCleanly: boolean;
  readonly droppedRows: number;
}

/**
 * Turns a `companies.listMine` result into the companies to run engines for.
 *
 * Duplicates (the same company reached through two membership rows) collapse to the first, and a
 * row without a membership id is skipped: an operation carries an actor, and inventing one would
 * put a wrong name in the audit trail.
 */
export function decodeCloudSyncCompanies(value: unknown): CloudSyncCompanyListing {
  if (!Array.isArray(value)) return { companies: [], decodedCleanly: false, droppedRows: 1 };
  const companies: Array<CloudSyncCompany> = [];
  const seen = new Set<string>();
  let droppedRows = 0;
  for (const row of value) {
    const decoded = decodeCompanySummary(row);
    if (Option.isNone(decoded)) {
      droppedRows += 1;
      continue;
    }
    const { id, membershipId } = decoded.value;
    if (id.trim().length === 0 || membershipId.trim().length === 0) {
      droppedRows += 1;
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    companies.push({
      companyId: CompanyId.make(id),
      actor: { kind: "member", membershipId: MembershipId.make(membershipId) },
    });
  }
  return { companies, decodedCleanly: droppedRows === 0, droppedRows };
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

function sameCompanyListings(left: CloudSyncCompanyListing, right: CloudSyncCompanyListing) {
  return (
    left.decodedCleanly === right.decodedCleanly &&
    left.droppedRows === right.droppedRows &&
    sameCompanies(left.companies, right.companies)
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
): Stream.Stream<CloudSyncCompanyListing, SyncTransportError> {
  return Stream.callback<unknown, SyncTransportError>(
    (queue) =>
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
    // Only the newest listing matters: reconcile is a full diff against it, so a burst of
    // membership writes coalesces here instead of queuing one reconcile per stale intermediate.
    { bufferSize: 1, strategy: "sliding" },
  ).pipe(Stream.map(decodeCloudSyncCompanies), Stream.changesWith(sameCompanyListings));
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
  readonly companies: Stream.Stream<CloudSyncCompanyListing, SyncTransportError>;
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
  readonly connect: Effect.Effect<CloudSyncConnection, SyncTransportError, Scope.Scope>;
  /** Publishes each engine's existing replica view for catalog discovery. */
  readonly publishCompanyRegistryReplica?: (
    companyId: CompanyId,
    replica: { readonly view: ReadonlyMap<string, unknown> } | null,
  ) => Effect.Effect<void>;
  /** Publishes the actor membership beside the replica so issue UI never invents human identity. */
  readonly publishCompanyRegistryMembershipId?: (
    companyId: CompanyId,
    membershipId: MembershipId | null,
  ) => Effect.Effect<void>;
  /** Publishes the narrow mutation surface only while its engine is alive in this leader tab. */
  readonly publishCompanySyncEngineHandle?: (
    companyId: CompanyId,
    handle: CompanySyncEngineMutationHandle | null,
  ) => Effect.Effect<void>;
  /** Publishes the compact health state alongside the replica view. */
  readonly publishCompanySyncStatus?: (
    companyId: CompanyId,
    status: CompanySyncStatus | null,
  ) => Effect.Effect<void>;
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
 * Cloud sync is part of every signed-in workspace, so reaching this function is sufficient to run
 * the engines. Build-time capability gates would leave a correctly authenticated workspace looking
 * connected while silently withholding its projects and threads.
 */
export const runCloudSyncEngines = Effect.fn("web.cloudSync.engines")(function* (
  options: CloudSyncEnginesOptions,
) {
  // #region DEBUG
  yield* Effect.sync(() => debugCloudSync("H1", "engines-entered"));
  // #endregion DEBUG
  const clock = yield* Clock.clockWith(Effect.succeed);
  const store = yield* SyncStore;
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
      const publishReplica = options.publishCompanyRegistryReplica;
      const publishStatus = options.publishCompanySyncStatus;
      if (publishReplica !== undefined || publishStatus !== undefined) {
        yield* SubscriptionRef.changes(engine.state).pipe(
          Stream.runForEach((state) => {
            const status = deriveCompanySyncStatus(state);
            return Effect.all(
              [
                // #region DEBUG
                Effect.sync(() =>
                  debugCloudSync("H3", "engine-state-published", {
                    phase: status.phase,
                    pendingCount: status.pendingCount,
                    errorClassification: status.lastError?.classification ?? null,
                  }),
                ),
                // #endregion DEBUG
                publishReplica?.(company.companyId, state),
                publishStatus?.(company.companyId, status),
              ].filter((effect): effect is Effect.Effect<void> => effect !== undefined),
              { discard: true },
            );
          }),
          Effect.forkChild,
        );
      }
      const drive = Effect.gen(function* () {
        yield* engine.run;
        const { lastError } = yield* SubscriptionRef.get(engine.state);
        return {
          retryable: lastError === null || isRetryableTransportError(lastError),
          error: lastError,
        } satisfies CloudSyncEngineStop;
      });
      const publishHandle = options.publishCompanySyncEngineHandle;
      if (publishHandle === undefined) return yield* drive;

      yield* publishHandle(company.companyId, {
        enqueue: engine.enqueue,
        discardRejected: engine.discardRejected,
        sync: engine.sync,
      });
      // Covers every exit: authenticated terminal errors, retryable feed loss, membership removal,
      // leadership loss, and runtime teardown. A retry publishes its replacement only after this
      // handle is gone, so mutations never target an engine whose driver has stopped.
      return yield* drive.pipe(Effect.ensuring(publishHandle(company.companyId, null)));
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
    // #region DEBUG
    yield* Effect.sync(() => debugCloudSync("H1", "leadership-body-entered"));
    // #endregion DEBUG
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
      // #region DEBUG
      yield* Effect.sync(() => debugCloudSync("H3", "company-engine-starting"));
      // #endregion DEBUG
      const scope = yield* Scope.make();
      yield* Scope.addFinalizer(
        scope,
        Effect.all(
          [
            options.publishCompanyRegistryReplica?.(company.companyId, null),
            options.publishCompanyRegistryMembershipId?.(company.companyId, null),
            options.publishCompanySyncStatus?.(company.companyId, null),
          ].filter((effect): effect is Effect.Effect<void> => effect !== undefined),
          { discard: true },
        ),
      );
      if (company.actor.kind === "member") {
        yield* (
          options.publishCompanyRegistryMembershipId?.(
            company.companyId,
            company.actor.membershipId,
          ) ?? Effect.void
        );
      }
      yield* superviseCompany(company).pipe(
        Effect.provideService(SyncTransport, connection.transport),
        Effect.forkIn(scope),
      );
      yield* Ref.update(running, (current) =>
        new Map(current).set(company.companyId, { company, scope }),
      );
    }, Effect.uninterruptible);

    const purgeCompany = Effect.fn("web.cloudSync.purgeCompany")(function* (companyId: CompanyId) {
      const state = yield* store.read(companyId);
      const operationCount = new Set([
        ...state.outbox.map((entry) => entry.envelope.operationId),
        ...state.rejected.map((entry) => entry.envelope.operationId),
        ...state.quarantined.map((entry) => entry.envelope.operationId),
      ]).size;
      yield* store.clear(companyId);
      yield* Effect.logWarning(
        "Cloud sync local state purged after authenticated company removal.",
        { companyId, operationCount },
      );
    });

    const reconcile = Effect.fn("web.cloudSync.reconcile")(function* (
      listing: CloudSyncCompanyListing,
    ) {
      // #region DEBUG
      yield* Effect.sync(() =>
        debugCloudSync("H3", "company-listing-received", {
          companyCount: listing.companies.length,
          decodedCleanly: listing.decodedCleanly,
          droppedRows: listing.droppedRows,
        }),
      );
      // #endregion DEBUG
      const current = yield* Ref.get(running);
      if (!listing.decodedCleanly) {
        yield* Effect.logWarning(
          "Cloud sync company listing contained rows this client could not decode; retaining absent local state.",
          { droppedRows: listing.droppedRows },
        );
      }
      // A partial listing may safely start or refresh the rows it did decode, but it cannot prove
      // that anything absent was revoked. Keep the current set alongside the decoded rows.
      const desired = listing.decodedCleanly
        ? listing.companies
        : [
            ...new Map([
              ...[...current.values()].map(
                (entry) => [entry.company.companyId, entry.company] as const,
              ),
              ...listing.companies.map((company) => [company.companyId, company] as const),
            ]).values(),
          ];
      const { start, stop } = reconcileCloudSyncEngines(
        new Map([...current].map(([companyId, entry]) => [companyId, entry.company] as const)),
        desired,
      );
      const desiredIds = new Set(desired.map((company) => company.companyId));
      const revoked = listing.decodedCleanly
        ? (yield* store.listCompanyIds).filter((companyId) => !desiredIds.has(companyId))
        : [];
      yield* Effect.forEach(new Set([...stop, ...revoked]), stopCompany, { discard: true });
      yield* Effect.forEach(revoked, purgeCompany, { discard: true });
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
  }).pipe(Effect.scoped);

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
 * A real authorization refusal is terminal, but a request made before Clerk can supply any token
 * is a startup condition. Convex reports both as `not-authenticated`, so retain the fetcher's last
 * answer at the connection boundary and only make the token-less case retryable.
 */
export function classifyCloudSyncConnectionError(
  error: SyncTransportError,
  tokenAvailable: boolean | null,
): SyncTransportError {
  return error.reason === "unauthorized" && tokenAvailable === false
    ? new SyncTransportError({
        reason: "transport",
        message: "Cloud sync authentication is not ready yet.",
      })
    : error;
}

/**
 * Discards every replica database and scoped storage key the account owns, in the store and on
 * disk. Unsent outbox work is discarded with them: a sign-out reset is a fresh install, and the
 * user asked for it by signing out.
 *
 * Only the sync runtime may run this — inside a leadership pass, when it is the one writer with
 * no other connection open — which is why sign-out marks a reset (`syncReset.ts`) instead of
 * deleting anything itself: a `deleteDatabase` that landed after a quick re-sign-in could destroy
 * a freshly bootstrapped replica.
 */
export const discardCloudSyncLocalReplica = Effect.fn("web.cloudSync.discardLocalReplica")(
  function* (scope: string, storage?: SyncResetStorage | null) {
    const store = yield* SyncStore;
    const companyIds = yield* store.listCompanyIds;
    yield* Effect.forEach(companyIds, (companyId) => store.clear(companyId), { discard: true });
    const removedKeys = yield* Effect.sync(() => clearCloudSyncNamespaceKeys(scope, storage));
    yield* Effect.logWarning(
      "Cloud sync local replica discarded for a fresh start after sign-out.",
      { scope, companyCount: companyIds.length, removedStorageKeys: removedKeys },
    );
  },
);

/**
 * The leadership pass opens with this: when sign-out marked the scope for a reset, discard the
 * local replica first so every engine bootstraps from Convex as if this browser had never seen
 * the account. The marker clears only after the discard succeeds, so a failed or interrupted wipe
 * is retried by the next pass instead of being silently skipped.
 */
export const discardCloudSyncLocalReplicaIfResetPending = Effect.fn(
  "web.cloudSync.discardLocalReplicaIfResetPending",
)(function* (scope: string, storage?: SyncResetStorage | null) {
  if (!readCloudSyncReset(scope, storage)) return;
  yield* discardCloudSyncLocalReplica(scope, storage).pipe(
    // The connection may only fail with transport trouble — a store failure during the wipe is
    // exactly that for the engine's backoff, and leaving the marker set retries the wipe later.
    Effect.catch((error: SyncTransportError | SyncStoreError) =>
      error._tag === "SyncStoreError"
        ? Effect.fail(
            new SyncTransportError({
              reason: "transport",
              message: `Discarding the local replica for a sign-out reset failed: ${error.message}`,
            }),
          )
        : Effect.fail(error),
    ),
  );
  clearCloudSyncReset(scope, storage);
});

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
  // #region DEBUG
  yield* Effect.sync(() => debugCloudSync("H1", "runtime-started"));
  // #endregion DEBUG
  const store = yield* makeIndexedDbSyncStore({
    scope: options.scope,
    ...(options.indexedDb === undefined ? {} : { factory: options.indexedDb }),
  });
  yield* Effect.addFinalizer(() => store.close);
  const election = yield* makeWebLeaderElection({ scope: options.scope });
  // #region DEBUG
  yield* Effect.sync(() =>
    debugCloudSync("H1", "runtime-prerequisites-ready", {
      crossContext: election.crossContext,
    }),
  );
  // #endregion DEBUG
  yield* Effect.addFinalizer(
    () =>
      // #region DEBUG
      Effect.sync(() => debugCloudSync("H1", "runtime-finalized")).pipe(
        Effect.andThen(publishCloudSyncTabState(null)),
      ),
    // #endregion DEBUG
  );
  yield* election.changes.pipe(
    Stream.runForEach((isLeader) => {
      // #region DEBUG
      debugCloudSync("H1", "leadership-changed", {
        role: isLeader ? "leader" : "follower",
        crossContext: election.crossContext,
      });
      // #endregion DEBUG
      return publishCloudSyncTabState({
        role: isLeader ? "leader" : "follower",
        crossContext: election.crossContext,
      });
    }),
    Effect.forkScoped,
  );
  const clientId = options.clientId ?? readCloudSyncClientId({ scope: options.scope });

  const openConnection = Effect.gen(function* () {
    // #region DEBUG
    yield* Effect.sync(() => debugCloudSync("H2", "connection-started"));
    // #endregion DEBUG
    let tokenAvailable: boolean | null = null;
    const fetchToken: ConvexAuthTokenFetcher = async (args) => {
      const token = await options.fetchToken(args);
      tokenAvailable = Boolean(token);
      // #region DEBUG
      debugCloudSync("H2", "token-fetch-completed", {
        tokenAvailable,
        forceRefresh: args.forceRefreshToken,
      });
      // #endregion DEBUG
      return token;
    };
    const client =
      options.client ??
      (yield* Effect.acquireRelease(
        Effect.sync(() => new ConvexClient(options.convexUrl) as ConvexClientLike),
        (owned) => Effect.tryPromise(() => owned.close()).pipe(Effect.ignore),
      ));
    // #region DEBUG
    yield* Effect.sync(() => debugCloudSync("H2", "convex-client-ready"));
    // #endregion DEBUG
    const transport = yield* makeConvexSyncTransport({
      convexUrl: options.convexUrl,
      fetchToken,
      client,
    });
    // #region DEBUG
    yield* Effect.sync(() => debugCloudSync("H2", "transport-ready"));
    // #endregion DEBUG
    yield* repairCloudSyncCurrentUserWorkspace(client).pipe(
      Effect.mapError((error) => classifyCloudSyncConnectionError(error, tokenAvailable)),
    );
    // #region DEBUG
    yield* Effect.sync(() => debugCloudSync("H2", "workspace-repair-completed"));
    // #endregion DEBUG
    // #region DEBUG
    const tracedTransport = SyncTransport.of({
      ...transport,
      bootstrap: (input) =>
        transport.bootstrap(input).pipe(
          Effect.tap((page) =>
            Effect.sync(() =>
              debugCloudSync("H3", "bootstrap-page-completed", {
                entityCount: page.entities.length,
                isDone: page.isDone,
                ...debugBootstrapCursorFields(page.cursor),
              }),
            ),
          ),
          Effect.tapError((error) =>
            Effect.sync(() =>
              debugCloudSync("H3", "bootstrap-page-failed", {
                ...debugCloudSyncErrorFields(error),
                unrecognizedCursor: /unrecognized bootstrap cursor/i.test(error.message),
              }),
            ),
          ),
        ),
    });
    // #endregion DEBUG
    return {
      transport: tracedTransport,
      companies: cloudSyncCompaniesStream(client),
    } satisfies CloudSyncConnection;
  });

  // Every leadership pass opens with the pending sign-out reset, so a marked scope reconnects
  // onto an empty replica and bootstraps from Convex instead of resuming.
  const connect = Effect.flatMap(
    discardCloudSyncLocalReplicaIfResetPending(options.scope).pipe(
      Effect.provideService(SyncStore, store.service),
    ),
    () => openConnection,
  );

  const engines = runCloudSyncEngines({
    clientId,
    election,
    connect,
    publishCompanyRegistryReplica,
    publishCompanyRegistryMembershipId,
    publishCompanySyncEngineHandle,
    publishCompanySyncStatus,
    ...(options.restartDelay === undefined ? {} : { restartDelay: options.restartDelay }),
  }).pipe(Effect.provideService(SyncStore, store.service));

  const reconnecting = Effect.retry(
    engines.pipe(
      Effect.tapError(
        (error) =>
          // #region DEBUG
          Effect.sync(() =>
            debugCloudSync("H2", "company-subscription-stopped", debugCloudSyncErrorFields(error)),
          ).pipe(
            Effect.andThen(
              Effect.logWarning("Cloud sync company subscription stopped.", { error }),
            ),
          ),
        // #endregion DEBUG
      ),
    ),
    {
      while: (error) => error._tag === "SyncTransportError" && isRetryableTransportError(error),
      schedule: Schedule.spaced(options.retryDelay ?? COMPANIES_RETRY_DELAY),
    },
  );

  yield* reconnecting.pipe(
    Effect.catch(
      (error) =>
        // #region DEBUG
        Effect.sync(() =>
          debugCloudSync("H2", "runtime-stopped", debugCloudSyncErrorFields(error)),
        ).pipe(Effect.andThen(Effect.logError("Cloud sync stopped.", { error }))),
      // #endregion DEBUG
    ),
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
 * on sign-out. With no session this subscribes to an inert atom: no Convex
 * client is constructed, no database is opened, and no lock is taken.
 */
export function useCloudSyncRuntime(enabled = true): void {
  const scope = useCloudSyncScope();
  const atom =
    enabled && scope !== null && hasCloudSyncPublicConfig()
      ? cloudSyncRuntimeAtom(scope)
      : CLOUD_SYNC_IDLE_ATOM;
  useEffect(() => {
    // #region DEBUG
    debugCloudSync("H1", "runtime-atom-mounted", {
      enabled,
      scopeAvailable: scope !== null,
      publicConfigAvailable: hasCloudSyncPublicConfig(),
      idle: atom === CLOUD_SYNC_IDLE_ATOM,
    });
    // #endregion DEBUG
    const unmount = mountCloudSyncRuntimeAtom(atom);
    return () => {
      // #region DEBUG
      debugCloudSync("H1", "runtime-atom-unmounted", {
        idle: atom === CLOUD_SYNC_IDLE_ATOM,
      });
      // #endregion DEBUG
      unmount();
    };
  }, [atom, enabled, scope]);
}

/**
 * Keeps the Effect atom alive and evaluates it from React's effect phase. `subscribe` is lazy by
 * default in Effect's registry: without `immediate`, it installs a listener but never reads the
 * atom, so the sync runtime remains permanently unstarted. Reading during render starts it too
 * early and lets its status publications update sibling components mid-render. Immediate
 * subscription here is the safe seam between those two failure modes.
 */
export function mountCloudSyncRuntimeAtom<A>(atom: Atom.Atom<A>): () => void {
  return appAtomRegistry.subscribe(atom, () => undefined, { immediate: true });
}

/**
 * Cloud discovery follows authentication, not onboarding metadata. The workspace catalog is
 * allowed to be empty while onboarding is in progress and is reactive when provisioning lands.
 */
export function shouldRunCloudSyncRuntime(isSignedIn: boolean | undefined): boolean {
  return isSignedIn === true;
}

/**
 * Installs the signed-in account's Pathway Connect environments into the ordinary connection
 * registry. Company selection must never change this catalog: environments belong to the app and
 * the Pathway Connect account, not to a company workspace.
 */
function useRelayEnvironmentConnections(): void {
  const relayDiscovery = useAppAtomValue(relayEnvironmentDiscovery.stateValueAtom);
  const localCatalog = useAppAtomValue(localEnvironmentCatalog.catalogValueAtom);
  const primaryEnvironmentId = useAppAtomValue(primaryEnvironmentIdAtom);
  const installedEnvironmentIds = useRef(new Set<EnvironmentId>());

  useEffect(() => {
    void runAtomCommand(appAtomRegistry, relayEnvironmentDiscovery.refresh, undefined, {
      label: "Pathway Connect environment discovery",
      reportFailure: true,
      reportDefect: true,
    });
  }, []);

  useEffect(() => {
    const discovered = new Map(
      [...relayDiscovery.environments.values()]
        .map(({ environment }) => [environment.environmentId, environment.label] as const)
        .filter(([environmentId]) => environmentId !== primaryEnvironmentId),
    );

    for (const environmentId of installedEnvironmentIds.current) {
      if (discovered.has(environmentId)) continue;
      installedEnvironmentIds.current.delete(environmentId);
      void runAtomCommand(appAtomRegistry, environmentCatalog.remove, environmentId, {
        label: "company environment disconnect",
        reportFailure: true,
        reportDefect: true,
      });
    }

    for (const [environmentId, label] of discovered) {
      if (
        localCatalog.entries.has(environmentId) ||
        installedEnvironmentIds.current.has(environmentId)
      )
        continue;
      installedEnvironmentIds.current.add(environmentId);
      void runAtomCommand(
        appAtomRegistry,
        environmentCatalog.register,
        new RelayConnectionRegistration({
          target: new RelayConnectionTarget({ environmentId, label }),
        }),
        {
          label: "Pathway Connect environment connect",
          reportFailure: true,
          reportDefect: true,
        },
      ).then((result) => {
        if (result._tag === "Failure") installedEnvironmentIds.current.delete(environmentId);
      });
    }
  }, [localCatalog.entries, primaryEnvironmentId, relayDiscovery.environments]);
}

/**
 * Publishes this environment's registration to every company the account is a member of.
 *
 * A registration is keyed by (company, environment), and company-scoped writes refuse an
 * environment the company never registered — `cloudProjects.ensureEnvironmentProject` is the one
 * people meet first, when a local checkout cannot be adopted. Company selection is a view
 * preference and says nothing about which company a checkout belongs to, so registering only the
 * selected one leaves every other company permanently unable to see this machine.
 */
function useAutomaticEnvironmentRegistration(): void {
  const control = useEnvironmentControl();
  const replicas = useAppAtomValue(companyRegistryReplicasAtom);
  const environmentId = useAppAtomValue(primaryEnvironmentIdAtom);
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const relayLinked = primaryCloudLinkState.data?.linked ?? null;
  const managedTunnelActive = primaryCloudLinkState.data?.managedTunnelActive ?? null;
  const inFlight = useRef(new Map<string, Promise<boolean>>());
  const retryAttempts = useRef(new Map<string, number>());
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (control === null || environmentId === null) return;
    let cancelled = false;
    const retryTimers: Array<ReturnType<typeof setTimeout>> = [];

    for (const [companyId, replica] of replicas) {
      const registrationKey = `${companyId} ${environmentId}`;
      let registration = inFlight.current.get(registrationKey);
      if (registration === undefined) {
        registration = registerEnvironmentAutomatically({
          companyId,
          environmentId,
          replica,
          control,
          readRegistrationInfo: readPrimaryEnvironmentRegistrationInfo,
        });
        inFlight.current.set(registrationKey, registration);
        const clearInFlight = () => {
          if (inFlight.current.get(registrationKey) === registration) {
            inFlight.current.delete(registrationKey);
          }
        };
        void registration.then(clearInFlight, clearInFlight);
      }
      void registration
        .catch((error: unknown) => {
          console.warn("Could not automatically register this Pathway environment.", error);
          if (cancelled) return;
          const attempt = retryAttempts.current.get(registrationKey) ?? 0;
          retryAttempts.current.set(registrationKey, attempt + 1);
          const delay = automaticCloudRetryDelayMs(attempt);
          retryTimers.push(setTimeout(() => setRetryNonce((nonce) => nonce + 1), delay));
        })
        .then((didRegister) => {
          if (didRegister) retryAttempts.current.delete(registrationKey);
        });
    }

    return () => {
      cancelled = true;
      for (const timer of retryTimers) clearTimeout(timer);
    };
  }, [control, environmentId, managedTunnelActive, relayLinked, replicas, retryNonce]);
}

export function discoverCompanyEnvironmentConnections(
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  primaryEnvironmentId: EnvironmentId | null = null,
): ReadonlyMap<EnvironmentId, string> {
  const discovered = new Map<EnvironmentId, string>();
  for (const replica of replicas.values()) {
    for (const value of replica.view.values()) {
      if (
        isEnvironmentRegistration(value) &&
        value.environmentId !== primaryEnvironmentId &&
        value.state === "active" &&
        value.relayLinkState === "linked" &&
        value.managedEndpointAvailable
      ) {
        discovered.set(value.environmentId, value.descriptor.label);
      }
    }
  }
  return discovered;
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
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });

  useEffect(() => {
    // #region DEBUG
    debugCloudSync("H1", "runtime-component-auth-state", {
      isSignedIn: isSignedIn ?? null,
    });
    // #endregion DEBUG
  }, [isSignedIn]);

  useEffect(() => {
    activateCloudSyncConvexTokenFetcher(makeClerkConvexTokenFetcher(getToken));
    return () => {
      deactivateCloudSyncConvexTokenFetcher();
    };
  }, [getToken]);

  // Start discovery as soon as Clerk has a signed-in identity. Before onboarding creates a
  // workspace, `companies.listMine` legitimately yields an empty list and then reacts to the
  // provisioning mutation. Waiting for Clerk's onboarding metadata here creates a second,
  // eventually-consistent gate: the route can already know the workspace exists while this
  // runtime remains stopped on a stale metadata snapshot, leaving every company-backed screen in
  // an indefinite "preparing" state. The repair mutation cannot create a workspace, so starting
  // early is safe and lets provisioning flow straight into the first replica bootstrap.
  useCloudSyncRuntime(shouldRunCloudSyncRuntime(isSignedIn));
  useAlwaysOnCloudLink();
  useAutomaticEnvironmentRegistration();
  useRelayEnvironmentConnections();

  return null;
}
