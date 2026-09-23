import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  type ComputerEmergencyStopEndpoint,
  DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH,
  notifyBackendComputerEmergencyStop,
} from "./ComputerEmergencyStopNotice.ts";

const ENDPOINT: ComputerEmergencyStopEndpoint = {
  httpBaseUrl: "http://127.0.0.1:3773/some/path?x=1#frag",
  bearerToken: "desktop-bearer",
};

type Reply = number | "hang" | "refuse";

/**
 * Runs the notice against a fake HttpClient that answers each request with
 * the next reply. Requests and reported errors land on queues.
 */
const withNotice = <A, E>(
  replies: ReadonlyArray<Reply>,
  body: (harness: {
    readonly requests: Queue.Queue<HttpClientRequest.HttpClientRequest>;
    readonly errors: Queue.Queue<string>;
    readonly start: (
      endpoint?: Effect.Effect<ComputerEmergencyStopEndpoint, string>,
    ) => Effect.Effect<Fiber.Fiber<void>>;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const requests = yield* Queue.unbounded<HttpClientRequest.HttpClientRequest>();
    const errors = yield* Queue.unbounded<string>();
    let next = 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        yield* Queue.offer(requests, request);
        const reply = replies[next++] ?? 202;
        if (reply === "hang") return yield* Effect.never;
        if (reply === "refuse")
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request, description: "ECONNREFUSED" }),
          });
        return HttpClientResponse.fromWeb(request, new Response(null, { status: reply }));
      }),
    );
    const start = (
      endpoint: Effect.Effect<ComputerEmergencyStopEndpoint, string> = Effect.succeed(ENDPOINT),
    ) =>
      notifyBackendComputerEmergencyStop({
        endpoint,
        onError: (message) => Queue.offer(errors, message).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.forkChild);
    return yield* body({ requests, errors, start });
  });

describe("ComputerEmergencyStopNotice", () => {
  it.effect("posts once to the loopback route with the bearer credential and stops on 202", () =>
    withNotice([202], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        yield* Fiber.join(yield* start());
        const request = yield* Queue.take(requests);
        assert.strictEqual(request.method, "POST");
        assert.strictEqual(
          request.url,
          `http://127.0.0.1:3773${DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH}`,
        );
        assert.strictEqual(request.headers.authorization, "Bearer desktop-bearer");
        assert.strictEqual(yield* Queue.size(requests), 0);
        assert.strictEqual(yield* Queue.size(errors), 0);
      }),
    ),
  );

  it.effect("retries after 1000ms and 3000ms, then gives up", () =>
    withNotice([503, 503, 503], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        const fiber = yield* start();
        yield* Queue.take(requests);
        assert.strictEqual(
          yield* Queue.take(errors),
          "computer emergency-stop notice returned HTTP 503",
        );
        yield* TestClock.adjust(999);
        assert.strictEqual(yield* Queue.size(requests), 0);
        yield* TestClock.adjust(1);
        yield* Queue.take(requests);
        yield* Queue.take(errors);
        yield* TestClock.adjust(2_999);
        assert.strictEqual(yield* Queue.size(requests), 0);
        yield* TestClock.adjust(1);
        yield* Queue.take(requests);
        yield* Fiber.join(fiber);
        assert.strictEqual(yield* Queue.size(errors), 1);
        assert.strictEqual(yield* Queue.size(requests), 0);
      }),
    ),
  );

  it.effect("times out a hung request after 5s and retries past a refused one", () =>
    withNotice(["hang", "refuse", 202], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        const fiber = yield* start();
        yield* Queue.take(requests);
        yield* TestClock.adjust(5_000);
        assert.include(yield* Queue.take(errors), "timed out");
        yield* TestClock.adjust(1_000);
        yield* Queue.take(requests);
        assert.include(yield* Queue.take(errors), "computer emergency-stop notice failed");
        yield* TestClock.adjust(3_000);
        yield* Fiber.join(fiber);
        assert.strictEqual(yield* Queue.size(errors), 0);
        assert.strictEqual(yield* Queue.size(requests), 1);
      }),
    ),
  );

  it.effect("refuses a non-loopback backend without sending anything", () =>
    withNotice([], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        const fiber = yield* start(
          Effect.succeed({ httpBaseUrl: "http://example.com:3773", bearerToken: "token" }),
        );
        assert.include(yield* Queue.take(errors), "loopback");
        yield* TestClock.adjust(1_000);
        yield* Queue.take(errors);
        yield* TestClock.adjust(3_000);
        yield* Fiber.join(fiber);
        assert.strictEqual(yield* Queue.size(errors), 1);
        assert.strictEqual(yield* Queue.size(requests), 0);
      }),
    ),
  );

  it.effect("accepts an IPv6 loopback backend", () =>
    withNotice([202], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        yield* Fiber.join(
          yield* start(Effect.succeed({ httpBaseUrl: "http://[::1]:3773", bearerToken: "token" })),
        );
        assert.strictEqual(
          (yield* Queue.take(requests)).url,
          `http://[::1]:3773${DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH}`,
        );
        assert.strictEqual(yield* Queue.size(errors), 0);
      }),
    ),
  );

  it.effect("reports a missing credential and resolves the endpoint again on retry", () =>
    withNotice([202], ({ requests, errors, start }) =>
      Effect.gen(function* () {
        let resolutions = 0;
        const endpoint = Effect.suspend(() =>
          ++resolutions === 1 ? Effect.fail("backend restarting") : Effect.succeed(ENDPOINT),
        );
        const fiber = yield* start(endpoint);
        assert.strictEqual(
          yield* Queue.take(errors),
          "computer emergency-stop notice has no backend endpoint or credential",
        );
        yield* TestClock.adjust(1_000);
        yield* Fiber.join(fiber);
        assert.strictEqual(resolutions, 2);
        assert.strictEqual(yield* Queue.size(requests), 1);
      }),
    ),
  );
});
