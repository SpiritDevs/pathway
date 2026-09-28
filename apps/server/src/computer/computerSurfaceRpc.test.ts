import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentScope,
  COMPUTER_SURFACE_METHODS as methods,
  WsComputerRpcGroup,
} from "@spiritdevs/contracts";
import { Deferred, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  ComputerApprovalGate,
  ComputerApprovalRequester,
  make as makeGate,
} from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { ComputerService } from "./Services/ComputerService.ts";
import { makeWsComputerRpcLayer, serveRpcWebSocket } from "./wsComputerRpcLayer.ts";

const config = ServerConfig.layerTest(process.cwd(), {
  prefix: "pathway-surface-control-rpc-test-",
});
const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(config),
);

it.layer(NodeServices.layer)("computer surface RPC authorization", (it) => {
  it.effect(
    "binds ownership to the socket, enforces scopes, and releases on session revocation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const sessions = yield* SessionStore;
          const manager = yield* ComputerManager.make({
            backend: new FakeComputerBackend(),
            actionSettleMs: 0,
          });
          const gate = yield* makeGate().pipe(
            Effect.provideService(ComputerApprovalRequester, {
              open: () => Effect.void,
              resolve: () => Effect.void,
            }),
          );
          const server = HttpRouter.serve(
            HttpRouter.add(
              "GET",
              "/ws",
              Effect.gen(function* () {
                const session = yield* auth.authenticateWebSocketUpgrade(
                  yield* HttpServerRequest.HttpServerRequest,
                );
                const handlers = makeWsComputerRpcLayer(session).pipe(
                  Layer.provideMerge(RpcSerialization.layerJson),
                  Layer.provide(ServerSettings.layerTest()),
                  Layer.provide(Layer.succeed(ComputerApprovalGate, gate)),
                  Layer.provide(
                    Layer.succeed(ComputerService, {
                      manager,
                      supported: true,
                      availability: { kind: "available", backend: "fake" },
                    }),
                  ),
                );
                return yield* Effect.flatten(
                  serveRpcWebSocket(WsComputerRpcGroup, handlers, session.sessionId),
                );
              }),
            ),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));

          yield* Effect.gen(function* () {
            const { address } = yield* HttpServer.HttpServer;
            if (address._tag !== "TcpAddress") return yield* Effect.die("TCP required");
            const connect = Effect.fn(function* (scopes: readonly AuthEnvironmentScope[]) {
              const issued = yield* sessions.issue({ scopes });
              const session = yield* sessions.verify(issued.token);
              const ticket = yield* auth.issueWebSocketTicket(session);
              const protocol = RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                  Socket.layerWebSocket(
                    `ws://127.0.0.1:${address.port}/ws?wsTicket=${ticket.ticket}`,
                  ).pipe(
                    Layer.provide(
                      Layer.succeed(
                        Socket.WebSocketConstructor,
                        (url, protocols) => new WebSocket(url, protocols),
                      ),
                    ),
                  ),
                ),
                Layer.provide(RpcSerialization.layerJson),
              );
              const context = yield* Layer.build(protocol);
              const client = yield* RpcClient.make(WsComputerRpcGroup).pipe(
                Effect.provideContext(context),
              );
              return { client, session };
            });
            const a = yield* connect(AuthEnvironmentScope.literals);
            const b = yield* connect(AuthEnvironmentScope.literals);
            const watcher = yield* connect(["orchestration:read"]);
            const initial = yield* watcher.client[methods.getState]({});
            expect(initial.state.controller.kind).toBe("idle");
            const denied = yield* Effect.flip(watcher.client[methods.takeControl]({}));
            expect(denied).toMatchObject({
              _tag: "EnvironmentAuthorizationError",
              requiredScope: "orchestration:operate",
            });
            const acquired = yield* a.client[methods.takeControl]({});
            expect(acquired.state.controller).toEqual({
              kind: "client",
              clientId: acquired.clientId,
            });
            const watched = yield* b.client[methods.getState]({});
            expect(watched.clientId).not.toBe(acquired.clientId);
            expect(watched.state.controller).toEqual(acquired.state.controller);
            yield* Effect.flip(b.client[methods.input]({ event: { type: "key", key: "A" } }));
            expect(
              yield* a.client[methods.input]({ event: { type: "type", text: "hello" } }),
            ).toBeUndefined();
            const listening = yield* Deferred.make<void>();
            const released = yield* Deferred.make<void>();
            yield* b.client[methods.subscribe]({}).pipe(
              Stream.runForEach((event) => {
                if (event.state.controller.kind === "idle")
                  return Deferred.succeed(released, undefined);
                return Deferred.succeed(listening, undefined);
              }),
              Effect.forkScoped,
            );
            yield* Deferred.await(listening);
            yield* auth.revokeSession(a.session.sessionId);
            yield* Deferred.await(released);
            expect((yield* b.client[methods.takeControl]({})).state.controller).toEqual({
              kind: "client",
              clientId: watched.clientId,
            });
            yield* b.client[methods.releaseControl]({});
          }).pipe(Effect.scoped, Effect.provide(server));
        }),
      ).pipe(Effect.provide(authLayer)),
  );
});
