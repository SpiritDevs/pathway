import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HTTP_SHELL_READINESS_PATH } from "@spiritdevs/shared/httpReadiness";
import { commandReadinessLayer, rendererShellReadinessRouteLayer } from "./httpStartupReadiness.ts";
import { makeCommandGate, ServerRuntimeStartup } from "./serverRuntimeStartup.ts";

describe("HTTP startup readiness", () => {
  it.effect("serves the shell while data and control routes wait for recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* makeCommandGate;
        const enteredGate = yield* Deferred.make<void>();
        let dataRequests = 0;
        const startup = Layer.succeed(ServerRuntimeStartup, {
          ...gate,
          awaitCommandReady: Deferred.succeed(enteredGate, undefined).pipe(
            Effect.andThen(gate.awaitCommandReady),
          ),
          markHttpListening: Effect.void,
        });
        const routes = Layer.mergeAll(
          HttpRouter.add(
            "POST",
            "/api/commands",
            Effect.sync(() => {
              dataRequests++;
              return HttpServerResponse.empty({ status: 202 });
            }),
          ).pipe(Layer.provide(commandReadinessLayer)),
          HttpRouter.add("GET", "/", Effect.succeed(HttpServerResponse.text("app shell"))),
          rendererShellReadinessRouteLayer,
        ).pipe(Layer.provide(startup));
        const handler = yield* HttpRouter.toHttpEffect(routes);
        const request = (path: string, method = "GET") =>
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(new Request(`http://localhost${path}`, { method })),
            ),
          );
        const commands = yield* request("/api/commands", "POST").pipe(Effect.forkChild);
        yield* Deferred.await(enteredGate);
        assert.equal((yield* request("/")).status, 200);
        assert.equal((yield* request(HTTP_SHELL_READINESS_PATH)).status, 204);
        assert.equal(dataRequests, 0);
        yield* gate.signalCommandReady;
        assert.equal((yield* Fiber.join(commands)).status, 202);
        assert.equal(dataRequests, 1);
      }),
    ),
  );
});
