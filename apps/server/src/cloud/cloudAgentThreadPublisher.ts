/** Publishes cloud-safe Agent Thread shells to Convex for cross-client discovery. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CloudAgentThreadShell,
  type EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type ThreadId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexError } from "convex/values";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schedule from "effect/Schedule";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import {
  makePublisherReconcileGate,
  PUBLISHER_RECONCILE_REPAIR_INTERVAL,
} from "./publisherReconcileGate.ts";
import { type ConvexServiceTokenProvider, convexErrorCode } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  type ConvexClientLike,
  classifyConvexFailure,
  convexHttpClientLike,
} from "./convexSyncTransport.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
  superviseCloudSyncCompanies,
} from "./syncDaemon.ts";

/** Publishes deferred (cosmetic) changes of threads that saw activity since the last tick. */
export const DEFAULT_AGENT_THREAD_RECONCILE_INTERVAL = Duration.seconds(15);

/**
 * How long a thread the backend reports as unbound (no active project binding on this environment)
 * stays parked. The park must remain thread-scoped: already-indexed sibling threads intentionally
 * stay updatable after their binding is revoked. Shell edits do not bypass the park, and the thread
 * is probed again once per interval so a newly assigned project appears within a few minutes.
 */
export const AGENT_THREAD_UNBOUND_PARK_INTERVAL = Duration.minutes(5);

const AGENT_THREAD_UNBOUND_MESSAGE =
  "The Agent Thread project has no active binding on this environment.";

/**
 * A backend that predates the `unbound` upsert outcome throws a typed `entity-not-found` refusal
 * instead; it means the same thing. Transport, auth, and validator failures stay retryable.
 */
export function isUnpublishableAgentThreadRefusal(cause: unknown): boolean {
  if (convexErrorCode(cause) !== "entity-not-found" || !(cause instanceof ConvexError))
    return false;
  const data: unknown = cause.data;
  return Predicate.isObject(data) && data["message"] === AGENT_THREAD_UNBOUND_MESSAGE;
}

interface CloudAgentThreadPublisherOptions {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
  /** How often threads touched by live events are re-read and published. */
  readonly reconcileInterval?: Duration.Input;
  /** How often a full inventory scan repairs anything live publication missed; tests shorten it. */
  readonly reconcileRepairInterval?: Duration.Input;
}

class CloudAgentThreadPublisherCallError extends Data.TaggedError(
  "CloudAgentThreadPublisherCallError",
)<{ readonly reason: ReturnType<typeof classifyConvexFailure>; readonly cause: unknown }> {}

export function cloudSafeThreadShell(shell: OrchestrationV2ThreadShell): CloudAgentThreadShell {
  return {
    ...shell,
    latestVisibleMessage:
      shell.latestVisibleMessage === null
        ? null
        : {
            id: shell.latestVisibleMessage.id,
            role: shell.latestVisibleMessage.role,
            updatedAt: shell.latestVisibleMessage.updatedAt,
          },
  };
}

const encodeCloudShell = Schema.encodeSync(CloudAgentThreadShell);
const encodeCloudShellIdentity = Schema.encodeSync(Schema.fromJsonString(CloudAgentThreadShell));

/**
 * Fields that move with nearly every transcript item. Cross-client discovery can show them a
 * dirty-thread tick late; publishing each one would write Convex and re-run every company replica
 * several times per turn.
 */
const COSMETIC_SHELL_FIELDS = [
  "updatedAt",
  "itemCount",
  "visibleItemCount",
  "latestVisibleMessage",
  "latestUserMessageAt",
  "lastVisitedAt",
] as const;

/** The shell identity without cosmetic fields: a change here publishes immediately. */
function urgentShellIdentity(encoded: ReturnType<typeof encodeCloudShell>): string {
  const urgent: Record<string, unknown> = { ...encoded };
  for (const field of COSMETIC_SHELL_FIELDS) delete urgent[field];
  return JSON.stringify(urgent);
}

export function shouldPublishCloudAgentThreadEvent(event: OrchestrationV2DomainEvent): boolean {
  return (
    event.type.startsWith("thread.") ||
    event.type === "run.created" ||
    event.type === "run.updated" ||
    event.type === "runtime-request.updated" ||
    event.type === "plan.updated" ||
    (event.type === "turn-item.updated" &&
      event.payload.type === "source_control" &&
      (event.payload.pullRequestAction !== undefined || event.payload.pullRequest != null)) ||
    (event.type === "message.updated" && !event.payload.streaming)
  );
}

export const makeCloudAgentThreadPublisher = Effect.fn("cloud.agent_thread_publisher.make")(
  function* (options: CloudAgentThreadPublisherOptions) {
    const client = options.client ?? convexHttpClientLike(options.convexUrl);
    const requestLock = yield* Semaphore.make(1);
    const publishLock = yield* Semaphore.make(1);
    const published = yield* Ref.make<
      ReadonlyMap<ThreadId, { readonly full: string; readonly urgent: string }>
    >(new Map());
    const parkedThreads = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());
    const announcedUnboundProjects = yield* Ref.make<ReadonlySet<ProjectId>>(new Set());

    const call = <A>(token: string, issue: (client: ConvexClientLike) => Promise<A>) =>
      requestLock.withPermits(1)(
        Effect.tryPromise({
          try: () => {
            client.setAuth(token);
            return issue(client);
          },
          catch: (cause) =>
            new CloudAgentThreadPublisherCallError({
              reason: classifyConvexFailure(cause),
              cause,
            }),
        }),
      );
    const authorized = <A>(issue: (client: ConvexClientLike) => Promise<A>) =>
      Effect.gen(function* () {
        const token = yield* options.tokens.token;
        return yield* call(token, issue).pipe(
          Effect.catchIf(
            (error) => error.reason === "unauthorized",
            () =>
              options.tokens.invalidate(token).pipe(
                Effect.andThen(options.tokens.token),
                Effect.flatMap((refreshed) => call(refreshed, issue)),
              ),
          ),
        );
      });

    const remove = (threadId: ThreadId) =>
      authorized((convex) =>
        convex.mutation(api.agentThreads.remove, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          threadId,
        }),
      ).pipe(
        Effect.tap(() =>
          Effect.all([
            Ref.update(published, (current) => {
              if (!current.has(threadId)) return current;
              const next = new Map(current);
              next.delete(threadId);
              return next;
            }),
            Ref.update(parkedThreads, (current) => {
              if (!current.has(threadId)) return current;
              const next = new Map(current);
              next.delete(threadId);
              return next;
            }),
          ]),
        ),
        Effect.asVoid,
      );

    /** A conversation outside this company is never published here. */
    const outOfScope = (shell: OrchestrationV2ThreadShell) =>
      shell.projectId === null && shell.conversationCompanyId !== options.companyId;

    /**
     * True when publishing this shell would change nothing, so an inventory scan can skip
     * re-reading it: already published as-is, out of scope, or parked until its next probe.
     */
    const isCurrent = (shell: OrchestrationV2ThreadShell) =>
      Effect.gen(function* () {
        if (outOfScope(shell)) return !(yield* Ref.get(published)).has(shell.id);
        const identity = encodeCloudShellIdentity(cloudSafeThreadShell(shell));
        if ((yield* Ref.get(published)).get(shell.id)?.full === identity) return true;
        const nextProbeAt = (yield* Ref.get(parkedThreads)).get(shell.id);
        return nextProbeAt !== undefined && (yield* Clock.currentTimeMillis) < nextProbeAt;
      });

    /** Parked threads whose unbound park has expired and should be probed again. */
    const dueProbes = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      return [...(yield* Ref.get(parkedThreads))]
        .filter(([, nextProbeAt]) => nextProbeAt <= now)
        .map(([threadId]) => threadId);
    });

    /**
     * `deferCosmetic` skips a publish whose only changes are cosmetic fields; the dirty-thread
     * tick publishes without it, so those changes land within one reconcile interval.
     */
    const publish = (
      shell: OrchestrationV2ThreadShell,
      publishOptions?: { readonly deferCosmetic?: boolean },
    ) =>
      publishLock.withPermits(1)(
        Effect.gen(function* () {
          if (outOfScope(shell)) {
            // A conversation moved to another company leaves this company's index at once.
            if ((yield* Ref.get(published)).has(shell.id)) yield* remove(shell.id);
            return;
          }
          const encoded = encodeCloudShell(cloudSafeThreadShell(shell));
          const identity = encodeCloudShellIdentity(cloudSafeThreadShell(shell));
          const urgent = urgentShellIdentity(encoded);
          const previous = (yield* Ref.get(published)).get(shell.id);
          if (previous?.full === identity) return;
          if (publishOptions?.deferCosmetic === true && previous?.urgent === urgent) return;
          const now = yield* Clock.currentTimeMillis;
          const nextProbeAt = (yield* Ref.get(parkedThreads)).get(shell.id);
          if (nextProbeAt !== undefined && now < nextProbeAt) return;
          const outcome = yield* authorized((convex) =>
            convex.mutation(api.agentThreads.upsert, {
              companyId: options.companyId,
              environmentId: options.environmentId,
              threadId: shell.id,
              localProjectId: shell.projectId,
              shell: encoded,
            }),
          ).pipe(
            // Old deployments returned null for successful upserts.
            Effect.map((result) => result?.outcome ?? ("published" as const)),
            Effect.catchIf(
              (error) => isUnpublishableAgentThreadRefusal(error.cause),
              () => Effect.succeed("unbound" as const),
            ),
          );
          if (outcome === "unbound") {
            const announced = yield* Ref.get(announcedUnboundProjects);
            const projectId = shell.projectId;
            if (projectId !== null && !announced.has(projectId)) {
              yield* Effect.logInfo(
                "Cloud Agent Thread project has no active binding on this environment; its threads stay local until it is assigned",
                {
                  companyId: options.companyId,
                  environmentId: options.environmentId,
                  projectId,
                },
              );
              yield* Ref.update(announcedUnboundProjects, (current) =>
                new Set(current).add(projectId),
              );
            }
            const until = now + Duration.toMillis(AGENT_THREAD_UNBOUND_PARK_INTERVAL);
            yield* Ref.update(parkedThreads, (current) => new Map(current).set(shell.id, until));
            return;
          }
          yield* Ref.update(parkedThreads, (current) => {
            if (!current.has(shell.id)) return current;
            const next = new Map(current);
            next.delete(shell.id);
            return next;
          });
          yield* Ref.update(published, (current) =>
            new Map(current).set(shell.id, { full: identity, urgent }),
          );
        }),
      );

    const reconcileIds = (threadIds: ReadonlyArray<ThreadId>) =>
      authorized((convex) =>
        convex.mutation(api.agentThreads.reconcile, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          currentThreadIds: [...threadIds],
        }),
      ).pipe(Effect.asVoid);

    return { publish, remove, reconcileIds, isCurrent, dueProbes } as const;
  },
);

export const runCloudAgentThreadPublisher = Effect.fn("cloud.agent_thread_publisher.run")(
  function* (options: CloudAgentThreadPublisherOptions) {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const publisher = yield* makeCloudAgentThreadPublisher(options);

    const reportFailure = (operation: string, threadId?: ThreadId) =>
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud Agent Thread metadata publication failed; it will be retried", {
          companyId: options.companyId,
          environmentId: options.environmentId,
          operation,
          ...(threadId === undefined ? {} : { threadId }),
          cause,
        }),
      );

    const mutationLock = yield* Semaphore.make(1);
    const reconcileGate = yield* makePublisherReconcileGate(options.reconcileRepairInterval);
    const repairInterval = options.reconcileRepairInterval ?? PUBLISHER_RECONCILE_REPAIR_INTERVAL;
    // Threads touched by any domain event since the last tick. Only these are re-read, so an idle
    // environment does no database work between inventory scans.
    const dirty = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
    const markDirty = (threadId: ThreadId) =>
      Ref.update(dirty, (current) =>
        current.has(threadId) ? current : new Set(current).add(threadId),
      );
    const publishThread = (
      threadId: ThreadId,
      publishOptions?: { readonly deferCosmetic?: boolean },
    ) =>
      mutationLock
        .withPermits(1)(
          threads
            .getThreadShell(threadId)
            .pipe(
              Effect.flatMap((shell) =>
                shell === null
                  ? publisher.remove(threadId)
                  : publisher.publish(shell, publishOptions),
              ),
            ),
        )
        .pipe(
          // A failed publish is retried on the next tick instead of waiting for a full scan.
          Effect.tapCause(() => markDirty(threadId)),
          reportFailure("publish", threadId),
        );

    const companyShells = (snapshot: {
      threads: ReadonlyArray<OrchestrationV2ThreadShell>;
      archivedThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
    }) =>
      [...snapshot.threads, ...snapshot.archivedThreads].filter(
        (shell) => shell.projectId !== null || shell.conversationCompanyId === options.companyId,
      );

    const publishDirty = Effect.gen(function* () {
      const touched = yield* Ref.getAndSet(dirty, new Set());
      const probes = yield* publisher.dueProbes;
      yield* Effect.forEach(new Set([...touched, ...probes]), (id) => publishThread(id), {
        concurrency: 4,
        discard: true,
      });
    });

    // The inventory scan is the repair backstop: one snapshot read, then a fresh read only for the
    // shells that differ from what this publisher last sent.
    const scanInventory = Effect.gen(function* () {
      const snapshot = yield* threads.getShellSnapshot();
      const shells = companyShells(snapshot);
      const stale = yield* Effect.filter(shells, (shell) =>
        publisher.isCurrent(shell).pipe(Effect.map((current) => !current)),
      );
      // Snapshot shells are scan work only. Each stale shell is re-read under the same mutation
      // lock as live events, so a delayed scan cannot overwrite edits or resurrect deleted threads.
      yield* Effect.forEach(stale, (shell) => publishThread(shell.id), {
        concurrency: 4,
        discard: true,
      });
      if (!(yield* reconcileGate.due(shells.map((shell) => shell.id)))) return;
      yield* mutationLock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* threads.getShellSnapshot();
          const ids = companyShells(current).map((shell) => shell.id);
          yield* reconcileGate.run(ids, publisher.reconcileIds(ids));
        }),
      );
    }).pipe(reportFailure("reconcile"));

    // Start the live tail before scanning existing threads. Reconciliation can involve hundreds
    // of cloud calls, and must not postpone subscribing to or processing newly created threads.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const live = yield* threads.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            markDirty(event.threadId).pipe(
              Effect.andThen(
                shouldPublishCloudAgentThreadEvent(event)
                  ? publishThread(event.threadId, { deferCosmetic: true })
                  : Effect.void,
              ),
            ),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* scanInventory.pipe(
          Effect.repeat(Schedule.spaced(repairInterval)),
          Effect.forkScoped,
        );
        yield* publishDirty.pipe(
          Effect.repeat(
            Schedule.spaced(options.reconcileInterval ?? DEFAULT_AGENT_THREAD_RECONCILE_INTERVAL),
          ),
          Effect.forkScoped,
        );
        yield* Fiber.join(live);
      }),
    );
  },
);

/** Keeps one publisher running for every company registered to this linked environment. */
export const cloudAgentThreadPublisherLayer = (): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | ThreadManagement.ThreadManagementService
  | HttpClient.HttpClient
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* resolveCloudSyncConfig;
      if (config._tag !== "Configured") return;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const environmentId = yield* environment.getEnvironmentId;
      yield* forkParkedFiber(
        Effect.gen(function* () {
          const link = yield* awaitCloudSyncLink({
            secrets,
            interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
            attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
          });
          if (link === null) return;
          const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets).pipe(
            Effect.orDie,
          );
          const tokens = yield* makeCloudSyncTokenProvider({
            environmentId,
            secrets,
            dpopKeys,
          });
          yield* superviseCloudSyncCompanies({
            discover: () =>
              discoverCloudSyncCompanyIds({
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            runCompany: (companyId) =>
              runCloudAgentThreadPublisher({
                companyId,
                environmentId,
                convexUrl: config.settings.convexUrl,
                tokens,
              }),
            workerLabel: "cloud-agent-thread-publisher",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Cloud Agent Thread publisher stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Cloud Agent Thread publisher failed to start", { cause }),
      ),
    ),
  );
