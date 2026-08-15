// @effect-diagnostics nodeBuiltinImport:off -- the server reuses its Node-backed DPoP and relay-JWT helpers so peer credentials are byte-for-byte compatible with the existing relay and client-runtime verifiers
import * as NodeCrypto from "node:crypto";

import { AuthStandardClientScopes, type EnvironmentId } from "@spiritdevs/contracts";
import {
  RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
  RelayAccessTokenType,
  RelayApi,
  RelayAuthInvalidError,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentClientId,
  RelayEnvironmentConnectNotAuthorizedError as RelayConnectNotAuthorizedError,
  RelayEnvironmentConnectNotAuthorizedReason,
  RelayEnvironmentConnectScope,
  RelayJwtSubjectTokenType,
} from "@spiritdevs/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "@spiritdevs/client-runtime/authorization";
import {
  RelayConnectionTarget,
  type PreparedConnection,
} from "@spiritdevs/client-runtime/connection";
import { fetchRemoteEnvironmentDescriptor } from "@spiritdevs/client-runtime/environment";
import { type RpcSession, RpcSessionFactory } from "@spiritdevs/client-runtime/rpc";
import { normalizeDpopHtu } from "@spiritdevs/shared/dpopCommon";
import { normalizeRelayIssuer, signRelayJwt } from "@spiritdevs/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  buildKeyBindingPayload,
  generateDpopKeyPair,
  nowEpochSeconds,
  signDpopProof,
  type DpopKeyPair,
} from "./convexServiceToken.ts";
import { readCloudSyncLink } from "./syncDaemon.ts";

export const PeerEnvironmentGrantConsumption = Schema.Literals([
  "not-consumed",
  "consumed",
  "unknown",
]);
export type PeerEnvironmentGrantConsumption = typeof PeerEnvironmentGrantConsumption.Type;

export class PeerEnvironmentNotLinkedError extends Schema.TaggedErrorClass<PeerEnvironmentNotLinkedError>()(
  "PeerEnvironmentNotLinkedError",
  {
    message: Schema.String,
  },
) {}

export class PeerEnvironmentSelfConnectError extends Schema.TaggedErrorClass<PeerEnvironmentSelfConnectError>()(
  "PeerEnvironmentSelfConnectError",
  {
    environmentId: Schema.String,
  },
) {
  override get message(): string {
    return `Environment '${this.environmentId}' cannot connect to itself.`;
  }
}

export class PeerEnvironmentRelayRefusedError extends Schema.TaggedErrorClass<PeerEnvironmentRelayRefusedError>()(
  "PeerEnvironmentRelayRefusedError",
  {
    stage: Schema.Literals(["token-exchange", "relay-connect"]),
    traceId: Schema.optional(Schema.String),
    grantConsumption: PeerEnvironmentGrantConsumption,
    retryRequiresFreshGrant: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Relay refused the peer environment ${this.stage}.`;
  }
}

export class PeerEnvironmentConnectNotAuthorizedError extends Schema.TaggedErrorClass<PeerEnvironmentConnectNotAuthorizedError>()(
  "PeerEnvironmentConnectNotAuthorizedError",
  {
    reason: Schema.optional(RelayEnvironmentConnectNotAuthorizedReason),
    traceId: Schema.String,
    grantConsumption: PeerEnvironmentGrantConsumption,
    retryRequiresFreshGrant: Schema.Boolean,
  },
) {
  override get message(): string {
    return this.reason
      ? `Relay did not authorize the peer environment connection: ${this.reason}.`
      : "Relay did not authorize the peer environment connection.";
  }
}

export const PeerEnvironmentConnectionStage = Schema.Literals([
  "token-exchange",
  "relay-connect",
  "target-authorization",
  "websocket",
]);
export type PeerEnvironmentConnectionStage = typeof PeerEnvironmentConnectionStage.Type;

export class PeerEnvironmentConnectionFailedError extends Schema.TaggedErrorClass<PeerEnvironmentConnectionFailedError>()(
  "PeerEnvironmentConnectionFailedError",
  {
    stage: PeerEnvironmentConnectionStage,
    cause: Schema.Defect(),
    grantConsumption: PeerEnvironmentGrantConsumption,
    retryRequiresFreshGrant: Schema.Boolean,
  },
) {
  override get message(): string {
    return `Peer environment connection failed during ${this.stage}.`;
  }
}

export const PeerEnvironmentConnectionError = Schema.Union([
  PeerEnvironmentNotLinkedError,
  PeerEnvironmentSelfConnectError,
  PeerEnvironmentRelayRefusedError,
  PeerEnvironmentConnectNotAuthorizedError,
  PeerEnvironmentConnectionFailedError,
]);
export type PeerEnvironmentConnectionError = typeof PeerEnvironmentConnectionError.Type;

export interface PeerEnvironmentHandle {
  readonly session: RpcSession;
  readonly targetEnvironmentId: EnvironmentId;
  readonly close: Effect.Effect<void>;
}

export interface PeerEnvironmentConnectInput {
  readonly targetEnvironmentId: EnvironmentId;
  readonly connectGrantToken: string;
}

export class PeerEnvironments extends Context.Service<
  PeerEnvironments,
  {
    readonly connect: (
      input: PeerEnvironmentConnectInput,
    ) => Effect.Effect<PeerEnvironmentHandle, PeerEnvironmentConnectionError, Scope.Scope>;
  }
>()("@spiritdevs/pathway/cloud/peerEnvironments") {}

const isRelayAuthInvalidError = Schema.is(RelayAuthInvalidError);
const isRelayConnectNotAuthorizedError = Schema.is(RelayConnectNotAuthorizedError);

class PeerEnvironmentTargetMismatch extends Schema.TaggedErrorClass<PeerEnvironmentTargetMismatch>()(
  "PeerEnvironmentTargetMismatch",
  {
    source: Schema.Literals(["relay", "descriptor"]),
  },
) {}

function grantDispositionForConnectRefusal(
  reason: RelayEnvironmentConnectNotAuthorizedReason | undefined,
): {
  readonly grantConsumption: PeerEnvironmentGrantConsumption;
  readonly retryRequiresFreshGrant: boolean;
} {
  // These are the relay's declared handler-order guarantees. Anything without a reason is
  // deliberately unknown: a caller must not turn an ambiguous response into a grant-reuse oracle.
  switch (reason) {
    case "self_connect_refused":
      return {
        grantConsumption: "not-consumed",
        retryRequiresFreshGrant: false,
      };
    case "connect_grant_refused":
    case undefined:
      return {
        grantConsumption: "unknown",
        retryRequiresFreshGrant: true,
      };
    // client_proof_key_thumbprint_missing is raised inside the connector, after the grant has
    // already been validated and consumed — it belongs with the post-grant refusals even though
    // this client's non-empty thumbprint makes it unreachable in practice.
    case "client_proof_key_thumbprint_missing":
    case "environment_link_not_found":
    case "endpoint_provider_not_managed":
    case "managed_endpoint_allocation_not_found":
    case "managed_endpoint_base_domain_not_configured":
    case "managed_endpoint_allocation_not_ready":
    case "managed_endpoint_hostname_invalid":
    case "managed_endpoint_mismatch":
      return {
        grantConsumption: "consumed",
        retryRequiresFreshGrant: true,
      };
  }
}

function mapTokenExchangeError(cause: unknown): PeerEnvironmentConnectionError {
  if (isRelayAuthInvalidError(cause)) {
    return new PeerEnvironmentRelayRefusedError({
      stage: "token-exchange",
      traceId: cause.traceId,
      grantConsumption: "not-consumed",
      retryRequiresFreshGrant: false,
    });
  }
  return new PeerEnvironmentConnectionFailedError({
    stage: "token-exchange",
    cause,
    grantConsumption: "not-consumed",
    retryRequiresFreshGrant: false,
  });
}

function mapRelayConnectError(cause: unknown): PeerEnvironmentConnectionError {
  if (isRelayAuthInvalidError(cause)) {
    return new PeerEnvironmentRelayRefusedError({
      stage: "relay-connect",
      traceId: cause.traceId,
      grantConsumption: "not-consumed",
      retryRequiresFreshGrant: false,
    });
  }
  if (isRelayConnectNotAuthorizedError(cause)) {
    return new PeerEnvironmentConnectNotAuthorizedError({
      reason: cause.reason,
      traceId: cause.traceId,
      ...grantDispositionForConnectRefusal(cause.reason),
    });
  }
  return new PeerEnvironmentConnectionFailedError({
    stage: "relay-connect",
    cause,
    grantConsumption: "unknown",
    retryRequiresFreshGrant: true,
  });
}

function makeDpopProof(input: {
  readonly keys: DpopKeyPair;
  readonly method: string;
  readonly url: string;
  readonly now: number;
  readonly accessToken?: string;
}): string {
  return signDpopProof({
    privateKey: input.keys.privateKey,
    publicJwk: input.keys.publicJwk,
    method: input.method,
    url: normalizeDpopHtu(input.url) ?? input.url,
    jti: NodeCrypto.randomUUID(),
    iatEpochSeconds: input.now,
    ...(input.accessToken ? { accessToken: input.accessToken } : {}),
  });
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const httpClient = yield* HttpClient.HttpClient;
  const sessions = yield* RpcSessionFactory;

  const connect = Effect.fn("cloud.peer_environments.connect")(function* (
    input: PeerEnvironmentConnectInput,
  ) {
    const ownEnvironmentId = yield* environment.getEnvironmentId;
    if (ownEnvironmentId === input.targetEnvironmentId) {
      return yield* new PeerEnvironmentSelfConnectError({
        environmentId: ownEnvironmentId,
      });
    }

    const link = yield* readCloudSyncLink(secrets);
    if (link === null) {
      return yield* new PeerEnvironmentNotLinkedError({
        message:
          "This environment has no usable relay link identity and cannot initiate peer control.",
      });
    }

    // The bootstrap credential and every target token/ticket are proof-key bound, so one fresh
    // attempt key must survive the whole chain and must never be cached across grant attempts.
    const dpopKeys = yield* Effect.sync(generateDpopKeyPair);
    const relayBaseUrl = normalizeRelayIssuer(link.relayBaseUrl);
    const relayClient = yield* HttpApiClient.make(RelayApi, {
      baseUrl: relayBaseUrl,
    }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
    const exchangeUrl = `${relayBaseUrl}/v1/environment/dpop-token`;
    const assertionNow = yield* nowEpochSeconds;
    const assertion = yield* signRelayJwt({
      privateKey: link.linkPrivateKey,
      typ: RELAY_ENVIRONMENT_DPOP_ACCESS_ASSERTION_TYP,
      payload: buildKeyBindingPayload({
        environmentId: ownEnvironmentId,
        relayIssuer: relayBaseUrl,
        jkt: dpopKeys.thumbprint,
        jti: NodeCrypto.randomUUID(),
        nowEpochSeconds: assertionNow,
      }),
    }).pipe(
      Effect.mapError(
        () =>
          new PeerEnvironmentNotLinkedError({
            message: "The stored relay link key cannot sign a peer environment access assertion.",
          }),
      ),
    );
    const exchangeProof = makeDpopProof({
      keys: dpopKeys,
      method: "POST",
      url: exchangeUrl,
      now: assertionNow,
    });
    const relayAccess = yield* relayClient.token
      .exchangeEnvironmentDpopAccessToken({
        headers: { dpop: exchangeProof },
        payload: {
          grant_type: RelayDpopTokenExchangeGrantType,
          subject_token: assertion,
          subject_token_type: RelayJwtSubjectTokenType,
          requested_token_type: RelayAccessTokenType,
          resource: relayBaseUrl,
          scope: RelayEnvironmentConnectScope,
          client_id: RelayEnvironmentClientId,
        },
      })
      .pipe(Effect.mapError(mapTokenExchangeError));

    const connectUrl = `${relayBaseUrl}/v1/environments/${encodeURIComponent(input.targetEnvironmentId)}/connect`;
    const connectNow = yield* nowEpochSeconds;
    const connectProof = makeDpopProof({
      keys: dpopKeys,
      method: "POST",
      url: connectUrl,
      now: connectNow,
      accessToken: relayAccess.access_token,
    });
    const connected = yield* relayClient.dpopClient
      .connectEnvironment({
        headers: {
          authorization: `DPoP ${relayAccess.access_token}`,
          dpop: connectProof,
        },
        params: { environmentId: input.targetEnvironmentId },
        payload: {
          clientKeyThumbprint: dpopKeys.thumbprint,
          connectGrant: input.connectGrantToken,
        },
      })
      .pipe(Effect.mapError(mapRelayConnectError));

    const authorized = yield* Effect.gen(function* () {
      if (connected.environmentId !== input.targetEnvironmentId) {
        return yield* new PeerEnvironmentTargetMismatch({ source: "relay" });
      }
      const descriptor = yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl: connected.endpoint.httpBaseUrl,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      if (descriptor.environmentId !== input.targetEnvironmentId) {
        return yield* new PeerEnvironmentTargetMismatch({ source: "descriptor" });
      }
      const bootstrapUrl = new URL("/oauth/token", connected.endpoint.httpBaseUrl).toString();
      const bootstrapNow = yield* nowEpochSeconds;
      const bootstrapProof = makeDpopProof({
        keys: dpopKeys,
        method: "POST",
        url: bootstrapUrl,
        now: bootstrapNow,
      });
      const access = yield* exchangeRemoteDpopAccessToken({
        httpBaseUrl: connected.endpoint.httpBaseUrl,
        credential: connected.credential,
        dpopProof: bootstrapProof,
        scopes: AuthStandardClientScopes,
        clientMetadata: {
          label: "Pathway peer environment",
          deviceType: "bot",
        },
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const ticketUrl = new URL(
        "/api/auth/websocket-ticket",
        connected.endpoint.httpBaseUrl,
      ).toString();
      const ticketNow = yield* nowEpochSeconds;
      const ticketProof = makeDpopProof({
        keys: dpopKeys,
        method: "POST",
        url: ticketUrl,
        now: ticketNow,
        accessToken: access.access_token,
      });
      const socketUrl = yield* resolveRemoteDpopWebSocketConnectionUrl({
        wsBaseUrl: connected.endpoint.wsBaseUrl,
        httpBaseUrl: connected.endpoint.httpBaseUrl,
        accessToken: access.access_token,
        dpopProof: ticketProof,
      }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
      const target = new RelayConnectionTarget({
        environmentId: input.targetEnvironmentId,
        label: descriptor.label,
      });
      return {
        environmentId: input.targetEnvironmentId,
        label: descriptor.label,
        httpBaseUrl: connected.endpoint.httpBaseUrl,
        socketUrl,
        httpAuthorization: {
          _tag: "Dpop" as const,
          accessToken: access.access_token,
        },
        target,
      } satisfies PreparedConnection;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PeerEnvironmentConnectionFailedError({
            stage: "target-authorization",
            cause,
            grantConsumption: "consumed",
            retryRequiresFreshGrant: true,
          }),
      ),
    );

    const sessionScope = yield* Scope.make();
    const close = Scope.close(sessionScope, Exit.void);
    yield* Effect.addFinalizer(() => close);
    const session = yield* sessions.connect(authorized).pipe(
      Effect.provideService(Scope.Scope, sessionScope),
      Effect.flatMap((candidate) => candidate.ready.pipe(Effect.as(candidate))),
      Effect.mapError(
        (cause) =>
          new PeerEnvironmentConnectionFailedError({
            stage: "websocket",
            cause,
            grantConsumption: "consumed",
            retryRequiresFreshGrant: true,
          }),
      ),
      Effect.onError(() => close),
    );

    return {
      session,
      targetEnvironmentId: input.targetEnvironmentId,
      close,
    } satisfies PeerEnvironmentHandle;
  });

  return PeerEnvironments.of({ connect });
});

/**
 * One attempt, one grant, and no retries. A caller may fall back to durable command dispatch, but
 * any failure after relay connect begins requires the grant disposition carried by the error to be
 * honored before another direct attempt.
 */
export const layer = Layer.effect(PeerEnvironments, make);
