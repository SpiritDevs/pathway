// @effect-diagnostics nodeBuiltinImport:off -- the route is served on a real loopback socket.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import {
  DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH,
  desktopComputerEmergencyStopRouteLayer,
  isDesktopEmergencyStopAvailable,
} from "./computerEmergencyStopRoute.ts";
import { ComputerService, type ComputerServiceShape } from "./Services/ComputerService.ts";

const DESKTOP_BOOTSTRAP_TOKEN = "desktop-bootstrap-token";

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Electron",
  ipAddress: "127.0.0.1",
};

const makeComputerService = (onStop: () => void): ComputerServiceShape => ({
  supported: true,
  availability: { kind: "available" } as ComputerServiceShape["availability"],
  manager: {
    emergencyStopInput: () => Effect.sync(onStop),
  } as unknown as ComputerManager,
});

/** The real auth stack and the route, served on loopback with a client bound to it. */
const makeServerLayer = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]>,
  computerService?: ComputerServiceShape,
) => {
  const configLayer = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return { ...config, ...overrides } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "pathway-computer-emergency-stop-test-" }),
    ),
  );
  const authLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provideMerge(configLayer),
  );
  const computerLayer = computerService
    ? Layer.succeed(ComputerService, computerService)
    : Layer.empty;
  const httpLayer = HttpServer.layerTestClient.pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
  );
  return HttpRouter.serve(desktopComputerEmergencyStopRouteLayer, {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provide(computerLayer),
    Layer.provideMerge(authLayer),
    Layer.provideMerge(httpLayer),
  );
};

const postEmergencyStop = (
  options: {
    readonly authorization?: string;
    readonly cookie?: string;
    readonly query?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    let request = HttpClientRequest.post(
      `${DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH}${options.query ?? ""}`,
    );
    if (options.authorization) {
      request = HttpClientRequest.setHeader(request, "authorization", options.authorization);
    }
    if (options.cookie) {
      request = HttpClientRequest.setHeader(request, "cookie", options.cookie);
    }
    const response = yield* client.execute(request);
    const body = yield* response.json;
    return { status: response.status, body };
  });

/** The desktop's own session: the bearer it exchanges from its bootstrap credential. */
const exchangeDesktopBearer = Effect.gen(function* () {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const token = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
    DESKTOP_BOOTSTRAP_TOKEN,
    undefined,
    requestMetadata,
  );
  return token.access_token;
});

it.layer(NodeServices.layer)("desktop computer emergency-stop route", (it) => {
  it.effect("relays an authenticated desktop emergency stop into the computer manager", () => {
    let stopCalls = 0;
    return Effect.gen(function* () {
      const bearer = yield* exchangeDesktopBearer;
      // Repeated presses stay idempotent: each relay re-confirms the stop.
      for (let requestIndex = 0; requestIndex < 2; requestIndex += 1) {
        const response = yield* postEmergencyStop({ authorization: `Bearer ${bearer}` });
        expect(response.status).toBe(202);
        expect(response.body).toEqual({ accepted: true });
      }
      expect(stopCalls).toBe(2);
    }).pipe(
      Effect.provide(
        makeServerLayer(
          { mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
          makeComputerService(() => {
            stopCalls += 1;
          }),
        ),
      ),
    );
  });

  it.effect("refuses the emergency-stop route to browser authority and wrong tokens", () => {
    let stopCalls = 0;
    return Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const desktopBearer = yield* exchangeDesktopBearer;
      // A browser holding the same desktop grant gets a cookie, never the relay.
      const browser = yield* serverAuth.createBrowserSession(
        DESKTOP_BOOTSTRAP_TOKEN,
        requestMetadata,
      );
      // A paired client with administrative scopes is still not the desktop.
      const pairing = yield* serverAuth.issuePairingCredential();
      const paired = yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
        pairing.credential,
        undefined,
        requestMetadata,
      );

      for (const request of [
        {},
        { authorization: `Bearer ${"b".repeat(64)}` },
        { authorization: `Bearer ${DESKTOP_BOOTSTRAP_TOKEN}` },
        { authorization: `Bearer ${paired.access_token}` },
        { cookie: `${sessions.cookieName}=${browser.sessionToken}` },
      ]) {
        const response = yield* postEmergencyStop({
          ...request,
          query: `?token=${desktopBearer}`,
        });
        expect(response.status).toBe(401);
      }
      expect(stopCalls).toBe(0);
    }).pipe(
      Effect.provide(
        makeServerLayer(
          { mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
          makeComputerService(() => {
            stopCalls += 1;
          }),
        ),
      ),
    );
  });

  it.effect("keeps the emergency-stop route unavailable outside a private desktop deployment", () =>
    Effect.gen(function* () {
      const computerService = makeComputerService(() => undefined);
      for (const overrides of [
        { mode: "web" as const, desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
        { mode: "desktop" as const, desktopBootstrapToken: undefined },
      ]) {
        const response = yield* postEmergencyStop({
          authorization: `Bearer ${DESKTOP_BOOTSTRAP_TOKEN}`,
        }).pipe(Effect.provide(makeServerLayer(overrides, computerService)));
        expect(response.status).toBe(404);
      }
      // A peer off this machine never reaches credentials, even on a desktop
      // backend that is exposed to the network for remote clients.
      expect(
        isDesktopEmergencyStopAvailable({
          config: { mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
          remoteAddress: Option.some("192.168.1.50"),
        }),
      ).toBe(false);
      expect(
        isDesktopEmergencyStopAvailable({
          config: { mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
          remoteAddress: Option.none(),
        }),
      ).toBe(false);
      expect(
        isDesktopEmergencyStopAvailable({
          config: { mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN },
          remoteAddress: Option.some("::ffff:127.0.0.1"),
        }),
      ).toBe(true);
    }),
  );

  it.effect("answers 404 when no computer service exists to stop", () =>
    Effect.gen(function* () {
      const bearer = yield* exchangeDesktopBearer;
      const response = yield* postEmergencyStop({ authorization: `Bearer ${bearer}` });
      expect(response.status).toBe(404);
      expect(response.body).toEqual({ accepted: false });
    }).pipe(
      Effect.provide(
        makeServerLayer({ mode: "desktop", desktopBootstrapToken: DESKTOP_BOOTSTRAP_TOKEN }),
      ),
    ),
  );
});
