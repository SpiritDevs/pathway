import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AuthAccessTokenResult, PRIMARY_LOCAL_ENVIRONMENT_ID } from "@spiritdevs/contracts";

import * as DesktopBackendPool from "./DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const config = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    pathwayHome: "/tmp/pathway",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const encodeAccessToken = Schema.encodeSync(Schema.fromJsonString(AuthAccessTokenResult));

function bearerResponse(request: HttpClientRequest.HttpClientRequest, token: string) {
  return HttpClientResponse.fromWeb(
    request,
    new Response(
      encodeAccessToken({
        access_token: token,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "orchestration:read",
      }),
      { headers: { "content-type": "application/json" } },
    ),
  );
}

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const httpClientLayer = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(bearerResponse(request, "desktop-bearer-token")),
          ),
        ),
      );
      const poolLayer = Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
        list: Effect.succeed([
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: Effect.succeed("Windows"),
            currentConfig: Effect.succeed(Option.some(config)),
            snapshot: Effect.succeed({ ready: true }),
          },
        ]),
      } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]);
      const testLayer = DesktopLocalEnvironmentAuth.layer.pipe(
        Layer.provide(Layer.mergeAll(poolLayer, httpClientLayer)),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(testLayer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );
});

it.effect("fails immediately before readiness and succeeds on the next ready attempt", () =>
  Effect.gen(function* () {
    let ready = false;
    let requests = 0;
    const layer = DesktopLocalEnvironmentAuth.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
            list: Effect.succeed([
              {
                id: PRIMARY_LOCAL_ENVIRONMENT_ID,
                currentConfig: Effect.succeed(Option.some(config)),
                snapshot: Effect.sync(() => ({ ready })),
              },
            ]),
          } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                requests++;
                return bearerResponse(request, "ready-token");
              }),
            ),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      const error = yield* auth.getBearerToken.pipe(Effect.flip);
      assert.equal(error._tag, "DesktopLocalEnvironmentAuthBackendNotReadyError");
      assert.equal(requests, 0);
      ready = true;
      assert.equal(yield* auth.getBearerToken, "ready-token");
      assert.equal(requests, 1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("releases the token mutex after a hung local exchange times out in one second", () =>
  Effect.gen(function* () {
    const requested = yield* Deferred.make<void>();
    let hung = true;
    const layer = DesktopLocalEnvironmentAuth.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(DesktopBackendPool.DesktopBackendPool, {
            list: Effect.succeed([
              {
                id: PRIMARY_LOCAL_ENVIRONMENT_ID,
                currentConfig: Effect.succeed(Option.some(config)),
                snapshot: Effect.succeed({ ready: true }),
              },
            ]),
          } as unknown as DesktopBackendPool.DesktopBackendPool["Service"]),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              hung
                ? Deferred.succeed(requested, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed(bearerResponse(request, "retried-token")),
            ),
          ),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
      const attempt = yield* auth.getBearerToken.pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(requested);
      yield* TestClock.adjust("1 second");
      assert.equal(
        (yield* Fiber.join(attempt))._tag,
        "DesktopLocalEnvironmentAuthSessionBootstrapError",
      );
      hung = false;
      assert.equal(yield* auth.getBearerToken, "retried-token");
    }).pipe(Effect.provide(layer));
  }),
);
