import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ThreadHistoryRequest,
  type OrchestrationV2ThreadHistory,
  type ThreadId as ThreadIdType,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribeDynamic } from "../rpc/client.ts";
import { ThreadSnapshotLoader } from "./threadSnapshotHttp.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import {
  applyThreadHistoryProjectionEvent,
  mergeThreadHistoryPage,
  shouldApplyThreadHistoryEvent,
  updateThreadHistoryIndex,
  type ThreadHistoryWatermarks,
} from "./threadHistory.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  STOPPED_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
  type EnvironmentThreadHistory,
  type ThreadHistoryDirection,
} from "./threadState.ts";

// Cloud and draft shells can lead the owning server's thread.create commit by
// a few seconds. Keep that first 404 retryable, but bound the ambiguity so a
// deleted or invalid id still reaches the deleted state. At the subscription's
// 250ms retry cadence this allows about ten seconds to materialize.
export const THREAD_NOT_FOUND_MAX_ATTEMPTS = 40;

// A deletion confirmed from a 404 stays provisional: shells can reference a
// thread whose create commit takes longer than the bounded retry window (slow
// clones, an environment that reconnects late). Keep probing at this cadence
// so the thread can still materialize instead of staying unreachable for the
// rest of the session.
export const THREAD_DELETED_REPROBE_INTERVAL = "5 seconds";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function shouldPersistThread(thread: OrchestrationV2ThreadProjection): boolean {
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

function snapshotHistory(history: OrchestrationV2ThreadHistory): OrchestrationV2ThreadHistory {
  return {
    hasOlder: history.hasOlder,
    hasNewer: history.hasNewer,
    index: history.index,
    ...(history.beforeCursor === undefined ? {} : { beforeCursor: history.beforeCursor }),
    ...(history.afterCursor === undefined ? {} : { afterCursor: history.afterCursor }),
  };
}

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const cache = yield* EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cached = yield* cache.loadThread(environmentId, threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not load cached thread.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          error: error.message,
        }),
        Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
      ),
    ),
  );
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const historyRequests = yield* Queue.unbounded<ThreadHistoryDirection>();
  let requestPending = false;
  let latestPending = false;
  let lastDirection: ThreadHistoryDirection = "latest";
  let active = true;
  let historyGeneration = 0;
  let historySupported = false;
  let watermarks: ThreadHistoryWatermarks = new Map();
  let importedThroughSequence = 0;
  let contentSequence = 0;
  let indexSequence = 0;
  let pageEvents: Array<Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>> | null = null;
  const requestHistory = (direction: ThreadHistoryDirection) => {
    if (!active || !historySupported) return;
    if (requestPending) {
      if (direction === "latest") {
        latestPending = true;
        historyGeneration += 1;
      }
      return;
    }
    requestPending = true;
    Queue.offerUnsafe(historyRequests, direction);
  };
  const retryHistory = () => requestHistory(lastDirection);
  const cachedHistory = Option.getOrUndefined(cached)?.history;
  let refreshCachedHistory = cachedHistory?.hasNewer === true;
  const state = yield* SubscriptionRef.make<EnvironmentThreadState>({
    data: cachedThread,
    status: statusWithoutLiveData(cachedThread),
    error: Option.none(),
    ...(cachedHistory === undefined
      ? {}
      : {
          history: {
            ...cachedHistory,
            isLoading: false,
            error: null,
            request: requestHistory,
            retry: retryHistory,
          },
        }),
  });
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const lastSequence = yield* SubscriptionRef.make(
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence }),
  );
  const awaitingCompletion = yield* Ref.make(false);
  const notFoundAttempts = yield* Ref.make(0);
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);
  const projectionMutex = yield* Semaphore.make(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    yield* cache.saveThread(environmentId, snapshot).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Stream.fromQueue(persistence).pipe(
    Stream.debounce("500 millis"),
    Stream.runForEach(persist),
    Effect.forkScoped,
  );

  const setSynchronizing = SubscriptionRef.update(state, (current) =>
    current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (cause: Cause.Cause<unknown>) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(formatThreadError(cause)),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    history?: EnvironmentThreadHistory | null,
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    yield* Ref.set(notFoundAttempts, 0);
    yield* SubscriptionRef.update(state, ({ history: previousHistory, ...current }) => ({
      ...current,
      data: Option.some(thread),
      ...(history === null
        ? {}
        : history === undefined
          ? previousHistory === undefined
            ? {}
            : { history: previousHistory }
          : { history }),
      status: waiting ? ("synchronizing" as const) : ("live" as const),
      error: Option.none(),
    }));
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path.
    if (shouldPersistThread(thread)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      const history = (yield* SubscriptionRef.get(state)).history;
      if (importedThroughSequence <= snapshotSequence && history?.hasNewer !== true) {
        yield* Queue.offer(persistence, {
          snapshotSequence,
          projection: thread,
          ...(history === undefined ? {} : { history: snapshotHistory(history) }),
        });
      }
    }
  });

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* () {
    historyGeneration += 1;
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
    });
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  const applyItemUnlocked = Effect.fn("EnvironmentThreadState.applyItem")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted"
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      historyGeneration += 1;
      watermarks = new Map();
      importedThroughSequence = 0;
      refreshCachedHistory = false;
      contentSequence = item.snapshotSequence;
      indexSequence = item.snapshotSequence;
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      yield* setThread(
        item.projection,
        item.history === undefined
          ? null
          : {
              ...item.history,
              isLoading: false,
              error: null,
              request: requestHistory,
              retry: retryHistory,
            },
      );
      return;
    }

    const sequence = yield* SubscriptionRef.get(lastSequence);
    if (item.sequence <= sequence) {
      return;
    }
    yield* SubscriptionRef.set(lastSequence, item.sequence);
    if (pageEvents !== null) {
      if (pageEvents.length < 256) pageEvents.push(item);
      else pageEvents = null;
    }
    if (item.sequence > importedThroughSequence && watermarks.size > 0) {
      watermarks = new Map();
      importedThroughSequence = 0;
    }

    const current = yield* SubscriptionRef.get(state);
    if (Option.isNone(current.data)) {
      if (item.event.type === "thread.deleted") {
        yield* setDeleted();
      }
      return;
    }
    if (item.event.type === "thread.deleted") {
      yield* setDeleted();
      return;
    }
    let nextHistory = current.history;
    if (nextHistory !== undefined && item.sequence > indexSequence) {
      const updated = updateThreadHistoryIndex(nextHistory, item.event, current.data.value);
      if (updated !== nextHistory) {
        nextHistory = { ...nextHistory, ...updated };
      }
    }
    if (
      nextHistory !== undefined &&
      !shouldApplyThreadHistoryEvent(
        current.data.value,
        nextHistory,
        item.event,
        item.sequence,
        contentSequence,
        watermarks,
      )
    ) {
      if (nextHistory !== current.history) {
        const history = nextHistory;
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          ...(history === undefined ? {} : { history }),
        }));
      }
      return;
    }
    const next =
      nextHistory === undefined
        ? applyOrchestrationV2ProjectionEvent(current.data.value, item.event)
        : applyThreadHistoryProjectionEvent(current.data.value, nextHistory, item.event);
    if (next !== null) {
      yield* setThread(next, nextHistory);
      if (
        historySupported &&
        ((item.event.type === "run.updated" &&
          (item.event.payload.status === "rolled_back" ||
            item.event.payload.status === "cancelled")) ||
          (item.event.type === "run-attempt.updated" && item.event.payload.status === "superseded"))
      )
        requestHistory("latest");
    }
  });

  const applyItem = (item: OrchestrationV2ThreadStreamItem) =>
    projectionMutex.withPermits(1)(applyItemUnlocked(item));

  const awaitPrepared = SubscriptionRef.get(supervisor.prepared).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          SubscriptionRef.changes(supervisor.prepared).pipe(
            Stream.filter(Option.isSome),
            Stream.map((value) => value.value),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
      }),
    ),
  );

  const loadHistory = Effect.fn("EnvironmentThreadState.loadHistory")(function* (
    direction: ThreadHistoryDirection,
  ) {
    lastDirection = direction;
    const started = yield* projectionMutex.withPermits(1)(
      Effect.gen(function* () {
        const initial = yield* SubscriptionRef.get(state);
        const history = initial.history;
        if (history === undefined || Option.isNone(initial.data)) return null;
        if (direction === "older" && (!history.hasOlder || history.beforeCursor === undefined))
          return null;
        if (direction === "newer" && (!history.hasNewer || history.afterCursor === undefined))
          return null;
        const request: OrchestrationV2ThreadHistoryRequest = {
          limit: 50,
          ...(direction === "older"
            ? { before: history.beforeCursor! }
            : direction === "newer"
              ? { after: history.afterCursor! }
              : typeof direction === "object"
                ? { around: direction.aroundMessageId }
                : {}),
        };
        const generation = historyGeneration;
        pageEvents = [];
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          history: { ...history, isLoading: true, error: null },
        }));
        return { request, generation };
      }),
    );
    if (started === null) return;
    const { request, generation } = started;
    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
    let result = Option.isSome(prepared)
      ? yield* snapshotLoader.load(prepared.value, threadId, request)
      : { _tag: "Unavailable" as const };
    if (result._tag === "Unavailable") {
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isSome(session)) {
        result = yield* session.value.client[ORCHESTRATION_V2_WS_METHODS.subscribeThread]({
          threadId,
          history: request,
        }).pipe(
          Stream.filter((item) => item.kind === "snapshot"),
          Stream.runHead,
          Effect.timeout("6 seconds"),
          Effect.map((item) =>
            Option.isSome(item)
              ? { _tag: "Snapshot" as const, snapshot: item.value }
              : { _tag: "Unavailable" as const },
          ),
          Effect.orElseSucceed(() => ({ _tag: "Unavailable" as const })),
        );
      }
    }
    yield* projectionMutex.withPermits(1)(
      Effect.gen(function* () {
        if (generation !== historyGeneration) return;
        const current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data) || current.history === undefined) return;
        if (
          result._tag !== "Snapshot" ||
          result.snapshot.history === undefined ||
          pageEvents === null
        ) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            history: {
              ...current.history!,
              isLoading: false,
              error: "Could not load messages from remote. Try again.",
            },
          }));
          return;
        }
        const merged = mergeThreadHistoryPage(
          current.data.value,
          current.history,
          { ...result.snapshot, history: result.snapshot.history },
          direction,
          watermarks,
        );
        watermarks = merged.watermarks;
        importedThroughSequence = Math.max(
          importedThroughSequence,
          result.snapshot.snapshotSequence,
        );
        if (merged.replacing) contentSequence = result.snapshot.snapshotSequence;
        indexSequence = result.snapshot.snapshotSequence;
        let projection = merged.projection;
        let mergedHistory = merged.history;
        for (const item of pageEvents ?? []) {
          if (item.sequence <= result.snapshot.snapshotSequence) continue;
          mergedHistory = updateThreadHistoryIndex(mergedHistory, item.event, projection);
          if (
            shouldApplyThreadHistoryEvent(
              projection,
              mergedHistory,
              item.event,
              item.sequence,
              contentSequence,
              watermarks,
            )
          ) {
            projection = applyThreadHistoryProjectionEvent(projection, mergedHistory, item.event);
          }
        }
        yield* SubscriptionRef.update(state, (value) => ({
          ...value,
          data: Option.some(projection),
          history: {
            ...mergedHistory,
            isLoading: false,
            error: null,
            request: requestHistory,
            retry: retryHistory,
          },
        }));
      }),
    );
  });

  yield* Stream.fromQueue(historyRequests).pipe(
    Stream.runForEach((direction) =>
      loadHistory(direction).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            pageEvents = null;
            if (latestPending && active) {
              latestPending = false;
              Queue.offerUnsafe(historyRequests, "latest");
            } else requestPending = false;
          }),
        ),
      ),
    ),
    Effect.forkScoped,
  );

  // Runs while the thread is in the deleted state with no data. Holds the
  // socket subscription back while HTTP confirms the thread is missing.
  // An unavailable HTTP path (including expired credentials) must release
  // the socket fallback; a healthy socket can outlive its HTTP credential.
  const recoverDeletedThread = Effect.fn("EnvironmentThreadState.recoverDeletedThread")(function* (
    supportsCompletionMarker: boolean,
  ) {
    while (true) {
      yield* Effect.sleep(THREAD_DELETED_REPROBE_INTERVAL);
      const prepared = yield* awaitPrepared;
      const httpSnapshot = yield* snapshotLoader.load(
        prepared,
        threadId,
        historySupported ? { limit: 50 } : undefined,
      );
      if (httpSnapshot._tag === "Snapshot") {
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* applyItem({
          kind: "snapshot",
          snapshotSequence: httpSnapshot.snapshot.snapshotSequence,
          projection: httpSnapshot.snapshot.projection,
          ...(httpSnapshot.snapshot.history === undefined
            ? {}
            : { history: httpSnapshot.snapshot.history }),
        });
        return yield* SubscriptionRef.get(state);
      }
      if (httpSnapshot._tag === "Unavailable") {
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* Ref.set(notFoundAttempts, 1);
        yield* SubscriptionRef.update(state, (current) => ({
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        }));
        return yield* SubscriptionRef.get(state);
      }
    }
  });

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  yield* Effect.forkScoped(
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        const capabilities = yield* session.initialConfig.pipe(
          Effect.map((config) => ({
            completion: config.threadResumeCompletionMarker === true,
            history: config.orchestrationV2ThreadHistory === true,
          })),
          Effect.orElseSucceed(() => ({ completion: false, history: false })),
        );
        const supportsCompletionMarker = capabilities.completion;
        historySupported = capabilities.history;
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        let current = yield* SubscriptionRef.get(state);
        if (Option.isNone(current.data) && current.status === "deleted") {
          current = yield* recoverDeletedThread(supportsCompletionMarker);
        } else if (
          Option.isNone(current.data) ||
          historySupported !== (current.history !== undefined) ||
          refreshCachedHistory
        ) {
          const missingAttempts = yield* Ref.get(notFoundAttempts);
          const shouldConfirmDeletion = missingAttempts >= THREAD_NOT_FOUND_MAX_ATTEMPTS;
          const prepared = yield* awaitPrepared;
          if (missingAttempts === 0 || shouldConfirmDeletion) {
            const httpSnapshot = yield* snapshotLoader.load(
              prepared,
              threadId,
              historySupported ? { limit: 50 } : undefined,
            );
            if (httpSnapshot._tag === "NotFound") {
              if (shouldConfirmDeletion) {
                yield* setDeleted();
                current = yield* recoverDeletedThread(supportsCompletionMarker);
              } else {
                yield* Ref.set(notFoundAttempts, 1);
              }
            } else if (httpSnapshot._tag === "Snapshot") {
              yield* applyItem({
                kind: "snapshot",
                snapshotSequence: httpSnapshot.snapshot.snapshotSequence,
                projection: httpSnapshot.snapshot.projection,
                ...(httpSnapshot.snapshot.history === undefined
                  ? {}
                  : { history: httpSnapshot.snapshot.history }),
              });
              current = yield* SubscriptionRef.get(state);
            } else {
              // A transport or auth failure cannot confirm deletion. Start a
              // fresh retry window and let the socket path keep recovering.
              yield* Ref.set(notFoundAttempts, 1);
            }
          } else {
            yield* Ref.update(notFoundAttempts, (attempts) => attempts + 1);
          }
        }

        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume =
          Option.isSome(current.data) &&
          historySupported === (current.history !== undefined) &&
          !refreshCachedHistory;
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(historySupported ? { history: { limit: 50 } } : {}),
        };
      }),
      {
        onExpectedFailure: setStreamError,
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(Stream.runForEach(applyItem)),
  );

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      active = false;
    }).pipe(
      Effect.andThen(Effect.all([SubscriptionRef.get(state), SubscriptionRef.get(lastSequence)])),
      Effect.flatMap(([current, snapshotSequence]) =>
        Option.match(current.data, {
          onNone: () => Effect.void,
          onSome: (projection) =>
            shouldPersistThread(projection) &&
            importedThroughSequence <= snapshotSequence &&
            current.history?.hasNewer !== true
              ? persist({
                  snapshotSequence,
                  projection,
                  ...(current.history === undefined
                    ? {}
                    : { history: snapshotHistory(current.history) }),
                })
              : Effect.void,
        }),
      ),
    ),
  );

  return state;
});

export function threadStateChanges(environmentId: EnvironmentIdType, threadId: ThreadIdType) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(makeEnvironmentThreadState(threadId).pipe(Effect.map(SubscriptionRef.changes))),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader | R,
    E
  >,
) {
  const sourceFamily = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    return runtime
      .atom(threadStateChanges(environmentId, threadId), {
        initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
      })
      .pipe(Atom.withLabel(`environment-thread-state-source:${key}`));
  });

  const loadEnabledFamily = Atom.family((key: string) =>
    Atom.make(true).pipe(Atom.withLabel(`environment-thread-load-enabled:${key}`)),
  );

  const family = Atom.family((key: string) =>
    Atom.make((get) =>
      get(loadEnabledFamily(key))
        ? get(sourceFamily(key))
        : AsyncResult.success(STOPPED_ENVIRONMENT_THREAD_STATE),
    ).pipe(
      Atom.setIdleTTL(THREAD_STATE_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-state:${key}`),
    ),
  );

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
    loadEnabledAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      loadEnabledFamily(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadDetail.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";
