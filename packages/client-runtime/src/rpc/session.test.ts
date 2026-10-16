import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ServerConfig,
  type ServerConfig as ServerConfigType,
  WS_METHODS,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/unstable/socket/Socket";

import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as RpcSession from "./session.ts";

type SocketEventType = "open" | "message" | "close" | "error";
type SocketEvent = {
  readonly code?: number;
  readonly data?: unknown;
  readonly reason?: string;
  readonly type: SocketEventType;
};
type SocketListener = (event: SocketEvent) => void;

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TestWebSocket.CONNECTING;
  readonly sent: string[] = [];
  readonly url: string;
  private readonly listeners = new Map<SocketEventType, Set<SocketListener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: SocketEventType, listener: SocketListener) {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: SocketEventType, listener: SocketListener) {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code = 1000, reason = "") {
    if (this.readyState === TestWebSocket.CLOSED) {
      return;
    }
    this.readyState = TestWebSocket.CLOSED;
    this.emit("close", { code, reason, type: "close" });
  }

  open() {
    this.readyState = TestWebSocket.OPEN;
    this.emit("open", { type: "open" });
  }

  serverMessage(data: string) {
    this.emit("message", { data, type: "message" });
  }

  fail() {
    this.emit("error", { type: "error" });
  }

  private emit(type: SocketEventType, event: SocketEvent) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws?wsTicket=test",
  httpAuthorization: null,
  target: TARGET,
};

const SERVER_CONFIG: ServerConfigType = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: {
      os: "darwin",
      arch: "arm64",
    },
    serverVersion: "0.0.0-test",
    capabilities: {
      repositoryIdentity: true,
      connectionProbe: true,
    },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "pathway_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/workspace/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
};

const RpcRequest = Schema.TaggedStruct("Request", {
  id: Schema.Union([Schema.String, Schema.Number]),
  payload: Schema.Unknown,
  tag: Schema.String,
});
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeRpcRequest = Schema.decodeUnknownSync(RpcRequest);
const isRpcRequest = Schema.is(RpcRequest);
const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeServerConfig = Schema.encodeSync(ServerConfig);
const ENCODED_SERVER_CONFIG = encodeServerConfig(SERVER_CONFIG);
const LEGACY_SERVER_CONFIG = {
  ...ENCODED_SERVER_CONFIG,
  environment: {
    ...ENCODED_SERVER_CONFIG.environment,
    capabilities: {
      repositoryIdentity: true,
    },
  },
};

const makeFactory = Effect.fn("TestRpcSessionFactory.make")(function* () {
  const sockets: TestWebSocket[] = [];
  const constructorLayer = Layer.succeed(Socket.WebSocketConstructor, (url) => {
    const socket = new TestWebSocket(url);
    sockets.push(socket);
    return socket as unknown as globalThis.WebSocket;
  });
  const layer = RpcSession.layer.pipe(Layer.provide(constructorLayer));
  const factory = yield* RpcSession.RpcSessionFactory.pipe(Effect.provide(layer));
  return { factory, sockets };
});

const awaitSocket = Effect.fn("TestRpcSessionFactory.awaitSocket")(function* (
  sockets: ReadonlyArray<TestWebSocket>,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const socket = sockets[0];
    if (socket) {
      return socket;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to create a websocket."));
});

const awaitRequest = Effect.fn("TestRpcSessionFactory.awaitRequest")(function* (
  socket: TestWebSocket,
  index = 0,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const request = socket.sent[index];
    if (request) {
      return decodeRpcRequest(decodeJson(request));
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error("Expected the RPC protocol to send a request."));
});

const awaitNewRequest = Effect.fn("TestRpcSessionFactory.awaitNewRequest")(function* (
  socket: TestWebSocket,
  tag: string,
  fromIndex: number,
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    for (const sent of socket.sent.slice(fromIndex)) {
      const message = decodeJson(sent);
      if (isRpcRequest(message) && message.tag === tag) {
        return message;
      }
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(new Error(`Expected the RPC protocol to send ${tag}.`));
});

const completeInitialConfig = Effect.fn("TestRpcSessionFactory.completeInitialConfig")(function* (
  socket: TestWebSocket,
  config: unknown = ENCODED_SERVER_CONFIG,
) {
  const request = yield* awaitRequest(socket);
  expect(request).toMatchObject({
    _tag: "Request",
    tag: WS_METHODS.serverGetConfig,
    payload: {},
  });
  socket.serverMessage(
    encodeJson({
      _tag: "Exit",
      requestId: request.id,
      exit: {
        _tag: "Success",
        value: config,
      },
    }),
  );
});

describe("RpcSessionFactory", () => {
  it.effect("owns one scoped websocket attempt and exposes readiness and closure", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      expect(socket.url).toBe(PREPARED.socketUrl);
      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config).toEqual(SERVER_CONFIG);
      expect(socket.sent).toHaveLength(1);

      const probeFiber = yield* Effect.forkChild(session.probe);
      const probeRequest = yield* awaitRequest(socket, 1);
      expect(probeRequest).toMatchObject({
        _tag: "Request",
        tag: WS_METHODS.serverProbe,
        payload: {},
      });
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: probeRequest.id,
          exit: {
            _tag: "Success",
            value: {},
          },
        }),
      );
      yield* Fiber.join(probeFiber);

      expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverProbe,
      ]);

      socket.close(1012, "service restart");
      const error = yield* Effect.flip(session.closed);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      yield* Effect.yieldNow;
      expect(sockets).toHaveLength(1);
    }),
  );

  it.effect("closes the websocket when the session scope is released", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(session.ready);
          const socket = yield* awaitSocket(sockets);
          socket.open();
          yield* completeInitialConfig(socket);
          yield* Fiber.join(readyFiber);
        }),
      );

      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }),
  );

  it.effect("tolerates two missed pong windows before closing the session", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      yield* TestClock.adjust("15 seconds");
      expect(closedFiber.pollUnsafe()).toBeUndefined();
      expect(socket.sent.slice(1).map((request) => decodeJson(request))).toEqual([
        { _tag: "Ping" },
        { _tag: "Ping" },
        { _tag: "Ping" },
      ]);

      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(closedFiber);
      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({ reason: "transport" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a session alive while unary responses arrive without pongs", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      for (let index = 0; index < 10; index += 1) {
        yield* TestClock.adjust("4 seconds");
        const sentBefore = socket.sent.length;
        const probeFiber = yield* Effect.forkChild(session.probe);
        const request = yield* awaitNewRequest(socket, WS_METHODS.serverProbe, sentBefore);
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: request.id,
            exit: { _tag: "Success", value: {} },
          }),
        );
        yield* Fiber.join(probeFiber);
      }
      expect(closedFiber.pollUnsafe()).toBeUndefined();

      // Silence after the last response still closes within the finite deadline.
      yield* TestClock.adjust("15 seconds");
      expect(closedFiber.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("5 seconds");
      const error = yield* Fiber.join(closedFiber);
      expect(error).toMatchObject({ reason: "transport" });
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a session alive while stream chunks arrive without pongs", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      const received: unknown[] = [];
      yield* Effect.forkChild(
        Stream.runForEach(session.client[WS_METHODS.subscribeServerConfig]({}), (event) =>
          Effect.sync(() => received.push(event)),
        ),
      );
      const request = yield* awaitNewRequest(socket, WS_METHODS.subscribeServerConfig, 1);

      for (let index = 0; index < 10; index += 1) {
        yield* TestClock.adjust("4 seconds");
        socket.serverMessage(
          encodeJson({
            _tag: "Chunk",
            requestId: request.id,
            values: [{ version: 1, type: "snapshot", config: ENCODED_SERVER_CONFIG }],
          }),
        );
        yield* Effect.yieldNow;
      }
      expect(received).toHaveLength(10);
      expect(closedFiber.pollUnsafe()).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("closes a silent session exactly once", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const closedFiber = yield* Effect.forkChild(Effect.flip(session.closed));
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      yield* TestClock.adjust("20 seconds");
      const error = yield* Fiber.join(closedFiber);
      expect(error).toMatchObject({ reason: "transport" });

      yield* TestClock.adjust("1 minute");
      expect(yield* Effect.flip(session.closed)).toBe(error);
      expect(sockets).toHaveLength(1);
      expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("closes immediately on a socket error", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);

      socket.open();
      yield* completeInitialConfig(socket);
      yield* Fiber.join(readyFiber);

      socket.fail();
      const error = yield* Effect.flip(session.closed);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment disconnected.",
      });
      expect(socket.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("reaches ready when a newer server sends unknown config members", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const readyFiber = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();

      const shortcut = {
        key: "p",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        modKey: true,
      };
      yield* completeInitialConfig(socket, {
        ...ENCODED_SERVER_CONFIG,
        keybindings: [
          { command: "someFuture.toggle", shortcut },
          { command: "terminal.toggle", shortcut },
        ],
        issues: [{ kind: "keybindings.future-issue", message: "From a newer server" }],
        availableEditors: ["some-future-editor", "zed"],
      });
      yield* Fiber.join(readyFiber);

      const config = yield* session.initialConfig;
      expect(config.keybindings).toEqual([{ command: "terminal.toggle", shortcut }]);
      expect(config.issues).toEqual([]);
      expect(config.availableEditors).toEqual(["zed"]);
    }),
  );

  it.effect("uses the legacy config RPC for probes when the server lacks the capability", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { factory, sockets } = yield* makeFactory();
        const session = yield* factory.connect(PREPARED);
        const readyFiber = yield* Effect.forkChild(session.ready);
        const socket = yield* awaitSocket(sockets);

        socket.open();
        yield* completeInitialConfig(socket, LEGACY_SERVER_CONFIG);
        yield* Fiber.join(readyFiber);

        const probeFiber = yield* Effect.forkChild(session.probe);
        const probeRequest = yield* awaitRequest(socket, 1);
        expect(probeRequest).toMatchObject({
          _tag: "Request",
          tag: WS_METHODS.serverGetConfig,
          payload: {},
        });
        socket.serverMessage(
          encodeJson({
            _tag: "Exit",
            requestId: probeRequest.id,
            exit: {
              _tag: "Success",
              value: LEGACY_SERVER_CONFIG,
            },
          }),
        );
        yield* Fiber.join(probeFiber);

        expect(socket.sent.map((request) => decodeRpcRequest(decodeJson(request)).tag)).toEqual([
          WS_METHODS.serverGetConfig,
          WS_METHODS.serverGetConfig,
        ]);
      }),
    ),
  );

  it.effect("fails readiness when the websocket never opens", () =>
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();

      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const session = yield* factory.connect(PREPARED);
          const readyFiber = yield* Effect.forkChild(Effect.flip(session.ready));
          yield* awaitSocket(sockets);

          yield* TestClock.adjust("15 seconds");
          return yield* Fiber.join(readyFiber);
        }),
      );

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error).toMatchObject({
        reason: "transport",
        message: "Test environment could not establish a WebSocket connection.",
      });
      expect(sockets[0]?.readyState).toBe(TestWebSocket.CLOSED);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
