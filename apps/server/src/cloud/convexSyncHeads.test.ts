import { assert, describe, it } from "@effect/vitest";
import type { ConvexClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  AuthorizationEpoch,
  CompanyVersion,
  type SyncLatestVersionResponse,
} from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  DEFAULT_LATEST_VERSION_POLL_INTERVAL_MS,
  makeConvexSyncTransport,
  type ConvexClientLike,
} from "./convexSyncTransport.ts";

const companyId = CompanyId.make("company-head-test");
const head = (version: number, epoch = 1): SyncLatestVersionResponse => ({
  version: CompanyVersion.make(version),
  authorizationEpoch: AuthorizationEpoch.make(epoch),
});

function realtimeFixture(initial?: SyncLatestVersionResponse) {
  let emit: (value: SyncLatestVersionResponse) => void = () => {
    throw new Error("Not subscribed");
  };
  let fail: (error: Error) => void = () => {
    throw new Error("Not subscribed");
  };
  let auth: Parameters<ConvexClient["setAuth"]>[0] | undefined;
  let subscriptions = 0;
  let closed = 0;
  let unsubscribed = 0;
  const client: Pick<ConvexClient, "setAuth" | "onUpdate" | "close"> = {
    setAuth: (fetcher) => {
      auth = fetcher;
    },
    onUpdate: (_reference, args, callback, onError) => {
      assert.deepEqual(args, { companyId });
      emit = callback;
      fail = (error) => onError?.(error);
      subscriptions++;
      if (initial) emit(initial);
      const unsubscribe = () => {
        unsubscribed++;
      };
      return Object.assign(unsubscribe, {
        unsubscribe,
        getCurrentValue: () => undefined,
        getQueryLogs: () => undefined,
      });
    },
    close: async () => {
      closed++;
    },
  };
  return {
    client,
    emit: (value: SyncLatestVersionResponse) => emit(value),
    fail: (error: Error) => fail(error),
    get auth() {
      return auth;
    },
    get subscriptions() {
      return subscriptions;
    },
    get closed() {
      return closed;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

function httpClient(respond: () => Promise<unknown>): ConvexClientLike {
  return {
    setAuth: () => {},
    query: respond as ConvexClientLike["query"],
    mutation: () => Promise.reject(new Error("Unexpected mutation")),
  };
}

const neverResponds = httpClient(() => new Promise(() => {}));
const tokens = { token: Effect.succeed("service-token"), invalidate: () => Effect.void };
const convexUrl = "https://head-test.convex.cloud";

describe("server realtime sync heads", () => {
  it.effect(
    "delivers changes immediately, refreshes service auth and closes with its subscriber",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const realtime = realtimeFixture(head(5));
          let invalidations = 0;
          const transport = yield* makeConvexSyncTransport({
            convexUrl,
            client: neverResponds,
            createSubscriptionClient: () => realtime.client,
            tokens: {
              token: Effect.sync(() => `token-${invalidations}`),
              invalidate: () =>
                Effect.sync(() => {
                  invalidations++;
                }),
            },
          });
          const observed = yield* Queue.unbounded<SyncLatestVersionResponse>();
          const fiber = yield* transport.latestVersion({ companyId }).pipe(
            Stream.runForEach((value) => Queue.offer(observed, value)),
            Effect.forkScoped,
          );
          assert.deepEqual(yield* Queue.take(observed), head(5));
          realtime.emit(head(6));
          assert.deepEqual(yield* Queue.take(observed), head(6));
          assert.equal(
            yield* Effect.promise(() => realtime.auth!({ forceRefreshToken: false })),
            "token-0",
          );
          assert.equal(
            yield* Effect.promise(() => realtime.auth!({ forceRefreshToken: true })),
            "token-1",
          );
          yield* Fiber.interrupt(fiber);
          assert.equal(realtime.unsubscribed, 1);
          assert.equal(realtime.closed, 1);
        }),
      ),
  );

  it.effect("recovers a silent subscription immediately and then at sixty-second intervals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realtime = realtimeFixture();
        let calls = 0;
        const transport = yield* makeConvexSyncTransport({
          convexUrl,
          tokens,
          client: httpClient(async () => head(++calls)),
          createSubscriptionClient: () => realtime.client,
        });
        const observed = yield* Queue.unbounded<SyncLatestVersionResponse>();
        const fiber = yield* transport.latestVersion({ companyId }).pipe(
          Stream.runForEach((value) => Queue.offer(observed, value)),
          Effect.forkScoped,
        );
        assert.deepEqual(yield* Queue.take(observed), head(1));
        assert.equal(DEFAULT_LATEST_VERSION_POLL_INTERVAL_MS, 60_000);
        yield* TestClock.adjust("59 seconds");
        assert.equal(calls, 1);
        yield* TestClock.adjust("1 second");
        assert.deepEqual(yield* Queue.take(observed), head(2));
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust("5 minutes");
        assert.equal(calls, 2);
        assert.equal(realtime.closed, 1);
      }),
    ),
  );

  it.effect(
    "ignores stale recovery responses and still delivers an epoch change at the same version",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const realtime = realtimeFixture(head(8));
          let calls = 0;
          const transport = yield* makeConvexSyncTransport({
            convexUrl,
            tokens,
            client: httpClient(async () => {
              calls++;
              return head(3);
            }),
            createSubscriptionClient: () => realtime.client,
          });
          const observed = yield* Queue.unbounded<SyncLatestVersionResponse>();
          const fiber = yield* transport.latestVersion({ companyId }).pipe(
            Stream.runForEach((value) => Queue.offer(observed, value)),
            Effect.forkScoped,
          );
          // Either path may deliver the initial head first; later HTTP answers must not regress it.
          const first = yield* Queue.take(observed);
          if (first.version === 3) assert.deepEqual(yield* Queue.take(observed), head(8));
          else assert.deepEqual(first, head(8));
          yield* TestClock.adjust("1 minute");
          assert.isAtLeast(calls, 2);
          realtime.emit(head(8, 2));
          assert.deepEqual(yield* Queue.take(observed), head(8, 2));
          yield* Fiber.interrupt(fiber);
        }),
      ),
  );

  it.effect("creates a fresh scoped client and head watermark when resubscribing", () =>
    Effect.gen(function* () {
      const clients: ReturnType<typeof realtimeFixture>[] = [];
      const transport = yield* makeConvexSyncTransport({
        convexUrl,
        tokens,
        client: neverResponds,
        createSubscriptionClient: () => {
          const realtime = realtimeFixture(head(10 - clients.length));
          clients.push(realtime);
          return realtime.client;
        },
      });
      const subscription = transport.latestVersion({ companyId }).pipe(Stream.take(1));
      assert.deepEqual(yield* Stream.runCollect(subscription), [head(10)]);
      assert.deepEqual(yield* Stream.runCollect(subscription), [head(9)]);
      assert.equal(clients.length, 2);
      for (const client of clients) {
        assert.equal(client.unsubscribed, 1);
        assert.equal(client.closed, 1);
      }
    }),
  );

  it.effect("surfaces permission revocation and releases both subscription and socket", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const realtime = realtimeFixture(head(1));
        const transport = yield* makeConvexSyncTransport({
          convexUrl,
          tokens,
          client: neverResponds,
          createSubscriptionClient: () => realtime.client,
        });
        const observed = yield* Queue.unbounded<SyncLatestVersionResponse>();
        const fiber = yield* transport.latestVersion({ companyId }).pipe(
          Stream.runForEach((value) => Queue.offer(observed, value)),
          Effect.flip,
          Effect.forkScoped,
        );
        yield* Queue.take(observed);
        realtime.fail(new ConvexError({ code: "environment-not-registered" }));
        const error = yield* Fiber.join(fiber);
        assert.equal(error.reason, "unauthorized");
        assert.equal(realtime.unsubscribed, 1);
        assert.equal(realtime.closed, 1);
      }),
    ),
  );
});
