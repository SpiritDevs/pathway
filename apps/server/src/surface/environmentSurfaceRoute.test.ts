// @effect-diagnostics nodeBuiltinImport:off - Isolated route integration test.
import * as NodeHttp from "node:http";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ENVIRONMENT_SURFACE_WS_PATH,
  ThreadId,
  PreviewTabId,
  type AuthEnvironmentScope,
} from "@spiritdevs/contracts";
import { Deferred, Effect, Fiber, Layer, Queue, Stream } from "effect";
import * as Socket from "effect/unstable/socket/Socket";
import {
  FetchHttpClient,
  HttpClient,
  HttpRouter,
  HttpServer,
  type HttpServerRequest,
} from "effect/unstable/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { RemoteBrowser, type RemoteBrowserService } from "../preview/RemoteBrowser.ts";
import {
  environmentSurfaceRouteLayer,
  serveEnvironmentSurface,
} from "./environmentSurfaceRoute.ts";
import {
  EnvironmentSurfaceStream,
  SURFACE_SOCKET_BUDGET,
  type SurfaceSink,
} from "./EnvironmentSurfaceStream.ts";

it.effect("streams over writer-only sockets and bounds frames until the client's pong", () =>
  Effect.gen(function* () {
    const incoming = yield* Queue.unbounded<string>();
    const outgoing = yield* Queue.unbounded<Uint8Array | string | Socket.CloseEvent>();
    const subscribed = yield* Deferred.make<SurfaceSink>();
    const released = yield* Deferred.make<void>();
    const pongHandled = yield* Queue.unbounded<void>();
    const writeReady = yield* Deferred.make<void>();
    const socket = Socket.make({
      runRaw: (handler) =>
        Stream.fromQueue(incoming).pipe(
          Stream.runForEach((message) =>
            Effect.gen(function* () {
              const result = handler(message);
              if (Effect.isEffect(result)) yield* result;
              if (message === "pong") yield* Queue.offer(pongHandled, undefined);
            }),
          ),
        ),
      writer: Effect.succeed((message) =>
        Effect.gen(function* () {
          if (message instanceof Uint8Array) yield* Deferred.await(writeReady);
          yield* Queue.offer(outgoing, message);
        }),
      ),
    });
    const browser: RemoteBrowserService = {
      interact: () => Effect.void,
      interactions: () => Stream.empty,
      command: () => Effect.succeed({ tabs: [], selectedTabId: null }),
      frames: () => Stream.empty,
      subscribeSurface: (_input, sink) =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          yield* Deferred.succeed(subscribed, sink);
        }),
    };
    const viewport = { width: 800, height: 600, deviceScale: 1 };
    const running = yield* serveEnvironmentSurface(
      socket,
      {
        ...viewport,
        sizing: "active",
        kind: "browser",
        threadId: ThreadId.make("thread"),
        tabId: PreviewTabId.make("tab"),
      },
      browser,
    ).pipe(Effect.scoped, Effect.forkScoped);
    yield* Queue.offer(incoming, "ready");
    const sink = yield* Deferred.await(subscribed);
    const surface = new EnvironmentSurfaceStream();
    surface.add(sink, viewport);
    const frame = {
      width: 800,
      height: 600,
      deviceScale: 1,
      timestampMs: 0,
      jpeg: new Uint8Array([1, 2, 3]),
    };
    surface.publish({ ...frame, sequence: 1 });
    expect(sink.bufferedAmount()).toBeGreaterThan(SURFACE_SOCKET_BUDGET);
    surface.publish({ ...frame, sequence: 2 });
    surface.publish({ ...frame, sequence: 3 });
    yield* Deferred.succeed(writeReady, undefined);
    expect(yield* Queue.take(outgoing)).toBeInstanceOf(Uint8Array);
    expect(yield* Queue.take(outgoing)).toBe("ping");
    // A synchronous Bun-style write must not clear backpressure before network delivery.
    expect(sink.bufferedAmount()).toBeGreaterThan(SURFACE_SOCKET_BUDGET);
    yield* Queue.offer(incoming, "pong");
    yield* Queue.take(pongHandled);
    expect(sink.bufferedAmount()).toBe(0);
    surface.tick();
    const latest = yield* Queue.take(outgoing);
    expect(latest).toBeInstanceOf(Uint8Array);
    if (latest instanceof Uint8Array)
      expect(new DataView(latest.buffer).getUint32(4, true)).toBe(3);
    expect(yield* Queue.take(outgoing)).toBe("ping");
    sink.close();
    expect(yield* Queue.take(outgoing)).toEqual(new Socket.CloseEvent(1001, "Surface closed"));
    yield* Fiber.interrupt(running);
    yield* Deferred.await(released);
  }).pipe(Effect.scoped),
);
const makeServerLayer = (
  browser: RemoteBrowserService,
  options: { revokeAfterAuthentication?: boolean; afterSnapshot?: Effect.Effect<void> } = {},
) => {
  const baseAuthLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-surface-test-" })),
  );
  const httpLayer = HttpServer.layerTestClient.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );
  const authLayer = Layer.merge(
    Layer.effect(
      EnvironmentAuth.EnvironmentAuth,
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        return {
          ...auth,
          authenticateWebSocketUpgrade: (request: HttpServerRequest.HttpServerRequest) =>
            auth
              .authenticateWebSocketUpgrade(request)
              .pipe(
                Effect.tap((session) =>
                  options.revokeAfterAuthentication
                    ? auth.revokeSession(session.sessionId).pipe(Effect.orDie)
                    : Effect.void,
                ),
              ),
        };
      }),
    ),
    Layer.effect(
      SessionStore,
      Effect.gen(function* () {
        const sessions = yield* SessionStore;
        return {
          ...sessions,
          listActive: () =>
            sessions.listActive().pipe(Effect.tap(() => options.afterSnapshot ?? Effect.void)),
        };
      }),
    ),
  ).pipe(Layer.provide(baseAuthLayer));
  return HttpRouter.serve(environmentSurfaceRouteLayer, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(Layer.succeed(RemoteBrowser, browser)),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(httpLayer),
  );
};

/** A reusable WebSocket ticket for a paired client holding exactly `scopes`. */
const issueTicket = Effect.fn(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const pairing = yield* serverAuth.issuePairingCredential({ scopes });
  const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
    pairing.credential,
    scopes,
    { deviceType: "desktop", os: "macOS", browser: "Chrome", ipAddress: "127.0.0.1" },
  );
  const session = yield* serverAuth.authenticateHttpRequest({
    cookies: {},
    headers: { authorization: `Bearer ${token.access_token}` },
  } as unknown as HttpServerRequest.HttpServerRequest);
  const ticket = yield* serverAuth.issueWebSocketTicket(session);
  return { ticket: ticket.ticket, sessionId: session.sessionId };
});

const framePath = (query: Record<string, string>) =>
  `${ENVIRONMENT_SURFACE_WS_PATH}?${new URLSearchParams(query).toString()}`;

const getStatus = (path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(path);
    return response.status;
  });

it.layer(NodeServices.layer)("environment surface route", (it) => {
  for (const sizing of [undefined, "active", "passive"] as const) {
    it.effect(
      `authenticates, streams ${sizing ?? "default"} sizing and tears down on session revocation`,
      () =>
        Effect.gen(function* () {
          const subscribed = yield* Deferred.make<SurfaceSink>();
          const subscribedInput =
            yield* Deferred.make<Parameters<RemoteBrowserService["subscribeSurface"]>[0]>();
          const released = yield* Deferred.make<void>();
          const browser: RemoteBrowserService = {
            interact: () => Effect.die("unused"),
            interactions: () => Stream.empty,
            command: () => Effect.succeed({ tabs: [], selectedTabId: null }),
            frames: () => Stream.empty,
            subscribeSurface: (input, sink) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
                yield* Deferred.succeed(subscribedInput, input);
                yield* Deferred.succeed(subscribed, sink);
              }),
          };
          yield* Effect.gen(function* () {
            const query = {
              kind: "browser",
              threadId: "thread",
              tabId: "tab",
              width: "800",
              height: "600",
              deviceScale: "2",
              ...(sizing === undefined ? {} : { sizing }),
            };
            expect(yield* getStatus(framePath(query))).toBe(401);
            const denied = yield* issueTicket(["orchestration:operate"]);
            expect(yield* getStatus(framePath({ ...query, wsTicket: denied.ticket }))).toBe(403);
            const { ticket, sessionId } = yield* issueTicket(["orchestration:read"]);
            expect(yield* getStatus(framePath({ ...query, width: "0", wsTicket: ticket }))).toBe(
              400,
            );
            expect(
              yield* getStatus(framePath({ ...query, sizing: "invalid", wsTicket: ticket })),
            ).toBe(400);
            const server = yield* HttpServer.HttpServer;
            if (server.address._tag !== "TcpAddress") throw new Error("TCP required");
            const port = server.address.port;
            const received = yield* Deferred.make<Uint8Array>();
            const closed = yield* Deferred.make<number>();
            yield* Effect.acquireRelease(
              Effect.sync(() => {
                const ws = new WebSocket(
                  `ws://127.0.0.1:${port}${framePath({ ...query, wsTicket: ticket })}`,
                );
                ws.binaryType = "arraybuffer";
                ws.addEventListener("open", () => ws.send("ready"));
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
            const sink = yield* Deferred.await(subscribed);
            expect((yield* Deferred.await(subscribedInput)).sizing).toBe(sizing ?? "active");
            sink.send(new Uint8Array([1, 2, 3]));
            expect(Array.from(yield* Deferred.await(received))).toEqual([1, 2, 3]);
            const auth = yield* EnvironmentAuth.EnvironmentAuth;
            yield* auth.revokeSession(sessionId);
            expect(yield* Deferred.await(closed)).toBe(1008);
            yield* Deferred.await(released);
          }).pipe(Effect.provide(makeServerLayer(browser)));
        }),
    );
  }
});
