import {
  EnvironmentId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2ThreadHistory,
  type OrchestrationV2ThreadHistoryRequest,
  type OrchestrationV2TurnItem,
  EventId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  THREAD_DELETED_REPROBE_INTERVAL,
  THREAD_NOT_FOUND_MAX_ATTEMPTS,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

type TestThreadInput = OrchestrationV2ThreadStreamItem | Error;

function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean; readonly historySupport?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({
      threadResumeCompletionMarker: config?.completionMarker === true,
      orchestrationV2ThreadHistory: config?.historySupport === true,
    } as never),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly httpSnapshot?: Option.Option<OrchestrationV2ThreadDetailSnapshot>;
  readonly httpNotFound?: boolean;
  readonly completionMarker?: boolean;
  readonly historySupport?: boolean;
  readonly cachedHistory?: OrchestrationV2ThreadHistory;
  readonly controlledPages?: boolean;
}) {
  const pageLoads = yield* Queue.unbounded<{
    request: OrchestrationV2ThreadHistoryRequest;
    reply: Deferred.Deferred<ThreadSnapshotLoadResult>;
  }>();
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const subscriptionStarts = yield* Queue.unbounded<number>();
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastSubscribeHistory = yield* Ref.make<OrchestrationV2ThreadHistoryRequest | undefined>(
    undefined,
  );
  const lastRequestCompletionMarker = yield* Ref.make(false);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input instanceof Error ? Effect.fail(input) : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: true;
      readonly history?: OrchestrationV2ThreadHistoryRequest;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.tap((count) => Queue.offer(subscriptionStarts, count)),
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(Ref.set(lastSubscribeHistory, input.history)),
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some(testSession(client, options)),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const httpNotFound = yield* Ref.make(options?.httpNotFound === true);
  const httpSnapshot = yield* Ref.make(
    options?.httpSnapshot ?? Option.none<OrchestrationV2ThreadDetailSnapshot>(),
  );
  const snapshotLoader = ThreadSnapshotLoader.of({
    load: (_prepared, threadId, request) =>
      options?.controlledPages && request !== undefined
        ? Effect.gen(function* () {
            const reply = yield* Deferred.make<ThreadSnapshotLoadResult>();
            yield* Queue.offer(pageLoads, { request, reply });
            return yield* Deferred.await(reply);
          })
        : Ref.update(loaderCalls, (count) => count + 1).pipe(
            Effect.andThen(
              Effect.all({ notFound: Ref.get(httpNotFound), snapshot: Ref.get(httpSnapshot) }),
            ),
            Effect.map(({ notFound, snapshot }) =>
              notFound
                ? ({ _tag: "NotFound" } as const)
                : threadId === THREAD_ID && Option.isSome(snapshot)
                  ? ({ _tag: "Snapshot", snapshot: snapshot.value } as const)
                  : ({ _tag: "Unavailable" } as const),
            ),
          ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeed(Option.none()),
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: options.cached,
              ...(options.cachedHistory === undefined ? {} : { history: options.cachedHistory }),
            })
          : Option.none(),
      ),
    saveThread: (_environmentId, snapshot) =>
      Ref.update(savedThreads, (current) => [...current, snapshot]),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeed(Option.none()),
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeed(Option.none()),
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const threadState = yield* makeEnvironmentThreadState(THREAD_ID).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    pageLoads,
    lastSubscribeHistory,
    prepared,
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    subscriptionStarts,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    httpNotFound,
    httpSnapshot,
    clearSession: SubscriptionRef.set(supervisorSession, Option.none()),
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options)),
    ),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): OrchestrationV2ThreadStreamItem => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};

describe("EnvironmentThreads", () => {
  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.projection.thread.title).toBe(
        "Live title",
      );
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: Option.some({ snapshotSequence: 1, projection: httpProjection }),
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
    }),
  );

  it.effect("recovers when HTTP and the first stream attempt precede thread creation", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ httpNotFound: true });

      expect(yield* Queue.take(harness.subscriptionStarts)).toBe(1);
      yield* Queue.offer(harness.inputs, new Error("thread has not materialized"));
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("250 millis");
      expect(yield* Queue.take(harness.subscriptionStarts)).toBe(2);
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
        }),
      );
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Materialized thread",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Materialized thread");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
    }),
  );

  it.effect("marks a permanently missing thread deleted after bounded resubscriptions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ httpNotFound: true });

      expect(yield* Queue.take(harness.subscriptionStarts)).toBe(1);
      for (let attempt = 2; attempt <= THREAD_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
        yield* harness.clearSession;
        yield* Effect.yieldNow;
        yield* harness.replaceSession;
        expect(yield* Queue.take(harness.subscriptionStarts)).toBe(attempt);
      }
      yield* harness.clearSession;
      yield* Effect.yieldNow;
      yield* harness.replaceSession;
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(THREAD_NOT_FOUND_MAX_ATTEMPTS);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("recovers a wrongly-deleted thread once the owning server materializes it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ httpNotFound: true });

      expect(yield* Queue.take(harness.subscriptionStarts)).toBe(1);
      for (let attempt = 2; attempt <= THREAD_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
        yield* harness.clearSession;
        yield* Effect.yieldNow;
        yield* harness.replaceSession;
        expect(yield* Queue.take(harness.subscriptionStarts)).toBe(attempt);
      }
      yield* harness.clearSession;
      yield* Effect.yieldNow;
      yield* harness.replaceSession;
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      // A cloud shell kept referencing the thread; the owning server finally
      // commits it. The next slow probe must resurrect the state instead of
      // leaving it deleted for the rest of the session.
      yield* Ref.set(harness.httpNotFound, false);
      yield* Ref.set(
        harness.httpSnapshot,
        Option.some({
          snapshotSequence: 1,
          projection: {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
          },
        }),
      );
      yield* TestClock.adjust(THREAD_DELETED_REPROBE_INTERVAL);

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Materialized thread");
      // The socket subscription resumes from the recovered snapshot.
      expect(yield* Queue.take(harness.subscriptionStarts)).toBe(THREAD_NOT_FOUND_MAX_ATTEMPTS + 1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
    }),
  );

  it.effect(
    "recovers over the socket when HTTP becomes unavailable after confirming a missing thread",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ httpNotFound: true, completionMarker: true });
        expect(yield* Queue.take(harness.subscriptionStarts)).toBe(1);
        for (let attempt = 2; attempt <= THREAD_NOT_FOUND_MAX_ATTEMPTS; attempt += 1) {
          yield* harness.clearSession;
          yield* Effect.yieldNow;
          yield* harness.replaceSession;
          expect(yield* Queue.take(harness.subscriptionStarts)).toBe(attempt);
        }
        yield* harness.clearSession;
        yield* Effect.yieldNow;
        yield* harness.replaceSession;
        yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

        // The HTTP loader maps expired credentials / transport failures to
        // Unavailable. The existing authenticated socket is still usable.
        yield* Ref.set(harness.httpNotFound, false);
        yield* TestClock.adjust(THREAD_DELETED_REPROBE_INTERVAL);
        expect(yield* Queue.take(harness.subscriptionStarts)).toBe(
          THREAD_NOT_FOUND_MAX_ATTEMPTS + 1,
        );
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
        const loaderCalls = yield* Ref.get(harness.loaderCalls);
        for (let retry = 1; retry <= 4; retry += 1) {
          yield* Queue.offer(harness.inputs, new Error("thread still missing"));
          yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
          yield* Effect.yieldNow;
          yield* TestClock.adjust("250 millis");
          expect(yield* Queue.take(harness.subscriptionStarts)).toBe(
            THREAD_NOT_FOUND_MAX_ATTEMPTS + 1 + retry,
          );
          expect(yield* Ref.get(harness.loaderCalls)).toBe(loaderCalls);
        }
        yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
        const recovering = yield* awaitThreadState(harness.observed, (value) =>
          Option.isSome(value.data),
        );
        expect(recovering.status).toBe("synchronizing");
        yield* Queue.offer(harness.inputs, { kind: "synchronized" });
        const state = yield* awaitThreadState(
          harness.observed,
          (value) => value.status === "live" && Option.isSome(value.data),
        );
        expect(Option.getOrThrow(state.data).thread.id).toBe(THREAD_ID);
        expect(yield* Ref.get(harness.retryCount)).toBe(0);
      }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
    }),
  );

  it.effect("removes cached data when the thread is deleted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, deleted(CACHED_SNAPSHOT_SEQUENCE + 1));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Caught-up title");
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Latest title");

      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 10; attempt += 1) {
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);
    }),
  );
});

function historyItem(ordinal: number, text = `Message ${ordinal}`): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item-${ordinal}`),
    threadId: THREAD_ID,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: v2Projection.updatedAt,
    type: "user_message",
    messageId: MessageId.make(`message-${ordinal}`),
    inputIntent: "turn_start",
    text,
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  };
}

function historyProjection(ordinals: ReadonlyArray<number>): OrchestrationV2ThreadProjection {
  const turnItems = ordinals.map((ordinal) => historyItem(ordinal));
  return {
    ...BASE_PROJECTION,
    turnItems,
    visibleTurnItems: turnItems.map((item) => ({
      position: item.ordinal,
      visibility: "local",
      sourceThreadId: THREAD_ID,
      sourceItemId: item.id,
      item,
    })),
  };
}

function historyMetadata(
  first: number,
  last: number,
  hasOlder = true,
  hasNewer = false,
): OrchestrationV2ThreadHistory {
  return {
    hasOlder,
    hasNewer,
    beforeCursor: TurnItemId.make(`item-${first}`),
    afterCursor: TurnItemId.make(`item-${last}`),
    index: [1, 2, 3, 4, 5].map((ordinal) => ({
      messageId: MessageId.make(`message-${ordinal}`),
      role: "user",
      preview: `Message ${ordinal}`,
    })),
  };
}

function itemUpdated(
  ordinal: number,
  text: string,
  sequence: number,
): OrchestrationV2ThreadStreamItem {
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-item-${sequence}`),
      type: "turn-item.updated",
      threadId: THREAD_ID,
      occurredAt: v2Projection.updatedAt,
      payload: historyItem(ordinal, text),
    },
  };
}

const historyHarness = () =>
  makeHarness({
    cached: historyProjection([4, 5]),
    cachedHistory: historyMetadata(4, 5),
    historySupport: true,
    controlledPages: true,
  });
const itemTexts = (state: EnvironmentThreadState) =>
  Option.getOrThrow(state.data).turnItems.map((item) => ("text" in item ? item.text : ""));

const replyPage = (
  reply: Deferred.Deferred<ThreadSnapshotLoadResult>,
  ordinals: ReadonlyArray<number>,
  sequence: number,
  hasOlder = true,
  hasNewer = false,
) =>
  Deferred.succeed(reply, {
    _tag: "Snapshot",
    snapshot: {
      snapshotSequence: sequence,
      projection: historyProjection(ordinals),
      history: historyMetadata(ordinals[0]!, ordinals.at(-1)!, hasOlder, hasNewer),
    },
  });

describe("paginated environment thread history", () => {
  it.effect(
    "loads older once, preserves live rows, and keeps the stream cursor behind future page rows",
    () =>
      Effect.gen(function* () {
        const harness = yield* historyHarness();
        yield* Queue.take(harness.subscriptionStarts);
        const initial = yield* Ref.get(harness.latest);
        initial.history!.request("older");
        initial.history!.request("older");
        const page = yield* Queue.take(harness.pageLoads);
        expect(page.request).toEqual({ limit: 50, before: TurnItemId.make("item-4") });
        yield* Queue.offer(harness.inputs, itemUpdated(5, "Live update", 8));
        yield* awaitThreadState(harness.observed, (state) =>
          itemTexts(state).includes("Live update"),
        );
        yield* replyPage(page.reply, [2, 3, 4], 10);
        const loaded = yield* awaitThreadState(
          harness.observed,
          (state) => !state.history?.isLoading && itemTexts(state).includes("Message 2"),
        );
        expect(itemTexts(loaded)).toEqual(["Message 2", "Message 3", "Message 4", "Live update"]);
        expect(
          Option.getOrThrow(loaded.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([2, 3, 4, 5].map((ordinal) => TurnItemId.make(`item-${ordinal}`)));
        yield* Queue.offer(harness.inputs, itemUpdated(2, "Stale replay", 9));
        yield* Queue.offer(harness.inputs, titleUpdated("Cursor receipt", 10));
        const replayed = yield* awaitThreadState(
          harness.observed,
          (state) => Option.getOrNull(state.data)?.thread.title === "Cursor receipt",
        );
        expect(itemTexts(replayed)).toContain("Message 2");
        expect(itemTexts(replayed)).not.toContain("Stale replay");
        expect(yield* Queue.size(harness.pageLoads)).toBe(0);
        yield* harness.clearSession;
        yield* harness.replaceSession;
        yield* Queue.take(harness.subscriptionStarts);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(10);
        expect(yield* Ref.get(harness.lastSubscribeHistory)).toEqual({ limit: 50 });
      }),
  );

  it.effect(
    "replays live updates received after an around snapshot before publishing the historical window",
    () =>
      Effect.gen(function* () {
        const harness = yield* historyHarness();
        yield* Queue.take(harness.subscriptionStarts);
        (yield* Ref.get(harness.latest)).history!.request({
          aroundMessageId: MessageId.make("message-2"),
        });
        const page = yield* Queue.take(harness.pageLoads);
        yield* Queue.offer(harness.inputs, itemUpdated(2, "Updated older message", 9));
        yield* Queue.offer(harness.inputs, titleUpdated("Page receipt", 10));
        yield* awaitThreadState(
          harness.observed,
          (state) => Option.getOrNull(state.data)?.thread.title === "Page receipt",
        );
        yield* replyPage(page.reply, [1, 2, 3], 8, false, true);
        const loaded = yield* awaitThreadState(
          harness.observed,
          (state) => state.history?.hasNewer === true && !state.history.isLoading,
        );
        expect(itemTexts(loaded)).toEqual(["Message 1", "Updated older message", "Message 3"]);
        yield* Queue.offer(harness.inputs, itemUpdated(6, "New live tail", 11));
        yield* Queue.offer(harness.inputs, titleUpdated("Tail receipt", 12));
        const historical = yield* awaitThreadState(
          harness.observed,
          (state) => Option.getOrNull(state.data)?.thread.title === "Tail receipt",
        );
        expect(itemTexts(historical)).not.toContain("New live tail");
      }),
  );

  it.effect(
    "gives latest priority over an in-flight jump and retries the exact failed request",
    () =>
      Effect.gen(function* () {
        const harness = yield* historyHarness();
        yield* Queue.take(harness.subscriptionStarts);
        (yield* Ref.get(harness.latest)).history!.request({
          aroundMessageId: MessageId.make("message-2"),
        });
        const around = yield* Queue.take(harness.pageLoads);
        (yield* Ref.get(harness.latest)).history!.request("latest");
        yield* replyPage(around.reply, [1, 2], 8, false, true);
        const latest = yield* Queue.take(harness.pageLoads);
        expect(latest.request).toEqual({ limit: 50 });
        yield* Deferred.succeed(latest.reply, { _tag: "NotFound" });
        const failed = yield* awaitThreadState(
          harness.observed,
          (state) => state.history?.error !== null && state.history?.error !== undefined,
        );
        expect(itemTexts(failed)).toEqual(["Message 4", "Message 5"]);
        failed.history!.retry();
        const retry = yield* Queue.take(harness.pageLoads);
        expect(retry.request).toEqual({ limit: 50 });
        yield* replyPage(retry.reply, [5, 6], 9);
        const loaded = yield* awaitThreadState(
          harness.observed,
          (state) => !state.history?.isLoading && itemTexts(state).includes("Message 6"),
        );
        expect(loaded.history?.hasNewer).toBe(false);
      }),
  );

  it.effect("discards a page when a reconnect snapshot replaces its base", () =>
    Effect.gen(function* () {
      const harness = yield* historyHarness();
      yield* Queue.take(harness.subscriptionStarts);
      (yield* Ref.get(harness.latest)).history!.request("older");
      const page = yield* Queue.take(harness.pageLoads);
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 20,
        projection: historyProjection([8, 9]),
        history: historyMetadata(8, 9),
      });
      yield* awaitThreadState(harness.observed, (state) => itemTexts(state).includes("Message 9"));
      yield* replyPage(page.reply, [2, 3], 10);
      yield* Queue.offer(harness.inputs, titleUpdated("Replacement receipt", 21));
      const loaded = yield* awaitThreadState(
        harness.observed,
        (state) => Option.getOrNull(state.data)?.thread.title === "Replacement receipt",
      );
      expect(itemTexts(loaded)).toEqual(["Message 8", "Message 9"]);
    }),
  );

  it.effect(
    "forces a full socket snapshot when a cached partial thread meets an older server",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          cached: historyProjection([4, 5]),
          cachedHistory: historyMetadata(4, 5),
        });
        yield* Queue.take(harness.subscriptionStarts);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
        expect(yield* Ref.get(harness.lastSubscribeHistory)).toBeUndefined();
        yield* Queue.offer(harness.inputs, snapshot(historyProjection([1, 2, 3, 4, 5]), 8));
        const full = yield* awaitThreadState(
          harness.observed,
          (state) => itemTexts(state).length === 5,
        );
        expect(full.history).toBeUndefined();
      }),
  );

  it.effect(
    "upgrades a legacy full cache to an explicitly bounded socket snapshot when HTTP fails",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          cached: historyProjection([1, 2, 3, 4, 5]),
          historySupport: true,
        });
        yield* Queue.take(harness.subscriptionStarts);
        expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
        expect(yield* Ref.get(harness.lastSubscribeHistory)).toEqual({ limit: 50 });
      }),
  );
});

describe("history viewport boundaries and lifecycle", () => {
  it.effect(
    "updates retained active support items without inserting them across an unloaded gap",
    () =>
      Effect.gen(function* () {
        const harness = yield* historyHarness();
        yield* Queue.take(harness.subscriptionStarts);
        const projection = historyProjection([1, 2]);
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshotSequence: 8,
          history: historyMetadata(1, 2, false, true),
          projection: { ...projection, turnItems: [...projection.turnItems, historyItem(5)] },
        });
        yield* awaitThreadState(harness.observed, (state) => state.history?.hasNewer === true);
        yield* Queue.offer(harness.inputs, itemUpdated(5, "Updated active support", 9));
        const updated = yield* awaitThreadState(harness.observed, (state) =>
          itemTexts(state).includes("Updated active support"),
        );
        expect(
          Option.getOrThrow(updated.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual(["item-1", "item-2"]);
        const latest = historyProjection([4, 5]);
        yield* Queue.offer(harness.inputs, {
          kind: "snapshot",
          snapshotSequence: 10,
          history: historyMetadata(4, 5),
          projection: { ...latest, turnItems: [historyItem(1), ...latest.turnItems] },
        });
        yield* Queue.offer(harness.inputs, itemUpdated(1, "Old pending support", 11));
        const tail = yield* awaitThreadState(harness.observed, (state) =>
          itemTexts(state).includes("Old pending support"),
        );
        expect(
          Option.getOrThrow(tail.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual(["item-4", "item-5"]);
      }),
  );

  it.effect("reopens a cached historical viewport at the latest page", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: historyProjection([1, 2]),
        cachedHistory: historyMetadata(1, 2, false, true),
        historySupport: true,
        httpSnapshot: Option.some({
          snapshotSequence: 8,
          projection: historyProjection([4, 5]),
          history: historyMetadata(4, 5),
        }),
      });
      yield* Queue.take(harness.subscriptionStarts);
      const loaded = yield* awaitThreadState(harness.observed, (state) =>
        itemTexts(state).includes("Message 5"),
      );
      expect(loaded.history?.hasNewer).toBe(false);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(8);
    }),
  );

  it.effect("fails an offline page promptly and preserves a retryable viewport", () =>
    Effect.gen(function* () {
      const harness = yield* historyHarness();
      yield* Queue.take(harness.subscriptionStarts);
      yield* SubscriptionRef.set(harness.prepared, Option.none());
      yield* harness.clearSession;
      (yield* Ref.get(harness.latest)).history!.request("older");
      const failed = yield* awaitThreadState(
        harness.observed,
        (state) => state.history?.error !== null && state.history?.error !== undefined,
      );
      expect(failed.history?.isLoading).toBe(false);
      expect(itemTexts(failed)).toEqual(["Message 4", "Message 5"]);
      expect(yield* Queue.size(harness.pageLoads)).toBe(0);
    }),
  );

  it.effect("ignores history actions after their thread state is disposed", () =>
    Effect.gen(function* () {
      const disposed = yield* Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* historyHarness();
          yield* Queue.take(harness.subscriptionStarts);
          return {
            request: (yield* Ref.get(harness.latest)).history!.request,
            pageLoads: harness.pageLoads,
          };
        }),
      );
      disposed.request("older");
      expect(yield* Queue.size(disposed.pageLoads)).toBe(0);
    }),
  );
});

it.effect("refreshes the authoritative index after a rollback hides conversation rows", () =>
  Effect.gen(function* () {
    const harness = yield* historyHarness();
    yield* Queue.take(harness.subscriptionStarts);
    yield* Queue.offer(harness.inputs, {
      kind: "event",
      sequence: 8,
      event: {
        id: EventId.make("event-rollback"),
        type: "run.updated",
        threadId: THREAD_ID,
        occurredAt: v2Projection.updatedAt,
        payload: {
          id: RunId.make("run-rolled-back"),
          threadId: THREAD_ID,
          ordinal: 1,
          providerInstanceId: v2Projection.thread.providerInstanceId,
          modelSelection: v2Projection.thread.modelSelection!,
          providerThreadId: null,
          userMessageId: MessageId.make("message-1"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: v2Projection.updatedAt,
          startedAt: null,
          completedAt: v2Projection.updatedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
    });
    const page = yield* Queue.take(harness.pageLoads);
    expect(page.request).toEqual({ limit: 50 });
    const history = historyMetadata(4, 5);
    yield* Deferred.succeed(page.reply, {
      _tag: "Snapshot",
      snapshot: {
        snapshotSequence: 8,
        projection: historyProjection([4, 5]),
        history: { ...history, index: history.index.slice(3) },
      },
    });
    const loaded = yield* awaitThreadState(
      harness.observed,
      (state) => state.history?.index.length === 2,
    );
    expect(loaded.history?.index.map((entry) => entry.messageId)).toEqual([
      "message-4",
      "message-5",
    ]);
  }),
);
