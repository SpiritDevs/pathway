import {
  EnvironmentId,
  EventId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { makeRetainedThreadSnapshots } from "./threadRetention.ts";
import {
  createEnvironmentThreadStateAtoms,
  ThreadSnapshotLoader,
  type EnvironmentThreadState,
} from "./threads.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-retention"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

function titleUpdated(title: string, sequence: number): OrchestrationV2ThreadStreamItem {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-title-${sequence}`),
      type: "thread.metadata-updated",
      threadId: v2ThreadId,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
}

const titleOf = (result: AsyncResult.AsyncResult<EnvironmentThreadState, unknown>) =>
  Option.getOrUndefined(AsyncResult.value(result))?.data.pipe(Option.getOrUndefined)?.thread.title;

describe("createEnvironmentThreadStateAtoms", () => {
  it("shares atoms per thread key", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(atom.idleTTL).toBeUndefined();
    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
    expect(threads.loadEnabledAtom(environmentId, threadId)).toBe(
      threads.loadEnabledAtom(environmentId, threadId),
    );
  });

  it("stops loading without subscribing to the environment thread source", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-stopped");
    const threadId = ThreadId.make("thread-stopped");
    const registry = AtomRegistry.make();

    registry.set(threads.loadEnabledAtom(environmentId, threadId), false);

    const result = registry.get(threads.stateAtom(environmentId, threadId));
    expect(Option.getOrUndefined(AsyncResult.value(result))).toMatchObject({
      status: "stopped",
    });
    registry.dispose();
  });

  it.effect(
    "releases an unobserved thread stream and repaints its retained snapshot synchronously",
    () =>
      Effect.gen(function* () {
        const subscriptions = yield* Queue.unbounded<{
          readonly afterSequence: number | undefined;
          readonly items: Queue.Queue<OrchestrationV2ThreadStreamItem>;
        }>();
        const released = yield* Queue.unbounded<void>();
        let cacheLoads = 0;
        const client = {
          [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
            readonly afterSequence?: number;
          }) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const items = yield* Queue.unbounded<OrchestrationV2ThreadStreamItem>();
                yield* Queue.offer(subscriptions, { afterSequence: input.afterSequence, items });
                return Stream.fromQueue(items).pipe(
                  Stream.ensuring(Queue.offer(released, undefined)),
                );
              }),
            ),
        } as unknown as WsRpcProtocolClient;
        const session: RpcSession = {
          client,
          initialConfig: Effect.succeed({} as never),
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        };
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: TARGET,
          state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
          session: yield* SubscriptionRef.make(Option.some(session)),
          prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        const runtime = Atom.runtime(
          Layer.mergeAll(
            Layer.succeed(EnvironmentRegistry, {
              followStream: (_environmentId, stream) =>
                Stream.provideService(
                  stream,
                  EnvironmentSupervisor.EnvironmentSupervisor,
                  supervisor,
                ),
            } as EnvironmentRegistry["Service"]),
            Layer.succeed(EnvironmentCacheStore, {
              loadThread: () => {
                cacheLoads += 1;
                return Effect.succeed(Option.none());
              },
              saveThread: () => Effect.void,
              removeThread: () => Effect.void,
            } as unknown as EnvironmentCacheStore["Service"]),
            Layer.succeed(
              ThreadSnapshotLoader,
              ThreadSnapshotLoader.of({
                load: () =>
                  Effect.succeed({
                    _tag: "Snapshot",
                    snapshot: { snapshotSequence: 3, projection: v2Projection },
                  }),
              }),
            ),
          ),
        );
        const threads = createEnvironmentThreadStateAtoms(runtime);
        const atom = threads.stateAtom(TARGET.environmentId, v2ThreadId);
        const registry = AtomRegistry.make();
        const observed = yield* Queue.unbounded<string | undefined>();
        const observe = () =>
          registry.subscribe(atom, (result) => Queue.offerUnsafe(observed, titleOf(result)), {
            immediate: true,
          });

        const unmount = observe();
        const first = yield* Queue.take(subscriptions);
        expect(first.afterSequence).toBe(3);
        yield* Queue.offer(first.items, titleUpdated("Live title", 4));
        yield* Queue.take(observed).pipe(Effect.repeat({ until: (t) => t === "Live title" }));

        // Switching away closes the live subscription instead of idling it.
        unmount();
        yield* Queue.take(released);
        yield* Queue.clear(observed);

        // Switching back paints the retained snapshot in the same tick, without
        // waiting on the stream or the persistent cache, then resumes by cursor.
        const remount = observe();
        expect(titleOf(registry.get(atom))).toBe("Live title");
        expect(yield* Queue.take(observed)).toBe("Live title");
        const second = yield* Queue.take(subscriptions);
        expect(second.afterSequence).toBe(4);
        expect(cacheLoads).toBe(1);

        remount();
        yield* Queue.take(released);
        registry.dispose();
      }),
  );
});

describe("makeRetainedThreadSnapshots", () => {
  const snapshot = (snapshotSequence: number) => ({ snapshotSequence, projection: v2Projection });

  it("evicts the least recently retained thread beyond its limit", () => {
    const retained = makeRetainedThreadSnapshots(2);
    retained.set("a", snapshot(1));
    retained.set("b", snapshot(2));
    retained.set("a", snapshot(3));
    retained.set("c", snapshot(4));

    expect(retained.get("b")).toBeUndefined();
    expect(retained.get("a")?.snapshotSequence).toBe(3);
    expect(retained.get("c")?.snapshotSequence).toBe(4);
  });

  it("forgets a thread whose closing state cannot resume", () => {
    const retained = makeRetainedThreadSnapshots();
    retained.set("a", snapshot(1));
    retained.set("a", undefined);

    expect(retained.get("a")).toBeUndefined();
  });
});
