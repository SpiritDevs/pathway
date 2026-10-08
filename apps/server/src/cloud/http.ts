import * as NodeCrypto from "node:crypto";
import {
  AuthPeerEnvironmentScopes,
  AuthPeerReadScopes,
  AuthPeerSendScopes,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthStandardClientScopes,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudRegistrationInfo,
  EnvironmentCloudRelayConfigResult,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@spiritdevs/contracts";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentConnectReadScope,
  RelayEnvironmentConnectSendScope,
  RelayEnvironmentLinkChallengeResponse,
  RelayEnvironmentLinkResponse,
  RelayManagedEndpointReprovisionResponse,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentMintResponse as RelayEnvironmentMintResponseShape,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
  type RelayValidatedConnectGrantIdentity,
} from "@spiritdevs/contracts/relay";
import { withRelayClientTracing } from "@spiritdevs/shared/relayTracing";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@spiritdevs/shared/relayJwt";
import { isSecureRelayUrl } from "@spiritdevs/shared/relayUrl";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requireEnvironmentScope } from "../auth/http.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_MANAGED_TUNNEL_LOCAL_PORT,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  decodeManagedTunnelLocalPort,
  decodeRuntimeConfig,
  encodeEndpointRuntimeConfigJson,
  encodeManagedTunnelLocalPort,
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import { relayUrlConfig } from "./publicConfig.ts";
import { readCliDesiredLinkMode, setCliDesiredCloudLink } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import {
  authorizeConnectGrantFromLocalReplica,
  resolveConnectGrantActorFromLocalReplica,
} from "./connectGrantAuthorization.ts";
import {
  getOrCreateCloudSyncDpopKeyPairFromSecretStore,
  getOrCreateEnvironmentKeyPairFromSecretStore,
} from "./environmentKeys.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";

const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

const failCloudCliTokenManagerError = (error: CliTokenManager.CloudCliTokenManagerError) =>
  failEnvironmentCloudInternalError(error.message)(error);

const requireRelayUrl = relayUrlConfig.pipe(
  Effect.mapError(
    () =>
      new EnvironmentHttpInternalServerError({
        message: "PATHWAY_RELAY_URL must be configured as a secure absolute HTTPS origin.",
      }),
  ),
);

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function consumeCloudReplayGuards(input: {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly names: ReadonlyArray<string>;
  readonly value: Uint8Array;
}) {
  return Effect.all(
    input.names.map((name) =>
      input.secrets.create(name, input.value).pipe(
        Effect.as(true),
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error)
            ? Effect.succeed(false)
            : Effect.fail(error),
        ),
      ),
    ),
    { concurrency: input.names.length },
  ).pipe(Effect.map((created) => created.every(Boolean)));
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(
  publicKey: string,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: () =>
      new EnvironmentHttpBadRequestError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new EnvironmentHttpBadRequestError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
            }),
          ),
    ),
  );
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, EnvironmentHttpBadRequestError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Relay environment credential is required.",
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new EnvironmentHttpBadRequestError({
        message: "Cloud user id is required.",
      }),
    );
  }
  return Effect.void;
}

function readInstalledCloudUserId(
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<string, EnvironmentAuth.ServerAuthInternalError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthLinkedCloudAccountReadError({
          cause,
        }),
    ),
    Effect.flatMap((bytes) =>
      Option.isSome(bytes)
        ? Effect.succeed(bytesToString(bytes.value))
        : Effect.fail(new EnvironmentAuth.ServerAuthLinkedCloudAccountMissingError({})),
    ),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["forwarded"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

export function managedTunnelLocalPortFromRequest(
  request: HttpServerRequest.HttpServerRequest,
): number | null {
  const requestUrl = requestAbsoluteUrl(request);
  if (requestUrl === null || hasForwardedAuthorityHeaders(request)) return null;
  const url = new URL(requestUrl);
  return isLoopbackHostname(url.hostname) ? endpointRequestPort(url) : null;
}

/** Remote pairing may configure only this listener, authenticated with an admin DPoP session. */
export const authorizeCloudLinkOrigin = Effect.fn("environment.cloud.authorizeLinkOrigin")(
  function* (
    currentLocalHttpPort: number | undefined,
    requestedOrigin?: RelayManagedEndpointOrigin,
  ) {
    const principal = yield* requireEnvironmentScope(AuthRelayWriteScope);
    const request = yield* HttpServerRequest.HttpServerRequest;
    const requestUrl = requestAbsoluteUrl(request);
    if (requestUrl === null || hasForwardedAuthorityHeaders(request)) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Invalid managed endpoint origin.",
      });
    }
    const url = new URL(requestUrl);
    const localBrowser =
      principal.method !== "dpop-access-token" &&
      isLoopbackHostname(url.hostname) &&
      (Option.isNone(request.remoteAddress) || isLoopbackHostname(request.remoteAddress.value));
    if (
      !localBrowser &&
      (principal.method !== "dpop-access-token" || !principal.proofKeyThumbprint)
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Remote account linking requires an administrator DPoP pairing session.",
      });
    }
    // Legacy desktop browser sessions retain their direct loopback flow. DPoP clients always
    // target the configured listener, even when the request Host claims to be loopback.
    const localHttpPort = localBrowser ? endpointRequestPort(url) : currentLocalHttpPort;
    if (
      localHttpPort === undefined ||
      !Number.isInteger(localHttpPort) ||
      localHttpPort < 1 ||
      localHttpPort > 65_535
    ) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "The server has no configured local listener for remote account linking.",
      });
    }
    if (
      requestedOrigin !== undefined &&
      (!isLoopbackHostname(requestedOrigin.localHttpHost) ||
        requestedOrigin.localHttpPort !== localHttpPort)
    ) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Invalid managed endpoint origin.",
      });
    }
    return { localHttpHost: "127.0.0.1", localHttpPort };
  },
);

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

// A managed (Pathway Connect) endpoint is provisioned by the relay and must
// point at a loopback origin. "cloudflare_tunnel" is its historical wire name. A manual endpoint is reached out of band (e.g.
// another direct endpoint) or not advertised at all for publish-only links, so it is not
// tied to the managed-tunnel scope.
export function isSupportedLinkProviderKind(request: RelayLinkProofRequest): boolean {
  return (
    request.endpoint.providerKind === "cloudflare_tunnel" ||
    request.endpoint.providerKind === "manual"
  );
}

export function linkProofScopes(
  request: RelayLinkProofRequest,
): RelayEnvironmentLinkProofPayload["scopes"] {
  return request.endpoint.providerKind === "cloudflare_tunnel"
    ? ["agent_activity_notifications", "managed_tunnels"]
    : ["agent_activity_notifications"];
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

export interface CloudHttpDependencies {
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly endpointRuntime: ManagedEndpointRuntime.CloudManagedEndpointRuntime["Service"];
  readonly environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly cliTokenManager: CliTokenManager.CloudCliTokenManager["Service"];
  readonly httpClient: HttpClient.HttpClient;
  readonly currentLocalHttpPort?: number | undefined;
  readonly authorizeConnectGrant: (input: {
    readonly environmentId: RelayCloudMintCredentialProofPayload["environmentId"];
    readonly connectGrant: RelayValidatedConnectGrantIdentity;
  }) => Effect.Effect<boolean, never, SqlClient.SqlClient>;
  readonly resolveConnectGrantActor: (input: {
    readonly environmentId: RelayCloudMintCredentialProofPayload["environmentId"];
    readonly connectGrant: RelayValidatedConnectGrantIdentity;
  }) => Effect.Effect<string | null, never, SqlClient.SqlClient>;
}

const cloudHttpDependencies = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  return {
    secrets,
    environment: yield* ServerEnvironment.ServerEnvironment,
    endpointRuntime: yield* ManagedEndpointRuntime.CloudManagedEndpointRuntime,
    environmentAuth: yield* EnvironmentAuth.EnvironmentAuth,
    cliTokenManager: yield* CliTokenManager.CloudCliTokenManager,
    httpClient,
    authorizeConnectGrant: (input) =>
      authorizeConnectGrantFromLocalReplica(input).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
    resolveConnectGrantActor: (input) =>
      resolveConnectGrantActorFromLocalReplica(input).pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      ),
  } satisfies CloudHttpDependencies;
});

export function requireCloudMintConnectGrantAuthorization<R>(
  dependencies: {
    readonly authorizeConnectGrant: (input: {
      readonly environmentId: RelayCloudMintCredentialProofPayload["environmentId"];
      readonly connectGrant: RelayValidatedConnectGrantIdentity;
    }) => Effect.Effect<boolean, never, R>;
  },
  proof: RelayCloudMintCredentialProofPayload,
  environmentId: RelayCloudMintCredentialProofPayload["environmentId"],
): Effect.Effect<void, EnvironmentHttpUnauthorizedError, R> {
  return Effect.gen(function* () {
    if (proof.connectGrant === undefined) return;
    const authorized = yield* dependencies.authorizeConnectGrant({
      environmentId,
      connectGrant: proof.connectGrant,
    });
    if (!authorized) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud mint request.",
      });
    }
  });
}

const makeCloudLinkProof = Effect.fn("environment.cloud.makeLinkProof")(function* (
  dependencies: CloudHttpDependencies,
  request: RelayLinkProofRequest,
  requestUrl: string,
) {
  const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
  if (
    !isSupportedLinkProviderKind(request) ||
    !isAllowedEndpointOrigin({
      origin: request.origin,
      requestUrl,
    })
  ) {
    return yield* new EnvironmentHttpBadRequestError({
      message: "Invalid managed endpoint origin.",
    });
  }
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
  const descriptor = yield* dependencies.environment.getDescriptor;
  const payload = {
    iss: `pathway-env:${descriptor.environmentId}`,
    aud: normalizeRelayIssuer(request.relayIssuer),
    sub: descriptor.environmentId,
    jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
    iat: nowSeconds,
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge: request.challenge,
    descriptor,
    environmentId: descriptor.environmentId,
    environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
    endpoint: request.endpoint,
    origin: request.origin,
    scopes: linkProofScopes(request),
  } satisfies RelayEnvironmentLinkProofPayload;
  return yield* signRelayJwt({
    privateKey: keyPair.privateKey,
    typ: RELAY_LINK_PROOF_TYP,
    payload,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new EnvironmentAuth.ServerAuthCloudLinkJwtSigningError({
          cause,
        }),
    ),
  );
});

const cloudLinkProofHandler = Effect.fn("environment.cloud.linkProof")(
  function* (dependencies: CloudHttpDependencies, request: RelayLinkProofRequest) {
    const origin = yield* authorizeCloudLinkOrigin(
      dependencies.currentLocalHttpPort,
      request.origin,
    );
    const proof = yield* makeCloudLinkProof(
      dependencies,
      { ...request, origin },
      `http://127.0.0.1:${origin.localHttpPort}`,
    );
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not generate environment link proof."),
  ),
);

export const applyCloudRelayConfig = Effect.fn("environment.cloud.applyRelayConfig")(function* (
  dependencies: CloudHttpDependencies,
  payload: RelayEnvironmentConfigRequest,
  managedTunnelLocalPort?: number,
) {
  yield* validateRelayConfigPayload(payload);
  yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
  if (payload.endpointRuntime && managedTunnelLocalPort === undefined) {
    return yield* new EnvironmentHttpBadRequestError({
      message: "A managed endpoint needs an authorized local listener.",
    });
  }
  const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(
    payload.endpointRuntime && managedTunnelLocalPort !== undefined
      ? { config: payload.endpointRuntime, originPort: managedTunnelLocalPort }
      : null,
  );
  const ok =
    endpointRuntimeStatus.status === "disabled" || endpointRuntimeStatus.status === "running";
  if (!ok) {
    return yield* new EnvironmentCloudEndpointUnavailableError({
      message: "Managed endpoint runtime could not be started.",
      endpointRuntimeStatus,
    });
  }

  yield* dependencies.secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
  yield* dependencies.secrets.set(
    RELAY_ISSUER_SECRET,
    stringToBytes(payload.relayIssuer ?? payload.relayUrl),
  );
  yield* dependencies.secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
  yield* dependencies.secrets.set(
    RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
    stringToBytes(payload.environmentCredential),
  );
  yield* dependencies.secrets.set(CLOUD_MINT_PUBLIC_KEY, stringToBytes(payload.cloudMintPublicKey));
  if (payload.endpointRuntime) {
    const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
    yield* dependencies.secrets.set(
      CLOUD_ENDPOINT_RUNTIME_CONFIG,
      stringToBytes(endpointRuntimeJson),
    );
    if (managedTunnelLocalPort !== undefined) {
      const encodedPort = yield* encodeManagedTunnelLocalPort(managedTunnelLocalPort);
      yield* dependencies.secrets.set(CLOUD_MANAGED_TUNNEL_LOCAL_PORT, stringToBytes(encodedPort));
    }
  } else {
    yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    yield* dependencies.secrets.remove(CLOUD_MANAGED_TUNNEL_LOCAL_PORT);
  }
  return { ok, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
});

const cloudRelayConfigHandler = Effect.fn("environment.cloud.relayConfig")(
  function* (dependencies: CloudHttpDependencies, payload: RelayEnvironmentConfigRequest) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    if (!payload.endpointRuntime) {
      return yield* applyCloudRelayConfig(dependencies, payload);
    }
    const origin = yield* authorizeCloudLinkOrigin(dependencies.currentLocalHttpPort);
    return yield* applyCloudRelayConfig(dependencies, payload, origin.localHttpPort);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
  ),
  Effect.catchTag(
    "SchemaError",
    failEnvironmentCloudInternalError("Could not persist environment relay configuration."),
  ),
);

const relayClientRequest = <A>(
  dependencies: CloudHttpDependencies,
  input: {
    readonly url: string;
    readonly token: string;
    readonly payload: unknown;
    readonly schema: Schema.Decoder<A>;
  },
) =>
  HttpClientRequest.post(input.url).pipe(
    HttpClientRequest.bearerToken(input.token),
    HttpClientRequest.bodyJson(input.payload),
    Effect.flatMap(dependencies.httpClient.execute),
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(input.schema)),
    Effect.mapError(
      (cause) =>
        new EnvironmentHttpInternalServerError({
          message: `Pathway Connect relay request failed: ${String(cause)}`,
        }),
    ),
    withRelayClientTracing,
  );

const reconcileDesiredCloudLinkWith = Effect.fn("environment.cloud.reconcileDesiredLinkWith")(
  function* (dependencies: CloudHttpDependencies, localOrigin: string) {
    const localUrl = yield* Effect.try({
      try: () => new URL(localOrigin),
      catch: () =>
        new EnvironmentHttpBadRequestError({
          message: "Could not resolve local environment origin.",
        }),
    });
    if (localUrl.origin !== localOrigin) {
      return yield* new EnvironmentHttpBadRequestError({
        message: "Could not resolve local environment origin.",
      });
    }
    const localWsOrigin = localOrigin.replace(/^http/u, "ws");
    const token = yield* dependencies.cliTokenManager.getExisting.pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new EnvironmentHttpUnauthorizedError({
                message: "Run `pathway connect link` to authorize this environment.",
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
    const mode = yield* readCliDesiredLinkMode;
    const managedTunnelsEnabled = mode !== "publish_only";
    const relayUrl = yield* requireRelayUrl;
    const challenge = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-link-challenges`,
      token: token.accessToken,
      payload: {
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkChallengeResponse,
    });
    const proof = yield* makeCloudLinkProof(
      dependencies,
      {
        challenge: challenge.challenge,
        relayIssuer: relayUrl,
        endpoint: {
          httpBaseUrl: localOrigin,
          wsBaseUrl: localWsOrigin,
          providerKind: managedTunnelsEnabled ? "cloudflare_tunnel" : "manual",
        },
        origin: {
          localHttpHost: localUrl.hostname,
          localHttpPort: endpointRequestPort(localUrl),
        },
      },
      localOrigin,
    );
    const link = yield* relayClientRequest(dependencies, {
      url: `${relayUrl}/v1/client/environment-links`,
      token: token.accessToken,
      payload: {
        proof,
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled,
      },
      schema: RelayEnvironmentLinkResponse,
    });
    yield* setCliDesiredCloudLink(true, mode);
    return yield* applyCloudRelayConfig(
      dependencies,
      {
        relayUrl,
        relayIssuer: link.relayIssuer,
        cloudUserId: link.cloudUserId,
        environmentCredential: link.environmentCredential,
        cloudMintPublicKey: link.cloudMintPublicKey,
        endpointRuntime: link.endpointRuntime,
      },
      endpointRequestPort(localUrl),
    );
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist desired Pathway Connect link state."),
  ),
  Effect.catchTags({
    CloudCliCredentialRemovalError: failCloudCliTokenManagerError,
    CloudCliCredentialRefreshError: failCloudCliTokenManagerError,
    CloudCliCredentialReadError: failCloudCliTokenManagerError,
    CloudCliAuthorizationError: failCloudCliTokenManagerError,
    CloudCliAuthorizationTimeoutError: failCloudCliTokenManagerError,
  }),
);

export const reconcileDesiredCloudLink = Effect.fn("environment.cloud.reconcileDesiredLink")(
  function* (localOrigin: string) {
    return yield* reconcileDesiredCloudLinkWith(yield* cloudHttpDependencies, localOrigin);
  },
);

// Asks the relay for this link's connector config, using this environment's own relay
// credential, then runs and stores it. False when no link is stored, or when the relay returns
// the token the edge just rejected.
const fetchManagedEndpointWith = Effect.fnUntraced(function* (
  dependencies: CloudHttpDependencies,
  originPort: number,
  rejectedToken?: string,
) {
  const read = (name: string) =>
    dependencies.secrets.get(name).pipe(Effect.map(Option.map(bytesToString)));
  const [relayUrl, credential, cloudUserId] = yield* Effect.all([
    read(RELAY_URL_SECRET),
    read(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
    read(CLOUD_LINKED_USER_ID),
  ]);
  if (Option.isNone(relayUrl) || Option.isNone(credential) || Option.isNone(cloudUserId)) {
    return false;
  }
  const environmentId = yield* dependencies.environment.getEnvironmentId;
  const { endpointRuntime } = yield* relayClientRequest(dependencies, {
    url: `${relayUrl.value}/v1/environments/${encodeURIComponent(environmentId)}/managed-endpoint`,
    token: credential.value,
    payload: { cloudUserId: cloudUserId.value },
    schema: RelayManagedEndpointReprovisionResponse,
  });
  if (endpointRuntime.connectorToken === rejectedToken) {
    yield* Effect.logError(
      "Pathway Connect still rejects this environment's connector token; relink to restore remote access",
    );
    return false;
  }
  const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig({
    config: endpointRuntime,
    originPort,
  });
  if (endpointRuntimeStatus.status !== "running") {
    return yield* new EnvironmentCloudEndpointUnavailableError({
      message: "Managed endpoint runtime could not be started.",
      endpointRuntimeStatus,
    });
  }
  yield* dependencies.secrets.set(
    CLOUD_ENDPOINT_RUNTIME_CONFIG,
    stringToBytes(yield* encodeEndpointRuntimeConfigJson(endpointRuntime)),
  );
  yield* dependencies.secrets.set(
    CLOUD_MANAGED_TUNNEL_LOCAL_PORT,
    stringToBytes(yield* encodeManagedTunnelLocalPort(originPort)),
  );
  return true;
});

/**
 * Restores the tunnel of a link whose stored connector config predates Cyndrbase Connect.
 * CLI links relink on startup instead.
 */
export const reprovisionStoredManagedEndpointWith = Effect.fn(
  "environment.cloud.reprovisionStoredManagedEndpoint",
)(function* (dependencies: CloudHttpDependencies, listenerPort: number) {
  const read = (name: string) =>
    dependencies.secrets.get(name).pipe(Effect.map(Option.map(bytesToString)));
  const config = Option.flatMap(yield* read(CLOUD_ENDPOINT_RUNTIME_CONFIG), decodeRuntimeConfig);
  const storedPort = Option.flatMap(
    yield* read(CLOUD_MANAGED_TUNNEL_LOCAL_PORT),
    decodeManagedTunnelLocalPort,
  );
  if (
    Option.isNone(config) ||
    (ManagedEndpointRuntime.connectorTarget(config.value) !== null && Option.isSome(storedPort))
  ) {
    return false;
  }
  return yield* fetchManagedEndpointWith(
    dependencies,
    Option.getOrElse(storedPort, () => listenerPort),
  );
});

export const reprovisionStoredManagedEndpoint = (listenerPort: number) =>
  cloudHttpDependencies.pipe(
    Effect.flatMap((dependencies) =>
      reprovisionStoredManagedEndpointWith(dependencies, listenerPort),
    ),
  );

/**
 * Asks the relay for this link's config after the edge rejected the running token, as when an
 * unlink raced a relink. A different token replaces it; the same one means only a relink helps.
 */
export const recoverRejectedManagedEndpointWith = Effect.fn(
  "environment.cloud.recoverRejectedManagedEndpoint",
)(
  (
    dependencies: CloudHttpDependencies,
    rejected: ManagedEndpointRuntime.ManagedEndpointConnection,
  ) => fetchManagedEndpointWith(dependencies, rejected.originPort, rejected.config.connectorToken),
);

/** Waits for each rejected token and recovers from it once. */
export const recoverRejectedManagedEndpoints = Effect.gen(function* () {
  const dependencies = yield* cloudHttpDependencies;
  return yield* Effect.forever(
    dependencies.endpointRuntime.rejected.pipe(
      Effect.flatMap((rejected) =>
        recoverRejectedManagedEndpointWith(dependencies, rejected).pipe(
          Effect.retry({
            times: ManagedEndpointRuntime.MAX_AUTOMATIC_CONNECTOR_ATTEMPTS - 1,
            schedule: Schedule.exponential("1 second"),
          }),
          Effect.tap((recovered) =>
            recovered
              ? Effect.logInfo("Pathway Connect connector token replaced after a rejection")
              : Effect.void,
          ),
          Effect.catch((cause) =>
            Effect.logWarning("Failed to recover a rejected Pathway Connect connector token", {
              cause,
            }),
          ),
        ),
      ),
    ),
  );
});

export const readCloudLinkState = Effect.fn("environment.cloud.readLinkState")(function* (
  dependencies: CloudHttpDependencies,
) {
  const [
    cloudUserId,
    relayUrl,
    relayIssuer,
    endpointRuntimeConfig,
    managedTunnelLocalPort,
    publishAgentActivity,
  ] = yield* Effect.all(
    [
      dependencies.secrets.get(CLOUD_LINKED_USER_ID),
      dependencies.secrets.get(RELAY_URL_SECRET),
      dependencies.secrets.get(RELAY_ISSUER_SECRET),
      dependencies.secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      dependencies.secrets.get(CLOUD_MANAGED_TUNNEL_LOCAL_PORT),
      dependencies.secrets.get(PUBLISH_AGENT_ACTIVITY_SECRET),
    ],
    { concurrency: 6 },
  );
  const decodedManagedTunnelLocalPort = Option.flatMap(managedTunnelLocalPort, (bytes) =>
    decodeManagedTunnelLocalPort(bytesToString(bytes)),
  );
  return {
    linked: Option.isSome(cloudUserId),
    cloudUserId: Option.isSome(cloudUserId) ? bytesToString(cloudUserId.value) : null,
    relayUrl: Option.isSome(relayUrl) ? bytesToString(relayUrl.value) : null,
    relayIssuer: Option.isSome(relayIssuer) ? bytesToString(relayIssuer.value) : null,
    // The managed tunnel runtime config is only stored for managed links; a
    // publish-only link leaves it absent.
    managedTunnelActive: Option.isSome(endpointRuntimeConfig),
    managedTunnelLocalPort: Option.isSome(endpointRuntimeConfig)
      ? Option.getOrNull(decodedManagedTunnelLocalPort)
      : null,
    ...(dependencies.currentLocalHttpPort !== undefined
      ? { currentLocalHttpPort: dependencies.currentLocalHttpPort }
      : {}),
    publishAgentActivity: Option.isSome(publishAgentActivity)
      ? bytesToString(publishAgentActivity.value) === "true"
      : false,
  } satisfies EnvironmentCloudLinkStateResult;
});

const readCurrentCloudLinkState = Effect.fn("environment.cloud.readCurrentLinkState")(function* (
  dependencies: CloudHttpDependencies,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  return yield* readCloudLinkState({
    ...dependencies,
    ...(serverConfig.port > 0 ? { currentLocalHttpPort: serverConfig.port } : {}),
  });
});

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    return yield* readCurrentCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not read environment relay configuration."),
  ),
);

const cloudRegistrationInfoHandler = Effect.fn("environment.cloud.registrationInfo")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayReadScope);
    const [descriptor, linkState, proofKeys] = yield* Effect.all([
      dependencies.environment.getDescriptor,
      readCloudLinkState(dependencies),
      getOrCreateCloudSyncDpopKeyPairFromSecretStore(dependencies.secrets),
    ]);
    return {
      descriptor,
      publicKeyThumbprint: proofKeys.thumbprint,
      relayLinkState: linkState.linked ? "linked" : "unlinked",
      managedEndpointAvailable: linkState.managedTunnelActive === true,
    } satisfies EnvironmentCloudRegistrationInfo;
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not read cloud sync registration identity."),
  ),
);

const cloudUnlinkHandler = Effect.fn("environment.cloud.unlink")(
  function* (dependencies: CloudHttpDependencies) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(null);
    yield* Effect.all(
      [
        dependencies.secrets.remove(CLOUD_LINKED_USER_ID),
        dependencies.secrets.remove(RELAY_URL_SECRET),
        dependencies.secrets.remove(RELAY_ISSUER_SECRET),
        dependencies.secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        dependencies.secrets.remove(CLOUD_MINT_PUBLIC_KEY),
        dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
        dependencies.secrets.remove(CLOUD_MANAGED_TUNNEL_LOCAL_PORT),
        dependencies.secrets.remove(PUBLISH_AGENT_ACTIVITY_SECRET),
      ],
      { concurrency: 8 },
    );
    yield* setCliDesiredCloudLink(false);
    return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
  ),
);

const cloudPreferencesHandler = Effect.fn("environment.cloud.preferences")(
  function* (
    dependencies: CloudHttpDependencies,
    payload: { readonly publishAgentActivity: boolean },
  ) {
    yield* requireEnvironmentScope(AuthRelayWriteScope);
    yield* dependencies.secrets.set(
      PUBLISH_AGENT_ACTIVITY_SECRET,
      stringToBytes(String(payload.publishAgentActivity)),
    );
    return yield* readCurrentCloudLinkState(dependencies);
  },
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not persist environment cloud preferences."),
  ),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_HEALTH_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `pathway-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud health request.",
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud health request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const descriptor = yield* dependencies.environment.getDescriptor;
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `pathway-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      requestNonce: proof.nonce,
      status: "online",
      descriptor,
      checkedAt: DateTime.formatIso(now),
    } satisfies RelayEnvironmentHealthResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_HEALTH_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudHealthJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      environmentId,
      status: "online",
      descriptor,
      checkedAt: responsePayload.checkedAt,
      proof: responseProof,
    } satisfies RelayEnvironmentHealthResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not answer cloud health request."),
  ),
);

export const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const cloudMintPublicKey = yield* dependencies.secrets
      .get(CLOUD_MINT_PUBLIC_KEY)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : Effect.fail(new EnvironmentAuth.ServerAuthCloudMintPublicKeyMissingError({})),
        ),
      );
    const relayIssuer = yield* dependencies.secrets
      .get(RELAY_ISSUER_SECRET)
      .pipe(
        Effect.flatMap((bytes) =>
          Option.isSome(bytes)
            ? Effect.succeed(bytesToString(bytes.value))
            : dependencies.secrets
                .get(RELAY_URL_SECRET)
                .pipe(
                  Effect.flatMap((fallbackBytes) =>
                    Option.isSome(fallbackBytes)
                      ? Effect.succeed(bytesToString(fallbackBytes.value))
                      : Effect.fail(new EnvironmentAuth.ServerAuthCloudRelayIssuerMissingError({})),
                  ),
                ),
        ),
      );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_MINT_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `pathway-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !(
        hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" }) ||
        (proofOption.value.initiatingEnvironmentId !== undefined &&
          (hasExactScope({
            scopes: proofOption.value.scope,
            expected: RelayEnvironmentConnectReadScope,
          }) ||
            hasExactScope({
              scopes: proofOption.value.scope,
              expected: RelayEnvironmentConnectSendScope,
            })))
      )
    ) {
      return yield* new EnvironmentHttpUnauthorizedError({
        message: "Invalid cloud mint request.",
      });
    }
    const proof = proofOption.value;
    const sessionIdentity = yield* proof.initiatingEnvironmentId === undefined
      ? Effect.gen(function* () {
          const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
          if (proof.sub !== linkedCloudUserId) {
            return yield* new EnvironmentHttpUnauthorizedError({
              message: "Invalid cloud mint request.",
            });
          }
          yield* requireCloudMintConnectGrantAuthorization(dependencies, proof, environmentId);
          return {
            subject: "cloud-connect",
            clerkSubject: proof.sub,
            ...(proof.clientEnvironmentId
              ? { initiatingEnvironmentId: proof.clientEnvironmentId }
              : {}),
          } as const;
        })
      : Effect.gen(function* () {
          if (
            proof.clientEnvironmentId !== undefined ||
            proof.sub !== proof.initiatingEnvironmentId ||
            proof.connectGrant === undefined
          ) {
            return yield* new EnvironmentHttpUnauthorizedError({
              message: "Invalid cloud mint request.",
            });
          }
          const actingUserId = yield* dependencies.resolveConnectGrantActor({
            environmentId,
            connectGrant: proof.connectGrant,
          });
          if (actingUserId === null) {
            return yield* new EnvironmentHttpUnauthorizedError({
              message: "Invalid cloud mint request.",
            });
          }
          return {
            subject: actingUserId,
            initiatingEnvironmentId: proof.initiatingEnvironmentId,
          } as const;
        });

    const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* consumeCloudReplayGuards({
      secrets: dependencies.secrets,
      names: [jtiSecretName, nonceSecretName],
      value: stringToBytes(DateTime.formatIso(now)),
    });
    if (!consumedReplayGuards) {
      return yield* new EnvironmentHttpConflictError({
        message: "Cloud mint request was already consumed.",
      });
    }

    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const issued = yield* dependencies.environmentAuth.createPairingLink({
      // A peer environment is an agent host, never a hand on this desktop. Thread-access mint
      // scopes only read, or read and dispatch; other peer grants keep the ordinary peer scopes.
      scopes:
        proof.initiatingEnvironmentId === undefined
          ? AuthStandardClientScopes
          : proof.scope.includes(RelayEnvironmentConnectReadScope)
            ? AuthPeerReadScopes
            : proof.scope.includes(RelayEnvironmentConnectSendScope)
              ? AuthPeerSendScopes
              : AuthPeerEnvironmentScopes,
      ...sessionIdentity,
      ttl: Duration.minutes(2),
      label: "Pathway Connect connect",
      proofKeyThumbprint: proof.clientProofKeyThumbprint,
    });
    const responsePayload = {
      iss: `pathway-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
      environmentId,
      clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
      requestNonce: proof.nonce,
      credential: issued.credential,
    } satisfies RelayEnvironmentMintResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MINT_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentAuth.ServerAuthCloudMintJwtSigningError({
            cause,
          }),
      ),
    );
    const response = {
      credential: issued.credential,
      expiresAt: DateTime.formatIso(issued.expiresAt),
      proof: responseProof,
    } satisfies RelayEnvironmentMintResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
    failEnvironmentCloudInternalError(error.message)(error),
  ),
  Effect.catchIf(
    ServerSecretStore.isSecretStoreError,
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
  Effect.catchTag(
    "PlatformError",
    failEnvironmentCloudInternalError("Could not issue cloud connection credential."),
  ),
);

export const connectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const baseDependencies = yield* cloudHttpDependencies;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const dependencies = {
      ...baseDependencies,
      ...(serverConfig.port > 0 ? { currentLocalHttpPort: serverConfig.port } : {}),
    };
    return handlers
      .handle("linkProof", ({ payload }) => cloudLinkProofHandler(dependencies, payload))
      .handle("relayConfig", ({ payload }) => cloudRelayConfigHandler(dependencies, payload))
      .handle("linkState", () => cloudLinkStateHandler(dependencies))
      .handle("registrationInfo", () => cloudRegistrationInfoHandler(dependencies))
      .handle("unlink", () => cloudUnlinkHandler(dependencies))
      .handle("preferences", ({ payload }) => cloudPreferencesHandler(dependencies, payload))
      .handle("health", ({ payload }) => cloudEnvironmentHealthHandler(dependencies, payload))
      .handle("mintCredential", ({ payload }) => cloudMintCredentialHandler(dependencies, payload))
      .handle("pathwayMintCredential", ({ payload }) =>
        traceRelayRequest(cloudMintCredentialHandler(dependencies, payload)),
      );
  }),
);
