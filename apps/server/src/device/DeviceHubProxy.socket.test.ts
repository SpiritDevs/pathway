// @effect-diagnostics nodeBuiltinImport:off - test-only loopback HTTP servers exercise real binary upgrades.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  FetchHttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { DeviceService } from "./DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./DeviceHubProxy.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-device-socket-" })),
);

const portOf = (server: HttpServer.HttpServer["Service"]) => {
  if (server.address._tag !== "TcpAddress") throw new Error("Expected test TCP server");
  return server.address.port;
};

const makeHub = Effect.fn("deviceProxySocket.makeHub")(function* () {
  const input = yield* Deferred.make<Uint8Array>();
  const disconnected = yield* Deferred.make<void>();
  const requests: string[] = [];
  const layer = HttpRouter.serve(
    HttpRouter.add(
      "GET",
      "/*",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        requests.push(request.url);
        const socket = yield* request.upgrade;
        const write = yield* socket.writer;
        yield* socket
          .runRaw(
            (message) =>
              Deferred.succeed(
                input,
                typeof message === "string" ? new TextEncoder().encode(message) : message,
              ),
            { onOpen: write(new Uint8Array([0, 255, 42])).pipe(Effect.ignore) },
          )
          .pipe(Effect.ensuring(Deferred.succeed(disconnected, undefined)), Effect.ignore);
        return HttpServerResponse.empty();
      }),
    ),
    { disableLogger: true, disableListenLog: true },
  ).pipe(
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );
  const context = yield* Layer.build(layer);
  const origin = `http://127.0.0.1:${portOf(Context.get(context, HttpServer.HttpServer))}`;
  return { origin, input, disconnected, requests };
});

const makeProxy = (origin: string) =>
  HttpRouter.serve(deviceHubProxyRouteLayer, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(
      Layer.succeed(DeviceService, {
        currentReadiness: () => Effect.succeed({ hostId: "remote-mac", hub: { origin } }),
      } as DeviceService["Service"]),
    ),
    Layer.provideMerge(authLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );

it.layer(NodeServices.layer)("device proxy sockets", (it) => {
  for (const path of ["/vendor/serve-sim/helper/ws", "/vendor/serve-emu/ws"]) {
    it.effect(`relays binary media and input at ${path}, then closes on session revocation`, () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        yield* Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const session = yield* auth.issueSession({
            scopes: ["orchestration:read", "orchestration:operate"],
          });
          const ticket = yield* auth.issueWebSocketTicket(session);
          const server = yield* HttpServer.HttpServer;
          const received = yield* Deferred.make<Uint8Array>();
          const closed = yield* Deferred.make<number>();
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const ws = new WebSocket(
                `ws://127.0.0.1:${portOf(server)}/api/device-hub${path}?hostId=remote-mac&device=phone&wsTicket=${encodeURIComponent(ticket.ticket)}`,
              );
              ws.binaryType = "arraybuffer";
              ws.addEventListener("message", (event) =>
                Deferred.doneUnsafe(
                  received,
                  Effect.succeed(new Uint8Array(event.data as ArrayBuffer)),
                ),
              );
              ws.addEventListener("close", (event) =>
                Deferred.doneUnsafe(closed, Effect.succeed(event.code)),
              );
              return ws;
            }),
            (ws) => Effect.sync(() => ws.close()),
          );
          expect([...(yield* Deferred.await(received))]).toEqual([0, 255, 42]);
          socket.send(new Uint8Array([9, 0, 128]));
          expect([...(yield* Deferred.await(hub.input))]).toEqual([9, 0, 128]);
          expect(hub.requests).toEqual([`${path}?device=phone`]);
          yield* auth.revokeSession(session.sessionId);
          expect(yield* Deferred.await(closed)).toBe(1008);
          yield* Deferred.await(hub.disconnected);
        }).pipe(Effect.provide(makeProxy(hub.origin)));
      }),
    );
  }
});
