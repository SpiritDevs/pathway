// @effect-diagnostics preferSchemaOverJson:off - these tests construct and inspect the exact vendor wire format.
import * as DeviceControl from "./DeviceControl.ts";
// @effect-diagnostics nodeBuiltinImport:off - test-only loopback HTTP servers exercise real binary upgrades.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
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

const makeHub = Effect.fn("deviceProxySocket.makeHub")(function* (
  onInput: (packet: string | Uint8Array) => Effect.Effect<void> = () => Effect.void,
) {
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
              Effect.gen(function* () {
                if (typeof message === "string") {
                  yield* Deferred.succeed(input, new TextEncoder().encode(message));
                  yield* onInput(message);
                  yield* write('{"ok":true}');
                } else {
                  const payload = JSON.parse(Buffer.from(message.subarray(1)).toString());
                  const packet = Buffer.from(payload.packet, "base64");
                  yield* Deferred.succeed(input, packet);
                  yield* onInput(packet);
                  yield* write(
                    Buffer.concat([
                      Buffer.from([254]),
                      Buffer.from(JSON.stringify({ id: payload.id, ok: true })),
                    ]),
                  );
                }
                yield* write(new Uint8Array([77]));
              }),
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

const makeProxy = (origin: string, control: DeviceControl.DeviceControl) =>
  HttpRouter.serve(deviceHubProxyRouteLayer, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(
      Layer.succeed(DeviceService, {
        control,
        claimDevice: () => Effect.void,
        currentReadiness: () => Effect.succeed({ hostId: "remote-mac", hub: { origin } }),
      } as unknown as DeviceService["Service"]),
    ),
    Layer.provideMerge(authLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );

it.layer(NodeServices.layer)("device proxy sockets", (it) => {
  for (const platform of ["ios", "android"] as const) {
    it.effect(
      `revocation drains held ${platform} input before disconnecting its receipt reader`,
      () =>
        Effect.gen(function* () {
          const cleanupStarted = yield* Deferred.make<void>();
          const cleanupDone = yield* Deferred.make<void>();
          const packets: object[] = [];
          const hub = yield* makeHub((packet) =>
            Effect.gen(function* () {
              const value = JSON.parse(
                typeof packet === "string" ? packet : Buffer.from(packet.subarray(1)).toString(),
              );
              packets.push(value);
              if (value.type === "up" || value.action === "up") {
                yield* Deferred.succeed(cleanupStarted, undefined);
                yield* Deferred.await(cleanupDone);
              }
            }),
          );
          const control = yield* DeviceControl.make();
          yield* Effect.gen(function* () {
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            const session = yield* auth.issueSession({
              scopes: ["orchestration:read", "orchestration:operate"],
            });
            const target = { hostId: "remote-mac", deviceId: "phone" };
            const owner = {
              kind: "viewer" as const,
              sessionId: session.sessionId,
              viewerId: "viewer",
            };
            const held = yield* control.acquire(target, owner);
            const ticket = yield* auth.issueWebSocketTicket(session);
            const server = yield* HttpServer.HttpServer;
            const received = yield* Deferred.make<void>();
            const downAcknowledged = yield* Deferred.make<void>();
            const closed = yield* Deferred.make<number>();
            const path =
              platform === "ios" ? "/vendor/serve-sim/helper/ws" : "/vendor/serve-emu/ws";
            const socket = yield* Effect.acquireRelease(
              Effect.sync(() => {
                const ws = new WebSocket(
                  `ws://127.0.0.1:${portOf(server)}/api/device-hub${path}?hostId=remote-mac&device=phone&viewerId=viewer&controlGeneration=${held.generation}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
                );
                ws.binaryType = "arraybuffer";
                ws.addEventListener("message", (event) => {
                  Deferred.doneUnsafe(received, Effect.void);
                  if (new Uint8Array(event.data as ArrayBuffer)[0] === 77)
                    Deferred.doneUnsafe(downAcknowledged, Effect.void);
                });
                ws.addEventListener("error", (event) =>
                  Deferred.doneUnsafe(received, Effect.die(event)),
                );
                ws.addEventListener("close", (event) =>
                  Deferred.doneUnsafe(closed, Effect.succeed(event.code)),
                );
                return ws;
              }),
              (ws) => Effect.sync(() => ws.close()),
            );
            yield* Deferred.await(received);
            const down =
              platform === "ios"
                ? { type: "down", usage: 42 }
                : { type: "touch", action: "down", x: 0.1, y: 0.2, pointerId: 7 };
            socket.send(
              platform === "ios"
                ? Buffer.concat([Buffer.from([6]), Buffer.from(JSON.stringify(down))])
                : JSON.stringify(down),
            );
            yield* Deferred.await(downAcknowledged);
            yield* auth.revokeSession(session.sessionId);
            expect(yield* Deferred.await(closed)).toBe(1008);
            yield* Deferred.await(cleanupStarted);
            let acquired = false;
            const takeover = yield* control
              .acquire(target, { ...owner, sessionId: "other", viewerId: "next" })
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    acquired = true;
                  }),
                ),
                Effect.forkChild({ startImmediately: true }),
              );
            expect(acquired).toBe(false);
            expect((yield* control.state)[0]?.phase).toBe("draining");
            yield* Deferred.succeed(cleanupDone, undefined);
            expect((yield* Fiber.join(takeover)).phase).toBe("held");
            yield* Deferred.await(hub.disconnected);
            expect(packets).toEqual(
              [
                down,
                platform === "ios"
                  ? { type: "up", usage: 42 }
                  : { ...down, action: "up", ack: true },
              ].map((packet) => (platform === "android" ? { ...packet, ack: true } : packet)),
            );
          }).pipe(Effect.provide(makeProxy(hub.origin, control)));
        }),
    );
  }
  it.effect("an Android read-only watcher receives video while its input is rejected", () =>
    Effect.gen(function* () {
      const hub = yield* makeHub();
      const control = yield* DeviceControl.make();
      yield* Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const session = yield* auth.issueSession({ scopes: ["orchestration:read"] });
        const ticket = yield* auth.issueWebSocketTicket(session);
        const server = yield* HttpServer.HttpServer;
        const received = yield* Deferred.make<Uint8Array>();
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const ws = new WebSocket(
              `ws://127.0.0.1:${portOf(server)}/api/device-hub/vendor/serve-emu/ws?hostId=remote-mac&device=phone&wsTicket=${encodeURIComponent(ticket.ticket)}`,
            );
            ws.binaryType = "arraybuffer";
            ws.addEventListener("error", (event) =>
              Deferred.doneUnsafe(received, Effect.die(event)),
            );
            ws.addEventListener("message", (event) =>
              Deferred.doneUnsafe(
                received,
                Effect.succeed(new Uint8Array(event.data as ArrayBuffer)),
              ),
            );
            return ws;
          }),
          (ws) => Effect.sync(() => ws.close()),
        );
        expect([...(yield* Deferred.await(received))]).toEqual([0, 255, 42]);
        socket.send('{"type":"back"}');
        socket.send('{"type":"reset-video","ack":true}');
        // The reset receipt is an ordering barrier after the rejected input.
        expect(JSON.parse(new TextDecoder().decode(yield* Deferred.await(hub.input)))).toEqual({
          type: "reset-video",
          ack: false,
        });
        expect(socket.readyState).toBe(WebSocket.OPEN);
        expect(yield* control.state).toEqual([]);
        socket.close();
        yield* Deferred.await(hub.disconnected);
      }).pipe(Effect.provide(makeProxy(hub.origin, control)));
    }),
  );
  for (const path of ["/vendor/serve-sim/helper/ws", "/vendor/serve-emu/ws"]) {
    it.effect(`relays binary media and input at ${path}, then closes on session revocation`, () =>
      Effect.gen(function* () {
        const hub = yield* makeHub();
        const control = yield* DeviceControl.make();
        yield* Effect.gen(function* () {
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const session = yield* auth.issueSession({
            scopes: ["orchestration:read", "orchestration:operate"],
          });
          const held = yield* control.acquire(
            { hostId: "remote-mac", deviceId: "phone" },
            { kind: "viewer", sessionId: session.sessionId, viewerId: "viewer-one" },
          );
          const ticket = yield* auth.issueWebSocketTicket(session);
          const server = yield* HttpServer.HttpServer;
          const received = yield* Deferred.make<Uint8Array>();
          const closed = yield* Deferred.make<number>();
          const socket = yield* Effect.acquireRelease(
            Effect.sync(() => {
              const ws = new WebSocket(
                `ws://127.0.0.1:${portOf(server)}/api/device-hub${path}?hostId=remote-mac&device=phone&viewerId=viewer-one&controlGeneration=${held.generation}&wsTicket=${encodeURIComponent(ticket.ticket)}`,
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
          const packet = path.includes("serve-emu") ? '{"type":"back"}' : new Uint8Array([9]);
          socket.send(packet);
          const forwarded = yield* Deferred.await(hub.input);
          if (typeof packet === "string")
            expect(JSON.parse(new TextDecoder().decode(forwarded))).toEqual({
              type: "back",
              ack: true,
            });
          else expect([...forwarded]).toEqual([9]);
          expect(hub.requests).toEqual([`${path}?device=phone`]);
          yield* auth.revokeSession(session.sessionId);
          expect(yield* Deferred.await(closed)).toBe(1008);
          yield* Deferred.await(hub.disconnected);
        }).pipe(Effect.provide(makeProxy(hub.origin, control)));
      }),
    );
  }
});
