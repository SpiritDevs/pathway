// @effect-diagnostics nodeBuiltinImport:off -- the route is served on a real loopback socket.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  COMPUTER_FRAME_RESYNC_MESSAGE,
  COMPUTER_FRAME_WS_COMPUTER_ID_PARAM,
  COMPUTER_FRAME_WS_PATH,
  type AuthEnvironmentScope,
  type ComputerId,
} from "@spiritdevs/contracts";
import type { FrameSink } from "@spiritdevs/shared/frameTransport";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
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
import type { ComputerManager } from "./ComputerManager.ts";
import {
  computerFrameRouteLayer,
  decodeResyncRequest,
  makeComputerFrameSink,
} from "./computerFrameRoute.ts";
import { ComputerService, type ComputerServiceShape } from "./Services/ComputerService.ts";

describe("computer frame socket messages", () => {
  it("recognizes text and binary resync messages", () => {
    const message = JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE });
    expect(decodeResyncRequest(message)).toBe("resync");
    expect(decodeResyncRequest(new TextEncoder().encode(message))).toBe("resync");
  });

  it("ignores malformed, unrelated, and oversized messages", () => {
    expect(decodeResyncRequest("not json")).toBeNull();
    expect(decodeResyncRequest(JSON.stringify({ type: "other" }))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(["resync"]))).toBeNull();
    expect(decodeResyncRequest(JSON.stringify(null))).toBeNull();
    expect(
      decodeResyncRequest(
        JSON.stringify({ type: COMPUTER_FRAME_RESYNC_MESSAGE, x: "x".repeat(2_000) }),
      ),
    ).toBeNull();
  });
});

describe("computer frame socket sink", () => {
  it.effect("accounts for bytes until a write settles", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      let settle: (() => void) | undefined;
      const sink = makeComputerFrameSink({
        send: () =>
          new Promise<void>((resolve) => {
            settle = resolve;
          }),
        isOpen: () => true,
      });
      sink.onWritable?.(() => Deferred.doneUnsafe(settled, Effect.void));
      sink.send(new Uint8Array(128));
      expect(sink.bufferedAmount()).toBe(128);
      settle?.();
      yield* Deferred.await(settled);
      expect(sink.bufferedAmount()).toBe(0);
    }),
  );

  it.effect("clears the backlog when a write fails", () =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      const sink = makeComputerFrameSink({
        send: () => Promise.reject(new Error("socket gone")),
        isOpen: () => true,
      });
      sink.onWritable?.(() => Deferred.doneUnsafe(settled, Effect.void));
      sink.send(new Uint8Array(64));
      yield* Deferred.await(settled);
      expect(sink.bufferedAmount()).toBe(0);
    }),
  );

  it("reports a closed connection to the shared transport", () => {
    let open = true;
    const sink = makeComputerFrameSink({ send: () => undefined, isOpen: () => open });
    expect(sink.isOpen()).toBe(true);
    open = false;
    expect(sink.isOpen()).toBe(false);
  });
});

const COMPUTER_ID = "computer-test" as ComputerId;

interface FakeManagerProbe {
  readonly subscribed: Deferred.Deferred<FrameSink>;
  /** Resolves with the sink's `isOpen()` at the moment the route removes it. */
  readonly unsubscribed: Deferred.Deferred<boolean>;
  readonly subscriptions: Queue.Queue<{ sink: FrameSink; released: Deferred.Deferred<boolean> }>;
  readonly keyframeRequests: Queue.Queue<void>;
}

const makeFakeComputerService = Effect.fn(function* (
  supported = true,
  subscribe: Effect.Effect<void> = Effect.void,
) {
  const probe: FakeManagerProbe = {
    subscribed: yield* Deferred.make<FrameSink>(),
    unsubscribed: yield* Deferred.make<boolean>(),
    subscriptions: yield* Queue.unbounded<{
      sink: FrameSink;
      released: Deferred.Deferred<boolean>;
    }>(),
    keyframeRequests: yield* Queue.unbounded<void>(),
  };
  const manager = {
    computerId: COMPUTER_ID,
    subscribeFrames: (sink: FrameSink) =>
      Effect.gen(function* () {
        const released = yield* Deferred.make<boolean>();
        yield* Effect.addFinalizer(() => Deferred.succeed(released, sink.isOpen()));
        yield* Effect.addFinalizer(() => Deferred.succeed(probe.unsubscribed, sink.isOpen()));
        yield* Deferred.succeed(probe.subscribed, sink);
        yield* Queue.offer(probe.subscriptions, { sink, released });
        yield* subscribe;
      }),
    requestKeyframe: () => Queue.offer(probe.keyframeRequests, undefined).pipe(Effect.asVoid),
  } as unknown as ComputerManager;
  const service: ComputerServiceShape = {
    supported,
    availability: { kind: "available" } as ComputerServiceShape["availability"],
    manager,
  };
  return { service, probe };
});

const makeServerLayer = (
  computerService?: ComputerServiceShape,
  options: { revokeAfterAuthentication?: boolean; afterSnapshot?: Effect.Effect<void> } = {},
) => {
  const baseAuthLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "pathway-computer-frame-test-" }),
    ),
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
  return HttpRouter.serve(computerFrameRouteLayer, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(computerService ? Layer.succeed(ComputerService, computerService) : Layer.empty),
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
  `${COMPUTER_FRAME_WS_PATH}?${new URLSearchParams(query).toString()}`;

const getStatus = (path: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(path);
    return response.status;
  });

const openFrameSocket = Effect.fn(function* (ticket: string) {
  const server = yield* HttpServer.HttpServer;
  if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP address");
  const port = server.address.port;
  const path = framePath({ wsTicket: ticket, [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID });
  const closed = yield* Deferred.make<number>();
  const received = yield* Deferred.make<Uint8Array>();
  const socket = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
      ws.binaryType = "arraybuffer";
      ws.addEventListener("close", (event) =>
        Deferred.doneUnsafe(closed, Effect.succeed(event.code)),
      );
      ws.addEventListener("message", (event) =>
        Deferred.doneUnsafe(received, Effect.succeed(new Uint8Array(event.data as ArrayBuffer))),
      );
      return ws;
    }),
    (ws) => Effect.sync(() => ws.close()),
  );
  return { socket, closed, received, path };
});

it.layer(NodeServices.layer)("computer frame route", (it) => {
  it.effect("streams frames to a watcher, relays resync, and unsubscribes on close", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const { ticket } = yield* issueTicket(["orchestration:read"]);
        const server = yield* HttpServer.HttpServer;
        if (server.address._tag !== "TcpAddress") throw new Error("expected a TCP address");
        const url = `ws://127.0.0.1:${server.address.port}${framePath({
          wsTicket: ticket,
          [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID,
        })}`;

        const received = yield* Deferred.make<Uint8Array>();
        const socket = yield* Effect.acquireRelease(
          Effect.sync(() => {
            const socket = new WebSocket(url);
            socket.binaryType = "arraybuffer";
            socket.addEventListener("message", (event) => {
              Deferred.doneUnsafe(
                received,
                Effect.succeed(new Uint8Array(event.data as ArrayBuffer)),
              );
            });
            return socket;
          }),
          (socket) => Effect.sync(() => socket.close()),
        );

        const sink = yield* Deferred.await(probe.subscribed);
        expect(sink.isOpen()).toBe(true);
        sink.send(new Uint8Array([1, 2, 3]));
        expect(Array.from(yield* Deferred.await(received))).toEqual([1, 2, 3]);

        // Garbage is ignored; the resync after it is the only keyframe request.
        socket.send("not json");
        socket.send(`{"type":"${COMPUTER_FRAME_RESYNC_MESSAGE}"}`);
        yield* Queue.take(probe.keyframeRequests);

        socket.close();
        // The sink reports closed before the manager drops it and detaches the stream.
        expect(yield* Deferred.await(probe.unsubscribed)).toBe(false);
        expect(yield* Queue.size(probe.keyframeRequests)).toBe(0);
      }).pipe(Effect.provide(makeServerLayer(service)));
    }),
  );

  it.effect("closes a revoked viewer with 1008 and releases its frame sink", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const { ticket, sessionId } = yield* issueTicket(["orchestration:read"]);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const { closed, received, path } = yield* openFrameSocket(ticket);
        const { sink, released } = yield* Queue.take(probe.subscriptions);
        sink.send(new Uint8Array([1, 2, 3]));
        expect(Array.from(yield* Deferred.await(received))).toEqual([1, 2, 3]);
        expect(yield* auth.revokeSession(sessionId)).toBe(true);
        expect(yield* getStatus(path)).toBe(401);
        expect(yield* Deferred.await(closed)).toBe(1008);
        expect(yield* Deferred.await(released)).toBe(false);
        expect(sink.isOpen()).toBe(false);
      }).pipe(Effect.provide(makeServerLayer(service)));
    }),
  );

  it.effect("refuses a session removed after authentication before admitting a frame sink", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const { ticket } = yield* issueTicket(["orchestration:read"]);
        const status = yield* getStatus(
          framePath({ wsTicket: ticket, [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID }),
        );
        expect(status).toBe(401);
        expect(Deferred.isDoneUnsafe(probe.subscribed)).toBe(false);
      }).pipe(
        Effect.provide(
          makeServerLayer(service, {
            revokeAfterAuthentication: true,
          }),
        ),
      );
    }),
  );

  it.effect("retains a revocation racing the admission snapshot", () =>
    Effect.gen(function* () {
      const snapshotRead = yield* Deferred.make<void>();
      const resumeSnapshot = yield* Deferred.make<void>();
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const { ticket, sessionId } = yield* issueTicket(["orchestration:read"]);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const { closed } = yield* openFrameSocket(ticket);
        yield* Deferred.await(snapshotRead);
        expect(yield* auth.revokeSession(sessionId)).toBe(true);
        yield* Deferred.succeed(resumeSnapshot, undefined);
        expect(yield* Deferred.await(closed)).toBe(1008);
        expect(yield* Deferred.await(probe.unsubscribed)).toBe(false);
      }).pipe(
        Effect.provide(
          makeServerLayer(service, {
            afterSnapshot: Deferred.succeed(snapshotRead, undefined).pipe(
              Effect.andThen(Deferred.await(resumeSnapshot)),
            ),
          }),
        ),
      );
    }),
  );

  it.effect("releases a frame sink when revocation interrupts subscription setup", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService(true, Effect.never);
      yield* Effect.gen(function* () {
        const { ticket, sessionId } = yield* issueTicket(["orchestration:read"]);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const { closed } = yield* openFrameSocket(ticket);
        yield* Deferred.await(probe.subscribed);
        expect(yield* auth.revokeSession(sessionId)).toBe(true);
        expect(yield* Deferred.await(closed)).toBe(1008);
        expect(yield* Deferred.await(probe.unsubscribed)).toBe(false);
      }).pipe(Effect.provide(makeServerLayer(service)));
    }),
  );

  it.effect("revoking one viewer leaves the other attached and receiving frames", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const firstSession = yield* issueTicket(["orchestration:read"]);
        const secondSession = yield* issueTicket(["orchestration:read"]);
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const first = yield* openFrameSocket(firstSession.ticket);
        const firstSubscription = yield* Queue.take(probe.subscriptions);
        const second = yield* openFrameSocket(secondSession.ticket);
        const secondSubscription = yield* Queue.take(probe.subscriptions);
        expect(yield* auth.revokeSession(firstSession.sessionId)).toBe(true);
        expect(yield* Deferred.await(first.closed)).toBe(1008);
        expect(yield* Deferred.await(firstSubscription.released)).toBe(false);
        expect(secondSubscription.sink.isOpen()).toBe(true);
        expect(Deferred.isDoneUnsafe(secondSubscription.released)).toBe(false);
        secondSubscription.sink.send(new Uint8Array([7, 8, 9]));
        expect(Array.from(yield* Deferred.await(second.received))).toEqual([7, 8, 9]);
        second.socket.send(`{"type":"${COMPUTER_FRAME_RESYNC_MESSAGE}"}`);
        yield* Queue.take(probe.keyframeRequests);
        second.socket.close();
        expect(yield* Deferred.await(secondSubscription.released)).toBe(false);
      }).pipe(Effect.provide(makeServerLayer(service)));
    }),
  );

  it.effect("refuses watchers without a credential or orchestration:read", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        expect(
          yield* getStatus(framePath({ [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID })),
        ).toBe(401);
        const { ticket } = yield* issueTicket(["terminal:operate"]);
        expect(
          yield* getStatus(
            framePath({ wsTicket: ticket, [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID }),
          ),
        ).toBe(403);
      }).pipe(Effect.provide(makeServerLayer(service)));
      expect(Deferred.isDoneUnsafe(probe.subscribed)).toBe(false);
    }),
  );

  it.effect("answers 404 when this host cannot stream a computer", () =>
    Effect.gen(function* () {
      const { service } = yield* makeFakeComputerService(false);
      for (const layer of [makeServerLayer(), makeServerLayer(service)]) {
        yield* Effect.gen(function* () {
          const { ticket } = yield* issueTicket(["orchestration:read"]);
          expect(
            yield* getStatus(
              framePath({ wsTicket: ticket, [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: COMPUTER_ID }),
            ),
          ).toBe(404);
        }).pipe(Effect.provide(layer));
      }
    }),
  );

  it.effect("rejects a missing or unknown computer id", () =>
    Effect.gen(function* () {
      const { service, probe } = yield* makeFakeComputerService();
      yield* Effect.gen(function* () {
        const { ticket: missing } = yield* issueTicket(["orchestration:read"]);
        expect(yield* getStatus(framePath({ wsTicket: missing }))).toBe(400);
        const { ticket: unknown } = yield* issueTicket(["orchestration:read"]);
        expect(
          yield* getStatus(
            framePath({ wsTicket: unknown, [COMPUTER_FRAME_WS_COMPUTER_ID_PARAM]: "other" }),
          ),
        ).toBe(404);
      }).pipe(Effect.provide(makeServerLayer(service)));
      expect(Deferred.isDoneUnsafe(probe.subscribed)).toBe(false);
    }),
  );
});
