import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  EnvironmentAuthorizationError,
  WS_METHODS,
  WsServerProbeRpc,
  type ServerConfig,
  type ServerAuthDescriptor,
} from "@spiritdevs/contracts";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import type { RpcSession } from "../rpc/session.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";

import { fetchEnvironmentPlacementSessionState, initialConfigOption } from "./session.ts";

class TestConfigError extends Schema.TaggedErrorClass<TestConfigError>()("TestConfigError", {
  message: Schema.String,
}) {}

describe("environment session state", () => {
  it.effect("turns an initial config failure into an empty value", () =>
    Effect.gen(function* () {
      const result = yield* initialConfigOption(
        Effect.fail(new TestConfigError({ message: "temporary failure" })),
      );
      expect(Option.isNone(result)).toBe(true);
    }),
  );
});

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("placement-environment"),
  label: "Placement environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "expired-connection-token" },
  target,
};
const auth = {
  policy: "remote-reachable",
  bootstrapMethods: [],
  sessionMethods: ["bearer-access-token"],
  sessionCookieName: "pathway_session",
} satisfies ServerAuthDescriptor;
const decodeProbe = Schema.decodeUnknownSync(WsServerProbeRpc.successSchema);
function placementInput(
  probe: ReturnType<RpcSession["client"][typeof WS_METHODS.serverProbe]>,
  connectionProbe = true,
) {
  return {
    prepared,
    signer: Option.none(),
    session: {
      initialConfig: Effect.succeed({
        environment: { capabilities: { connectionProbe } },
      } as unknown as ServerConfig),
      client: { [WS_METHODS.serverProbe]: () => probe } as unknown as RpcSession["client"],
    },
  };
}

describe("placement connection permissions", () => {
  for (const scopes of [
    [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    [AuthOrchestrationReadScope],
    [],
  ]) {
    it.effect(
      `uses the socket's exact permissions with an expired HTTP token: ${scopes.join(",")}`,
      () =>
        Effect.gen(function* () {
          let httpReads = 0;
          const result = yield* fetchEnvironmentPlacementSessionState(
            placementInput(Effect.succeed(decodeProbe({ scopes }))),
          ).pipe(
            Effect.provide(
              remoteHttpClientLayer(() => {
                httpReads++;
                return Promise.resolve(Response.json({ authenticated: false, auth }));
              }),
            ),
          );
          expect(result).toEqual({ authenticated: true, scopes });
          expect(httpReads).toBe(0);
        }),
    );
  }

  for (const connectionProbe of [true, false]) {
    it.effect(
      `falls back to authenticated HTTP on an older server with probe support ${connectionProbe}`,
      () =>
        Effect.gen(function* () {
          let probeReads = 0;
          const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
          const probe = Effect.sync(() => {
            probeReads++;
            return decodeProbe({});
          });
          const result = yield* fetchEnvironmentPlacementSessionState(
            placementInput(probe, connectionProbe),
          ).pipe(
            Effect.provide(
              remoteHttpClientLayer((request, init) => {
                calls.push([request, init ?? {}]);
                return Promise.resolve(Response.json({ authenticated: false, auth }));
              }),
            ),
          );
          expect(result.authenticated).toBe(false);
          expect(probeReads).toBe(connectionProbe ? 1 : 0);
          expect(calls).toHaveLength(1);
          expect(String(calls[0]![0])).toBe("https://environment.example.test/api/auth/session");
          expect(new Headers(calls[0]![1].headers).get("authorization")).toBe(
            "Bearer expired-connection-token",
          );
        }),
    );
  }

  it.effect("does not fall back to HTTP when the socket rejects access", () =>
    Effect.gen(function* () {
      let httpReads = 0;
      const error = new EnvironmentAuthorizationError({
        message: "Read access required",
        requiredScope: AuthOrchestrationReadScope,
      });
      const failure = yield* fetchEnvironmentPlacementSessionState(
        placementInput(Effect.fail(error)),
      ).pipe(
        Effect.provide(
          remoteHttpClientLayer(() => {
            httpReads++;
            return Promise.resolve(
              Response.json({ authenticated: true, auth, scopes: [AuthOrchestrationOperateScope] }),
            );
          }),
        ),
        Effect.flip,
      );
      expect(failure).toEqual(error);
      expect(httpReads).toBe(0);
    }),
  );

  it.effect("bounds a stalled permissions probe", () =>
    Effect.gen(function* () {
      const pending = yield* fetchEnvironmentPlacementSessionState(
        placementInput(Effect.never),
      ).pipe(
        Effect.provide(remoteHttpClientLayer(() => Promise.reject(new Error("unexpected HTTP")))),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("6 seconds");
      expect((yield* Fiber.join(pending))._tag).toBe("TimeoutError");
    }),
  );
});
