// @effect-diagnostics preferSchemaOverJson:off - JWT signatures cover the exact encoded JSON bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentHttpApi, AuthWebSocketTicketResult } from "@spiritdevs/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@spiritdevs/shared/dpop";
import type * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";
import * as ServerConfig from "../config.ts";
import { browserApiCorsLayer } from "../http.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SessionStore } from "../auth/SessionStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "../auth/http.ts";
import { DeviceService } from "./DeviceService.ts";
import { deviceHubProxyRouteLayer } from "./DeviceHubProxy.ts";

const remoteOrigin = "https://environment.example.test";
const hostedOrigin = "https://app.spiritdevs.com";
const ticketUrl = `${remoteOrigin}/api/auth/websocket-ticket`;
const mediaPath = "/api/device-hub/vendor/serve-sim/helper/phone/stream.avcc";
const decodeTicket = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(AuthWebSocketTicketResult)),
);

const services = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-device-auth-" })),
);

const makeFixture = Effect.fn("deviceProxyAuth.fixture")(function* (devUrl?: URL) {
  const baseContext = yield* Effect.context<
    | Crypto.Crypto
    | EnvironmentAuth.EnvironmentAuth
    | SessionStore
    | ServerConfig.ServerConfig
    | ServerSecretStore.ServerSecretStore
  >();
  const context = devUrl
    ? Context.add(baseContext, ServerConfig.ServerConfig, {
        ...Context.get(baseContext, ServerConfig.ServerConfig),
        devUrl,
      })
    : baseContext;
  const requests: Array<{ url: string; headers: Readonly<Record<string, string | undefined>> }> =
    [];
  const hosts: Array<string | undefined> = [];
  const upstream = HttpClient.make((request) => {
    requests.push({ url: request.url, headers: request.headers });
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(new Uint8Array([0, 1, 255]))),
    );
  });
  const deviceService = {
    claimDevice: () => Effect.void,
    currentReadiness: (hostId: string | undefined) => {
      hosts.push(hostId);
      return Effect.succeed({
        hostId: hostId ?? "local",
        hub: { origin: "http://127.0.0.1:34999" },
      });
    },
  } as unknown as DeviceService["Service"];
  const routes = Layer.mergeAll(
    deviceHubProxyRouteLayer,
    browserApiCorsLayer,
    HttpApiBuilder.layer(HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth)).pipe(
      Layer.provide(authHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
  ).pipe(
    Layer.provideMerge(Layer.succeedContext(context)),
    Layer.provide(NodeHttpServer.layerHttpServices),
    Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, upstream)),
    Layer.provideMerge(Layer.succeed(DeviceService, deviceService)),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(dispose));
  const request = (path: string, init?: RequestInit) =>
    Effect.gen(function* () {
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`${remoteOrigin}${path}`, {
            ...init,
            headers: {
              host: "environment.example.test",
              origin: hostedOrigin,
              "x-forwarded-proto": "https",
              ...init?.headers,
            },
          }),
          context,
        ),
      );
      return {
        status: response.status,
        headers: response.headers,
        bytes: new Uint8Array(yield* Effect.promise(() => response.arrayBuffer())),
      };
    });
  return { request, requests, hosts };
});

it.layer(NodeServices.layer)("device proxy with real environment authentication", (it) => {
  it.effect("allows hosted clients to preflight a development environment", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture(new URL("http://localhost:5173"));
      const response = yield* fixture.request("/api/auth/websocket-ticket", {
        method: "OPTIONS",
        headers: {
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,dpop",
        },
      });
      expect(response.headers.get("access-control-allow-origin")).toBe(hostedOrigin);
      expect(response.headers.get("access-control-allow-headers")).toContain("dpop");
    }).pipe(Effect.provide(services)),
  );

  it.effect("requires credentials for both HTTP media and WebSocket upgrades", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      for (const [path, headers] of [
        [mediaPath, {}],
        ["/api/device-hub/vendor/serve-emu/ws", { upgrade: "websocket" }],
      ] as const) {
        const response = yield* fixture.request(path, { headers });
        expect(response.status).toBe(401);
      }
      expect(fixture.requests).toEqual([]);
      expect(fixture.hosts).toEqual([]);
    }).pipe(Effect.provide(services)),
  );

  it.effect(
    "serves binary media cross-origin with a bearer ticket, strips credentials, and rejects expiry",
    () =>
      Effect.gen(function* () {
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const fixture = yield* makeFixture();
        const session = yield* auth.issueSession({ scopes: ["orchestration:read"] });
        const preflight = yield* fixture.request("/api/auth/websocket-ticket", {
          method: "OPTIONS",
          headers: {
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization,dpop",
          },
        });
        expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
        expect(preflight.headers.get("access-control-allow-headers")).toContain("dpop");
        const issued = yield* fixture.request("/api/auth/websocket-ticket", {
          method: "POST",
          headers: { authorization: `Bearer ${session.token}` },
        });
        expect(issued.status).toBe(200);
        const ticket = yield* decodeTicket(new TextDecoder().decode(issued.bytes));
        const path = `${mediaPath}?hostId=remote-mac&wsTicket=${encodeURIComponent(ticket.ticket)}`;
        for (let attempt = 0; attempt < 2; attempt++) {
          const response = yield* fixture.request(path, {
            headers: {
              authorization: `Bearer ${session.token}`,
              cookie: "irrelevant=private",
              dpop: "not-forwarded",
            },
          });
          expect(response.status).toBe(200);
          expect(response.headers.get("access-control-allow-origin")).toBe("*");
          expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
          expect([...response.bytes]).toEqual([0, 1, 255]);
        }
        expect(fixture.hosts).toEqual(["remote-mac", "remote-mac"]);
        expect(fixture.requests[0]?.url).toBe(
          "http://127.0.0.1:34999/vendor/serve-sim/helper/phone/stream.avcc",
        );
        for (const { headers } of fixture.requests) {
          expect(headers.authorization).toBeUndefined();
          expect(headers.cookie).toBeUndefined();
          expect(headers.dpop).toBeUndefined();
          expect(headers.origin).toBe("http://127.0.0.1:34999");
        }
        yield* TestClock.adjust("5 minutes");
        expect((yield* fixture.request(path)).status).toBe(401);
        expect(
          (yield* fixture.request(
            `/api/device-hub/vendor/serve-emu/ws?wsTicket=${encodeURIComponent(ticket.ticket)}`,
            { headers: { upgrade: "websocket" } },
          )).status,
        ).toBe(401);
        expect(fixture.requests).toHaveLength(2);
      }).pipe(Effect.provide(services)),
  );

  it.effect(
    "mints media tickets only with a DPoP proof for the ticket endpoint and access token",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore;
        const fixture = yield* makeFixture();
        const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
        const jwk = keys.publicKey.export({ format: "jwk" }) as DpopPublicJwk;
        const session = yield* sessions.issue({
          subject: "hosted-client",
          method: "dpop-access-token",
          scopes: ["orchestration:read"],
          proofKeyThumbprint: computeDpopJwkThumbprint(jwk),
        });
        const now = yield* DateTime.now;
        const proof = (url: string, token = session.token) => {
          const header = Buffer.from(
            JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk }),
          ).toString("base64url");
          const payload = Buffer.from(
            JSON.stringify({
              htm: "POST",
              htu: url,
              iat: Math.floor(now.epochMilliseconds / 1000),
              jti: NodeCrypto.randomUUID(),
              ath: computeDpopAccessTokenHash(token),
            }),
          ).toString("base64url");
          const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
            key: keys.privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url");
          return `${header}.${payload}.${signature}`;
        };
        const issue = (dpop?: string) =>
          fixture.request("/api/auth/websocket-ticket", {
            method: "POST",
            headers: { authorization: `DPoP ${session.token}`, ...(dpop ? { dpop } : {}) },
          });
        expect((yield* issue()).status).toBe(401);
        expect((yield* issue(proof(`${remoteOrigin}${mediaPath}`))).status).toBe(401);
        expect((yield* issue(proof(ticketUrl, "wrong-token"))).status).toBe(401);
        const signed = proof(ticketUrl);
        const issued = yield* issue(signed);
        expect(issued.status).toBe(200);
        expect((yield* issue(signed)).status).toBe(401);
        const ticket = yield* decodeTicket(new TextDecoder().decode(issued.bytes));
        const path = `${mediaPath}?wsTicket=${encodeURIComponent(ticket.ticket)}`;
        expect((yield* fixture.request(path)).status).toBe(200);
        yield* sessions.revoke(session.sessionId);
        expect((yield* fixture.request(path)).status).toBe(401);
        expect(fixture.requests).toHaveLength(1);
      }).pipe(Effect.provide(services)),
  );
});
