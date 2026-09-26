import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AuthEnvironmentScope,
  COMPUTER_WS_METHODS,
  type ComputerEvent,
  ThreadId,
  WsComputerRpcGroup,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  ComputerApprovalGate,
  ComputerApprovalRequester,
  make as makeComputerApprovalGate,
} from "./ComputerApprovalGate.ts";
import { ComputerManager } from "./ComputerManager.ts";
import { FakeComputerBackend } from "./FakeComputerBackend.ts";
import { ComputerService } from "./Services/ComputerService.ts";
import { makeWsComputerRpcLayer, serveRpcWebSocket } from "./wsComputerRpcLayer.ts";

const authLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-computer-rpc-test-" })),
);

it.layer(NodeServices.layer)("computer WebSocket RPC layer", (it) => {
  it.effect.each(["client close", "session revocation"] as const)(
    "keeps watched threads until %s, then releases its handlers",
    (close) =>
      Effect.scoped(
        Effect.gen(function* () {
          const sessions = yield* SessionStore;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const issued = yield* sessions.issue({ scopes: AuthEnvironmentScope.literals });
          const session = yield* sessions.verify(issued.token);
          const ticket = yield* auth.issueWebSocketTicket(session);
          const closed = yield* Deferred.make<number>();
          const watched = ThreadId.make("thread:watched");
          const unwatched = ThreadId.make("thread:unwatched");
          const manager = yield* ComputerManager.make({ backend: new FakeComputerBackend() });
          // Scripted and finite, so a dropped event shows up as a short list, not a hang.
          const events: ReadonlyArray<ComputerEvent> = [
            { type: "computer.thread-state", state: yield* manager.getThreadState(unwatched) },
            { type: "computer.thread-state", state: yield* manager.getThreadState(watched) },
          ];
          Object.defineProperty(manager, "events", { value: Stream.fromIterable(events) });
          const approvalGate = yield* makeComputerApprovalGate().pipe(
            Effect.provideService(ComputerApprovalRequester, {
              open: () => Effect.void,
              resolve: () => Effect.void,
            }),
          );

          const handlersReleased = yield* Deferred.make<void>();
          const handlers = Layer.merge(
            makeWsComputerRpcLayer(session),
            Layer.effectDiscard(
              Effect.addFinalizer(() => Deferred.succeed(handlersReleased, undefined)),
            ),
          ).pipe(
            Layer.provideMerge(RpcSerialization.layerJson),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(Layer.succeed(ComputerApprovalGate, approvalGate)),
            Layer.provide(
              Layer.succeed(ComputerService, {
                supported: true,
                availability: { kind: "available", backend: "fake" },
                manager,
              }),
            ),
          );
          // The same route shape as the server's /ws: handlers built per upgrade request.
          const server = HttpRouter.serve(
            HttpRouter.add(
              "GET",
              "/ws",
              Effect.gen(function* () {
                const request = yield* HttpServerRequest.HttpServerRequest;
                const authenticated = yield* auth.authenticateWebSocketUpgrade(request);
                return yield* Effect.flatten(
                  serveRpcWebSocket(WsComputerRpcGroup, handlers, authenticated.sessionId),
                );
              }),
            ),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.provideMerge(NodeHttpServer.layerTest));
          const socketClient = Layer.unwrap(
            Effect.gen(function* () {
              const { address } = yield* HttpServer.HttpServer;
              const port = address._tag === "TcpAddress" ? address.port : 0;
              return RpcClient.layerProtocolSocket().pipe(
                Layer.provide(
                  Socket.layerWebSocket(`ws://127.0.0.1:${port}/ws?wsTicket=${ticket.ticket}`).pipe(
                    Layer.provide(
                      Layer.succeed(Socket.WebSocketConstructor, (url, protocols) => {
                        const socket = new WebSocket(url, protocols);
                        socket.addEventListener("close", (event) =>
                          Deferred.doneUnsafe(closed, Effect.succeed(event.code)),
                        );
                        return socket;
                      }),
                    ),
                  ),
                ),
                Layer.provide(RpcSerialization.layerJson),
              );
            }),
          );

          yield* Effect.gen(function* () {
            const received = yield* Effect.gen(function* () {
              const client = yield* RpcClient.make(WsComputerRpcGroup);
              yield* client[COMPUTER_WS_METHODS.getThreadState]({ threadId: watched });
              // The socket is still open, so its handlers must be too.
              expect(yield* Deferred.isDone(handlersReleased)).toBe(false);
              const events = yield* Stream.runCollect(
                client[COMPUTER_WS_METHODS.subscribeEvents]({}),
              );
              if (close === "session revocation") {
                expect(yield* auth.revokeSession(session.sessionId)).toBe(true);
                expect(yield* Deferred.await(closed)).toBe(1008);
                yield* Deferred.await(handlersReleased);
              }
              return events;
            }).pipe(Effect.scoped, Effect.provide(socketClient));

            expect(received).toEqual([events[1]]);
            // Closing the client socket closes the request scope, and the handlers with it.
            yield* Deferred.await(handlersReleased);
          }).pipe(Effect.provide(server));
        }),
      ).pipe(Effect.provide(authLayer)),
  );
});
