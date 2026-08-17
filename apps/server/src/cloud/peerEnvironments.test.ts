import { assert, describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@spiritdevs/contracts";
import {
  RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
  RelayAccessTokenType,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentClientId,
  RelayEnvironmentConnectNotAuthorizedReason,
  RelayEnvironmentConnectScope,
  RelayJwtSubjectTokenType,
} from "@spiritdevs/contracts/relay";
import {
  ConnectionTransientError,
  RelayConnectionTarget,
  type PreparedConnection,
} from "@spiritdevs/client-runtime/connection";
import { type RpcSession, RpcSessionFactory } from "@spiritdevs/client-runtime/rpc";
import { verifyDpopProof } from "@spiritdevs/shared/dpop";
import { decodeRelayJwt, verifyRelayJwt } from "@spiritdevs/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, RELAY_URL_SECRET } from "./config.ts";
import { nowEpochSeconds } from "./convexServiceToken.ts";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  make,
  PeerEnvironmentConnectNotAuthorizedError,
  PeerEnvironmentConnectionFailedError,
  PeerEnvironmentNotLinkedError,
  PeerEnvironmentRelayRefusedError,
  PeerEnvironmentSelfConnectError,
} from "./peerEnvironments.ts";

const OWN_ENVIRONMENT_ID = EnvironmentId.make("environment-source");
const TARGET_ENVIRONMENT_ID = EnvironmentId.make("environment-target");
const RELAY_URL = "https://relay.example.test";
const TARGET_HTTP_URL = "https://target.example.test";
const TARGET_WS_URL = "wss://target.example.test";
const CONNECT_GRANT = "connect-grant-once";
const RELAY_ACCESS_TOKEN = "relay-dpop-access-token";
const TARGET_BOOTSTRAP_CREDENTIAL = "target-bootstrap-credential";
const TARGET_ACCESS_TOKEN = "target-dpop-access-token";
const TARGET_WS_TICKET = "target-websocket-ticket";
const EXPIRES_AT = "2026-08-15T12:00:00.000Z";

const descriptor = {
  environmentId: TARGET_ENVIRONMENT_ID,
  label: "Target environment",
  platform: { os: "linux" as const, arch: "x64" as const },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true, connectionProbe: true },
};

const decodeAssertion = Schema.decodeUnknownSync(
  Schema.Struct({
    iss: Schema.String,
    aud: Schema.String,
    sub: Schema.String,
    jti: Schema.String,
    iat: Schema.Int,
    exp: Schema.Int,
    environmentId: Schema.String,
    jkt: Schema.String,
  }),
);
const decodeJwtHeader = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      alg: Schema.String,
      typ: Schema.String,
    }),
  ),
);
const decodeConnectRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      clientKeyThumbprint: Schema.String,
      connectGrant: Schema.String,
    }),
  ),
);

const encode = (value: string): Uint8Array => new TextEncoder().encode(value);

function requestBody(request: HttpClientRequest.HttpClientRequest): string {
  return request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
}

function jsonResponse(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
  value: unknown,
) {
  return HttpClientResponse.fromWeb(
    request,
    Response.json(value, {
      status,
    }),
  );
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

interface HarnessOptions {
  readonly linked?: boolean;
  readonly ownEnvironmentId?: EnvironmentId;
  readonly exchangeRefused?: boolean;
  readonly connectRefusal?: RelayEnvironmentConnectNotAuthorizedReason;
  readonly sessionReadyFailure?: boolean;
}

const makeHarness = Effect.fn("PeerEnvironmentsTest.makeHarness")(function* (
  options: HarnessOptions = {},
) {
  const secretValues = new Map<string, Uint8Array>();
  let secretReads = 0;
  const setSecret = (name: string, value: Uint8Array) =>
    Effect.sync(() => {
      secretValues.set(name, value);
    });
  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) =>
      Effect.sync(() => {
        secretReads += 1;
        return Option.fromUndefinedOr(secretValues.get(name));
      }),
    set: setSecret,
    create: setSecret,
    getOrCreateRandom: () => Effect.die(new Error("Unexpected random-secret request.")),
    remove: (name) =>
      Effect.sync(() => {
        secretValues.delete(name);
      }),
  });
  let linkPublicKey: string | null = null;
  if (options.linked !== false) {
    secretValues.set(RELAY_URL_SECRET, encode(RELAY_URL));
    secretValues.set(RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encode("linked-environment-credential"));
    const linkKeys = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secretStore);
    linkPublicKey = linkKeys.publicKey;
    secretReads = 0;
  }

  const requests: RecordedRequest[] = [];
  const proofChecks: Array<ReturnType<typeof verifyDpopProof>> = [];
  let assertionClaims: ReturnType<typeof decodeAssertion> | null = null;
  let assertionHeader: ReturnType<typeof decodeJwtHeader> | null = null;
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        const body = requestBody(request);
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body,
        });
        const pathname = new URL(request.url).pathname;
        if (pathname === "/v1/environment/dpop-token") {
          if (options.exchangeRefused === true) {
            return jsonResponse(request, 401, {
              _tag: "RelayAuthInvalidError",
              code: "auth_invalid",
              reason: "invalid_bearer",
              traceId: "trace-exchange-refused",
            });
          }
          const params = new URLSearchParams(body);
          const assertion = params.get("subject_token") ?? "";
          assertionClaims = decodeAssertion(decodeRelayJwt(assertion));
          const headerSegment = assertion.split(".")[0] ?? "";
          assertionHeader = decodeJwtHeader(
            Buffer.from(headerSegment, "base64url").toString("utf8"),
          );
          const now = yield* nowEpochSeconds;
          proofChecks.push(
            verifyDpopProof({
              proof: request.headers["dpop"],
              method: "POST",
              url: request.url,
              nowEpochSeconds: now,
              expectedThumbprint: assertionClaims.jkt,
            }),
          );
          return jsonResponse(request, 200, {
            access_token: RELAY_ACCESS_TOKEN,
            issued_token_type: RelayAccessTokenType,
            token_type: "DPoP",
            expires_in: 300,
            scope: RelayEnvironmentConnectScope,
          });
        }
        if (pathname === `/v1/environments/${TARGET_ENVIRONMENT_ID}/connect`) {
          const now = yield* nowEpochSeconds;
          proofChecks.push(
            verifyDpopProof({
              proof: request.headers["dpop"],
              method: "POST",
              url: request.url,
              nowEpochSeconds: now,
              ...(assertionClaims ? { expectedThumbprint: assertionClaims.jkt } : {}),
              expectedAccessToken: RELAY_ACCESS_TOKEN,
            }),
          );
          if (options.connectRefusal !== undefined) {
            return jsonResponse(request, 403, {
              _tag: "RelayEnvironmentConnectNotAuthorizedError",
              code: "environment_connect_not_authorized",
              reason: options.connectRefusal,
              traceId: `trace-${options.connectRefusal}`,
            });
          }
          return jsonResponse(request, 200, {
            environmentId: TARGET_ENVIRONMENT_ID,
            endpoint: {
              httpBaseUrl: TARGET_HTTP_URL,
              wsBaseUrl: TARGET_WS_URL,
              providerKind: "cloudflare_tunnel",
            },
            credential: TARGET_BOOTSTRAP_CREDENTIAL,
            expiresAt: EXPIRES_AT,
          });
        }
        if (pathname === "/.well-known/pathway/environment") {
          return jsonResponse(request, 200, descriptor);
        }
        if (pathname === "/oauth/token") {
          const now = yield* nowEpochSeconds;
          proofChecks.push(
            verifyDpopProof({
              proof: request.headers["dpop"],
              method: "POST",
              url: request.url,
              nowEpochSeconds: now,
              ...(assertionClaims ? { expectedThumbprint: assertionClaims.jkt } : {}),
            }),
          );
          return jsonResponse(request, 200, {
            access_token: TARGET_ACCESS_TOKEN,
            issued_token_type: RelayAccessTokenType,
            token_type: "DPoP",
            expires_in: 300,
            scope:
              "orchestration:read orchestration:operate terminal:operate review:write relay:read",
          });
        }
        if (pathname === "/api/auth/websocket-ticket") {
          const now = yield* nowEpochSeconds;
          proofChecks.push(
            verifyDpopProof({
              proof: request.headers["dpop"],
              method: "POST",
              url: request.url,
              nowEpochSeconds: now,
              ...(assertionClaims ? { expectedThumbprint: assertionClaims.jkt } : {}),
              expectedAccessToken: TARGET_ACCESS_TOKEN,
            }),
          );
          return jsonResponse(request, 200, {
            ticket: TARGET_WS_TICKET,
            expiresAt: EXPIRES_AT,
          });
        }
        return jsonResponse(request, 404, { code: "unexpected_request" });
      }),
    ),
  );

  const preparedConnections: PreparedConnection[] = [];
  const sessionReleased = yield* Ref.make(false);
  const fakeSession: RpcSession = {
    client: {} as RpcSession["client"],
    initialConfig: Effect.die(new Error("Unexpected initial config request.")),
    ready:
      options.sessionReadyFailure === true
        ? Effect.fail(
            new ConnectionTransientError({
              reason: "transport",
              detail: "The target websocket did not open.",
            }),
          )
        : Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const sessionFactory = RpcSessionFactory.of({
    connect: (prepared) =>
      Effect.gen(function* () {
        preparedConnections.push(prepared);
        yield* Effect.addFinalizer(() => Ref.set(sessionReleased, true));
        return fakeSession;
      }),
  });
  const environment = ServerEnvironment.ServerEnvironment.of({
    getEnvironmentId: Effect.succeed(options.ownEnvironmentId ?? OWN_ENVIRONMENT_ID),
    getDescriptor: Effect.die(new Error("Unexpected own-environment descriptor request.")),
  });
  const services = Layer.mergeAll(
    Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
    Layer.succeed(ServerEnvironment.ServerEnvironment, environment),
    Layer.succeed(RpcSessionFactory, sessionFactory),
    httpLayer,
  );
  const peerEnvironments = yield* make.pipe(Effect.provide(services));

  return {
    peerEnvironments,
    requests,
    proofChecks,
    preparedConnections,
    sessionReleased,
    linkPublicKey,
    secretReads: () => secretReads,
    assertion: () => ({ claims: assertionClaims, header: assertionHeader }),
  };
});

const connect = (harness: Effect.Success<ReturnType<typeof makeHarness>>) =>
  harness.peerEnvironments.connect({
    targetEnvironmentId: TARGET_ENVIRONMENT_ID,
    connectGrantToken: CONNECT_GRANT,
  });

describe("PeerEnvironments", () => {
  it.effect(
    "uses one fresh proof key through relay exchange, target authorization, and RPC session",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness();
          const handle = yield* connect(harness);

          expect(harness.requests.map((request) => new URL(request.url).pathname)).toEqual([
            "/v1/environment/dpop-token",
            `/v1/environments/${TARGET_ENVIRONMENT_ID}/connect`,
            "/.well-known/pathway/environment",
            "/oauth/token",
            "/api/auth/websocket-ticket",
          ]);
          const exchange = harness.requests[0];
          assert.isDefined(exchange);
          const exchangeForm = new URLSearchParams(exchange.body);
          expect(exchangeForm.get("grant_type")).toBe(RelayDpopTokenExchangeGrantType);
          expect(exchangeForm.get("subject_token_type")).toBe(RelayJwtSubjectTokenType);
          expect(exchangeForm.get("requested_token_type")).toBe(RelayAccessTokenType);
          expect(exchangeForm.get("resource")).toBe(RELAY_URL);
          expect(exchangeForm.get("scope")).toBe(RelayEnvironmentConnectScope);
          expect(exchangeForm.get("client_id")).toBe(RelayEnvironmentClientId);

          const assertion = harness.assertion();
          const verifiedAssertion = yield* verifyRelayJwt({
            publicKey: harness.linkPublicKey ?? "",
            token: exchangeForm.get("subject_token") ?? "",
            typ: RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
            issuer: `pathway-env:${OWN_ENVIRONMENT_ID}`,
            audience: RELAY_URL,
            nowEpochSeconds: assertion.claims?.iat ?? 0,
          }).pipe(Effect.map(decodeAssertion));
          expect(assertion.header).toMatchObject({
            alg: "EdDSA",
            typ: RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
          });
          expect(assertion.claims).toMatchObject({
            iss: `pathway-env:${OWN_ENVIRONMENT_ID}`,
            sub: OWN_ENVIRONMENT_ID,
            aud: RELAY_URL,
            environmentId: OWN_ENVIRONMENT_ID,
          });
          expect(assertion.claims?.jkt).toBeTruthy();
          expect(assertion.claims?.exp).toBe((assertion.claims?.iat ?? 0) + 300);
          expect(verifiedAssertion).toEqual(assertion.claims);
          expect(harness.proofChecks).toHaveLength(4);
          expect(harness.proofChecks.every((proof) => proof.ok)).toBe(true);

          const relayConnect = harness.requests[1];
          assert.isDefined(relayConnect);
          expect(relayConnect.headers["authorization"]).toBe(`DPoP ${RELAY_ACCESS_TOKEN}`);
          expect(decodeConnectRequest(relayConnect.body)).toEqual({
            clientKeyThumbprint: assertion.claims?.jkt,
            connectGrant: CONNECT_GRANT,
          });
          const targetExchange = harness.requests[3];
          assert.isDefined(targetExchange);
          const targetExchangeForm = new URLSearchParams(targetExchange.body);
          expect(targetExchangeForm.get("subject_token")).toBe(TARGET_BOOTSTRAP_CREDENTIAL);
          expect(targetExchangeForm.get("client_device_type")).toBe("bot");
          const ticket = harness.requests[4];
          assert.isDefined(ticket);
          expect(ticket.headers["authorization"]).toBe(`DPoP ${TARGET_ACCESS_TOKEN}`);

          expect(handle.targetEnvironmentId).toBe(TARGET_ENVIRONMENT_ID);
          expect(handle.session).toBeDefined();
          expect(harness.preparedConnections).toHaveLength(1);
          expect(harness.preparedConnections[0]).toMatchObject({
            environmentId: TARGET_ENVIRONMENT_ID,
            label: descriptor.label,
            httpBaseUrl: TARGET_HTTP_URL,
            socketUrl: `${TARGET_WS_URL}/ws?wsTicket=${TARGET_WS_TICKET}`,
            httpAuthorization: { _tag: "Dpop", accessToken: TARGET_ACCESS_TOKEN },
            target: new RelayConnectionTarget({
              environmentId: TARGET_ENVIRONMENT_ID,
              label: descriptor.label,
            }),
          });

          expect(yield* Ref.get(harness.sessionReleased)).toBe(false);
          yield* handle.close;
          expect(yield* Ref.get(harness.sessionReleased)).toBe(true);
        }),
      ),
  );

  it.effect("maps the relay's uniform assertion refusal without spending the grant", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ exchangeRefused: true });
        const error = yield* Effect.flip(connect(harness));

        expect(error).toBeInstanceOf(PeerEnvironmentRelayRefusedError);
        expect(error).toMatchObject({
          stage: "token-exchange",
          traceId: "trace-exchange-refused",
          grantConsumption: "not-consumed",
          retryRequiresFreshGrant: false,
        });
        expect(harness.requests).toHaveLength(1);
        expect(harness.preparedConnections).toHaveLength(0);
      }),
    ),
  );

  for (const reason of RelayEnvironmentConnectNotAuthorizedReason.literals) {
    it.effect(`maps relay connect refusal reason ${reason}`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeHarness({ connectRefusal: reason });
          const error = yield* Effect.flip(connect(harness));

          expect(error).toBeInstanceOf(PeerEnvironmentConnectNotAuthorizedError);
          expect(error).toMatchObject({
            reason,
            traceId: `trace-${reason}`,
          });
          if (reason === "self_connect_refused") {
            expect(error).toMatchObject({
              grantConsumption: "not-consumed",
              retryRequiresFreshGrant: false,
            });
          } else if (reason === "connect_grant_refused") {
            expect(error).toMatchObject({
              grantConsumption: "unknown",
              retryRequiresFreshGrant: true,
            });
          } else {
            expect(error).toMatchObject({
              grantConsumption: "consumed",
              retryRequiresFreshGrant: true,
            });
          }
          expect(harness.requests).toHaveLength(2);
          expect(harness.preparedConnections).toHaveLength(0);
        }),
      ),
    );
  }

  it.effect("releases the session and requires a fresh grant when websocket readiness fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ sessionReadyFailure: true });
        const error = yield* Effect.flip(connect(harness));

        expect(error).toBeInstanceOf(PeerEnvironmentConnectionFailedError);
        expect(error).toMatchObject({
          stage: "websocket",
          grantConsumption: "consumed",
          retryRequiresFreshGrant: true,
        });
        expect(yield* Ref.get(harness.sessionReleased)).toBe(true);
      }),
    ),
  );

  it.effect("refuses self-connect before reading link secrets or making requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          linked: false,
          ownEnvironmentId: TARGET_ENVIRONMENT_ID,
        });
        const error = yield* Effect.flip(connect(harness));

        expect(error).toBeInstanceOf(PeerEnvironmentSelfConnectError);
        expect(harness.secretReads()).toBe(0);
        expect(harness.requests).toHaveLength(0);
        expect(harness.preparedConnections).toHaveLength(0);
      }),
    ),
  );

  it.effect("refuses an environment that has never linked before making requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ linked: false });
        const error = yield* Effect.flip(connect(harness));

        expect(error).toBeInstanceOf(PeerEnvironmentNotLinkedError);
        expect(harness.requests).toHaveLength(0);
        expect(harness.preparedConnections).toHaveLength(0);
      }),
    ),
  );
});
