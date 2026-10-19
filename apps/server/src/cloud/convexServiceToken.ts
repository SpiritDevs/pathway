// @effect-diagnostics nodeBuiltinImport:off -- DPoP proofs and JWKS verification are node:crypto primitives; keeping them as plain functions is what makes the signed artifacts unit-testable against the relay's own verifiers without a FileSystem or platform layer
/**
 * The `pathway-convex` service-token half of the Convex trust chain, shared by the smoke harness
 * and the running server's sync transport.
 *
 * Everything here is the *same* code the Phase-1 smoke run proved against a real relay: the
 * environment-signed key binding, the ES256 DPoP proof, the OAuth token-exchange call, and the
 * structural claim check Convex authorizes on. `convexSyncSmoke.ts` re-exports these so its
 * existing tests keep verifying the artifacts the relay accepts, and
 * {@link makeConvexServiceTokenProvider} wraps them in the caching/refresh policy a long-lived
 * daemon needs.
 *
 * Nothing in this module touches the network at import time, and the pure pieces (payload
 * construction, proof signing, claim and signature checks, error classification) are exported
 * individually so they can be tested without one.
 *
 * @module cloud/convexServiceToken
 */
import * as NodeCrypto from "node:crypto";

import type { EnvironmentId } from "@spiritdevs/contracts";
import {
  RELAY_CONVEX_KEY_BINDING_TYP,
  RelayAccessTokenType,
  RelayConvexAudience,
  RelayConvexServiceTokenResponse,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentCredentialTokenType,
  type RelayConvexKeyBindingPayload,
} from "@spiritdevs/contracts/relay";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@spiritdevs/shared/dpop";
import { normalizeDpopHtu } from "@spiritdevs/shared/dpopCommon";
import { decodeRelayJwt, normalizeRelayIssuer, signRelayJwt } from "@spiritdevs/shared/relayJwt";
import { ConvexError } from "convex/values";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

// --------------------------------------------------------------------------
// Clock
// --------------------------------------------------------------------------

/** Epoch seconds off the ambient Effect clock, which is what makes expiry testable. */
export const nowEpochSeconds: Effect.Effect<number> = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => Math.floor(millis / 1_000)),
);

// --------------------------------------------------------------------------
// DPoP key material
// --------------------------------------------------------------------------

export interface DpopKeyPair {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  /** RFC 7638 thumbprint of the public JWK. */
  readonly thumbprint: string;
}

export function generateDpopKeyPair(): DpopKeyPair {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const exported = publicKey.export({ format: "jwk" });
  const publicJwk: DpopPublicJwk = {
    kty: "EC",
    crv: "P-256",
    x: String(exported.x),
    y: String(exported.y),
  };
  return { privateKey, publicJwk, thumbprint: computeDpopJwkThumbprint(publicJwk) };
}

// --------------------------------------------------------------------------
// Signed artifacts
// --------------------------------------------------------------------------

/**
 * The environment-signed assertion that ties a DPoP proof key to the linked
 * environment. The relay verifies it with the stored link public key and
 * requires `sub === environmentId`.
 */
export function buildKeyBindingPayload(input: {
  readonly environmentId: EnvironmentId;
  readonly relayIssuer: string;
  readonly jkt: string;
  readonly jti: string;
  readonly nowEpochSeconds: number;
}): RelayConvexKeyBindingPayload {
  return {
    iss: `pathway-env:${input.environmentId}`,
    aud: normalizeRelayIssuer(input.relayIssuer),
    sub: input.environmentId,
    jti: input.jti,
    iat: input.nowEpochSeconds,
    exp: input.nowEpochSeconds + 300,
    environmentId: input.environmentId,
    jkt: input.jkt,
  } satisfies RelayConvexKeyBindingPayload;
}

/**
 * Compact ES256 DPoP proof in the exact shape `verifyDpopProof` accepts:
 * `typ: dpop+jwt` header carrying the public JWK, `htm`/`htu`/`jti`/`iat`
 * payload, ieee-p1363 signature over `header.payload`.
 */
export function signDpopProof(input: {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk;
  readonly method: string;
  readonly url: string;
  readonly jti: string;
  readonly iatEpochSeconds: number;
  readonly accessToken?: string;
}): string {
  const header = Buffer.from(
    JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: input.jti,
      iat: input.iatEpochSeconds,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

// --------------------------------------------------------------------------
// Token inspection
// --------------------------------------------------------------------------

/** Decodes the JOSE header of a compact JWT, or `null` when it is not one. */
function decodeJwtHeaderSegment(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[0] ?? "";
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Tolerance for clock disagreement between this machine and the relay. */
const TOKEN_CLOCK_SKEW_SECONDS = 60;

/**
 * The token's `exp` claim in epoch seconds, or `null` when it carries none this build can read.
 * The provider schedules its refresh off this rather than off `expires_in` alone, so a relay that
 * mints a shorter-lived token than it advertises is still refreshed before Convex refuses it.
 */
export function serviceTokenExpiryEpochSeconds(token: string): number | null {
  let claims: Record<string, unknown>;
  try {
    claims = decodeRelayJwt(token) as Record<string, unknown>;
  } catch {
    return null;
  }
  const exp = claims["exp"];
  return typeof exp === "number" && Number.isFinite(exp) ? exp : null;
}

/**
 * Checks the header and claims of a minted service token: the shape Convex
 * authorizes on (`aud`/`sub`/`environmentId`/`cnf.jkt`), the issuer, and that
 * the header/lifetime are what the relay's ES256 signing path produces. Returns
 * `null` when everything holds, otherwise a description of the first mismatch.
 *
 * Purely structural — signature verification against the relay's live JWKS is
 * {@link verifyServiceTokenSignature}, kept separate so this stays unit
 * testable without a network.
 */
export function checkConvexServiceTokenClaims(input: {
  readonly token: string;
  readonly environmentId: EnvironmentId;
  readonly expectedJkt: string;
  /** The relay base URL the token was requested from. */
  readonly expectedIssuer: string;
  /** `expires_in` from the exchange response; bounds the token's lifetime. */
  readonly expiresInSeconds: number;
  readonly nowEpochSeconds: number;
}): string | null {
  const header = decodeJwtHeaderSegment(input.token);
  if (header === null) {
    return "service token header is not decodable JOSE JSON";
  }
  if (header["alg"] !== "ES256") {
    return `header alg is ${JSON.stringify(header["alg"])}, expected "ES256"`;
  }
  if (typeof header["kid"] !== "string" || header["kid"].length === 0) {
    return "header has no kid — Convex cannot select the relay's JWKS key without one";
  }
  let claims: Record<string, unknown>;
  try {
    claims = decodeRelayJwt(input.token) as Record<string, unknown>;
  } catch (error) {
    return `service token is not a decodable JWT: ${String(error)}`;
  }
  const expectedIssuer = normalizeRelayIssuer(input.expectedIssuer);
  if (claims["iss"] !== expectedIssuer) {
    return `iss is ${JSON.stringify(claims["iss"])}, expected "${expectedIssuer}"`;
  }
  if (claims["aud"] !== RelayConvexAudience) {
    return `aud is ${JSON.stringify(claims["aud"])}, expected "${RelayConvexAudience}"`;
  }
  if (claims["sub"] !== input.environmentId) {
    return `sub is ${JSON.stringify(claims["sub"])}, expected "${input.environmentId}"`;
  }
  if (claims["environmentId"] !== input.environmentId) {
    return `environmentId is ${JSON.stringify(claims["environmentId"])}, expected "${input.environmentId}"`;
  }
  if (typeof claims["jti"] !== "string" || claims["jti"].length === 0) {
    return `jti is ${JSON.stringify(claims["jti"])}, expected a non-empty string`;
  }
  const iat = claims["iat"];
  const exp = claims["exp"];
  if (typeof iat !== "number" || typeof exp !== "number") {
    return `iat/exp are ${JSON.stringify(iat)}/${JSON.stringify(exp)}, expected numbers`;
  }
  if (exp <= iat) {
    return `exp ${exp} is not after iat ${iat}`;
  }
  if (exp - iat > input.expiresInSeconds + TOKEN_CLOCK_SKEW_SECONDS) {
    return `token lifetime is ${exp - iat}s, expected at most expires_in ${input.expiresInSeconds}s (+${TOKEN_CLOCK_SKEW_SECONDS}s skew)`;
  }
  if (iat > input.nowEpochSeconds + TOKEN_CLOCK_SKEW_SECONDS) {
    return `iat ${iat} is in the future (now ${input.nowEpochSeconds})`;
  }
  if (exp < input.nowEpochSeconds - TOKEN_CLOCK_SKEW_SECONDS) {
    return `token already expired at ${exp} (now ${input.nowEpochSeconds})`;
  }
  const cnf = claims["cnf"];
  const jkt =
    typeof cnf === "object" && cnf !== null ? (cnf as Record<string, unknown>)["jkt"] : undefined;
  if (jkt !== input.expectedJkt) {
    return `cnf.jkt is ${JSON.stringify(jkt)}, expected the DPoP key thumbprint "${input.expectedJkt}"`;
  }
  return null;
}

/**
 * Verifies the token's ES256 signature against a JWKS document (as served at
 * the relay's `/.well-known/jwks.json`). Returns `null` when the signature
 * verifies with the key the header's `kid` names, otherwise a description of
 * what failed. Pure given the JWKS — the live run fetches the document over
 * the injected HttpClient and hands it in.
 */
export function verifyServiceTokenSignature(input: {
  readonly token: string;
  readonly jwks: unknown;
}): string | null {
  const segments = input.token.split(".");
  if (segments.length !== 3) {
    return "service token is not a three-segment compact JWT";
  }
  const header = decodeJwtHeaderSegment(input.token);
  if (header === null) {
    return "service token header is not decodable JOSE JSON";
  }
  const kid = header["kid"];
  if (typeof kid !== "string" || kid.length === 0) {
    return "service token header has no kid to select a JWKS key with";
  }
  const keys =
    typeof input.jwks === "object" && input.jwks !== null
      ? (input.jwks as Record<string, unknown>)["keys"]
      : undefined;
  if (!Array.isArray(keys)) {
    return "relay JWKS document has no keys array";
  }
  const jwk = keys.find(
    (key: unknown) =>
      typeof key === "object" && key !== null && (key as Record<string, unknown>)["kid"] === kid,
  );
  if (jwk === undefined) {
    return `relay JWKS serves no key with kid "${kid}" (${keys.length} key(s) present)`;
  }
  let publicKey: NodeCrypto.KeyObject;
  try {
    publicKey = NodeCrypto.createPublicKey({ key: jwk as NodeCrypto.JsonWebKey, format: "jwk" });
  } catch (error) {
    return `relay JWKS key "${kid}" is not importable: ${String(error)}`;
  }
  const valid = NodeCrypto.verify(
    "sha256",
    Buffer.from(`${segments[0]}.${segments[1]}`),
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(segments[2] ?? "", "base64url"),
  );
  return valid ? null : `service token signature does not verify against JWKS key "${kid}"`;
}

/**
 * The `reason` of a relay `auth_invalid` error body, or `null` when the body is
 * not one. The negative cases assert the exact reason so a refusal for the
 * wrong cause (say, a concurrently invalidated credential) cannot pass as the
 * refusal under test.
 */
export function relayAuthErrorReason(body: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (record["code"] !== "auth_invalid") {
    return null;
  }
  return typeof record["reason"] === "string" ? record["reason"] : null;
}

/** Extracts the backend error `code` from a thrown Convex `ConvexError`, if that is what `error` is. */
export function convexErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const code = (data as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

// --------------------------------------------------------------------------
// Token exchange
// --------------------------------------------------------------------------

/** The relay endpoint that mints `pathway-convex` service tokens. */
export function convexTokenExchangeUrl(relayBaseUrl: string): string {
  return `${normalizeRelayIssuer(relayBaseUrl)}/v1/environment/convex-token`;
}

/** The environment identity and key material one token exchange needs. */
export interface ConvexServiceTokenIdentity {
  readonly environmentId: EnvironmentId;
  /** Relay base URL; normalized to the issuer form before it is used anywhere. */
  readonly relayBaseUrl: string;
  /** The DPoP-bound environment credential the relay issued when the environment was linked. */
  readonly environmentCredential: string;
  /** PEM (pkcs8) Ed25519 private key of the environment link; it signs the key binding. */
  readonly linkPrivateKey: string;
  /** The ES256 proof key the minted token is bound to through `cnf.jkt`. */
  readonly dpopKeys: DpopKeyPair;
  /**
   * Thumbprint asserted in the key binding; defaults to `dpopKeys.thumbprint`, which is the only
   * value that can produce a usable token. It is separable purely so the smoke's negative cases can
   * present a binding and a proof from different keys and assert the relay refuses for that reason.
   */
  readonly bindingJkt?: string;
}

/** Raw exchange outcome. Status and body are un-filtered so callers can classify refusals. */
export interface ConvexTokenExchangeOutcome {
  readonly status: number;
  readonly body: string;
}

/**
 * One `POST {relay}/v1/environment/convex-token`, key-binding assertion and DPoP proof included.
 *
 * The response is returned raw — status plus body text — because both callers need more than the
 * happy path: the smoke's negative cases assert the exact status and `auth_invalid` reason, and the
 * provider maps 401/403 to a terminal failure rather than a retryable one.
 */
export const exchangeConvexServiceToken = Effect.fn("cloud.convex_service_token.exchange")(
  function* (identity: ConvexServiceTokenIdentity) {
    const httpClient = yield* HttpClient.HttpClient;
    const relayBaseUrl = normalizeRelayIssuer(identity.relayBaseUrl);
    const exchangeUrl = convexTokenExchangeUrl(relayBaseUrl);
    const exchangeHtu = normalizeDpopHtu(exchangeUrl) ?? exchangeUrl;
    const now = yield* nowEpochSeconds;
    const keyBinding = yield* signRelayJwt({
      privateKey: identity.linkPrivateKey,
      typ: RELAY_CONVEX_KEY_BINDING_TYP,
      payload: buildKeyBindingPayload({
        environmentId: identity.environmentId,
        relayIssuer: relayBaseUrl,
        jkt: identity.bindingJkt ?? identity.dpopKeys.thumbprint,
        jti: NodeCrypto.randomUUID(),
        nowEpochSeconds: now,
      }),
    });
    const dpopProof = signDpopProof({
      privateKey: identity.dpopKeys.privateKey,
      publicJwk: identity.dpopKeys.publicJwk,
      method: "POST",
      url: exchangeHtu,
      jti: NodeCrypto.randomUUID(),
      iatEpochSeconds: now,
    });
    const response = yield* HttpClientRequest.post(exchangeUrl).pipe(
      HttpClientRequest.setHeader("dpop", dpopProof),
      HttpClientRequest.bodyUrlParams({
        grant_type: RelayDpopTokenExchangeGrantType,
        subject_token: identity.environmentCredential,
        subject_token_type: RelayEnvironmentCredentialTokenType,
        requested_token_type: RelayAccessTokenType,
        audience: RelayConvexAudience,
        key_binding: keyBinding,
      }),
      httpClient.execute,
    );
    const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return { status: response.status, body } satisfies ConvexTokenExchangeOutcome;
  },
);

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

/**
 * Why a service token could not be produced.
 *
 * The three reasons line up one-for-one with the transport's retryable/terminal split:
 * `offline` and `transport` are worth retrying, `unauthorized` is not until the environment is
 * re-linked or its credential replaced.
 */
export class ConvexServiceTokenError extends Schema.TaggedErrorClass<ConvexServiceTokenError>()(
  "ConvexServiceTokenError",
  {
    reason: Schema.Literals(["offline", "transport", "unauthorized"]),
    message: Schema.String,
  },
) {}

export interface ConvexServiceTokenProvider {
  /**
   * The current `pathway-convex` bearer token. Cached until it is inside the refresh margin of its
   * own `exp`; concurrent callers that arrive during a refresh share the one in-flight exchange.
   */
  readonly token: Effect.Effect<string, ConvexServiceTokenError>;
  /**
   * Drops the cached token so the next {@link token} mints a fresh one. Pass the token that was
   * refused: a stale value is ignored when the cache has already moved on, so one fiber's 401
   * cannot throw away a token another fiber just minted.
   */
  readonly invalidate: (staleToken?: string) => Effect.Effect<void>;
}

/** Refresh this far ahead of `exp`, so a call never leaves with a token Convex is about to refuse. */
export const DEFAULT_SERVICE_TOKEN_REFRESH_MARGIN_SECONDS = 60;

export interface ConvexServiceTokenProviderOptions extends ConvexServiceTokenIdentity {
  /** Defaults to {@link DEFAULT_SERVICE_TOKEN_REFRESH_MARGIN_SECONDS}. */
  readonly refreshMarginSeconds?: number;
}

interface CachedServiceToken {
  readonly token: string;
  readonly expiresAtEpochSeconds: number;
}

const decodeExchangeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RelayConvexServiceTokenResponse),
);

/**
 * Builds a caching, single-flight token provider over {@link exchangeConvexServiceToken}.
 *
 * The refresh is proactive rather than reactive: a token inside `refreshMarginSeconds` of its `exp`
 * is treated as already gone, because a request that leaves here with three seconds of life left
 * arrives at Convex expired and costs a whole round trip to discover it. The exchange runs under a
 * one-permit semaphore with a re-check on the far side, so a burst of concurrent sync calls at
 * startup performs exactly one exchange instead of one each.
 */
export const makeConvexServiceTokenProvider = Effect.fn("cloud.convex_service_token.provider")(
  function* (options: ConvexServiceTokenProviderOptions) {
    const httpClient = yield* HttpClient.HttpClient;
    const cache = yield* Ref.make<CachedServiceToken | null>(null);
    const mintLock = yield* Semaphore.make(1);
    const marginSeconds =
      options.refreshMarginSeconds ?? DEFAULT_SERVICE_TOKEN_REFRESH_MARGIN_SECONDS;
    const relayBaseUrl = normalizeRelayIssuer(options.relayBaseUrl);

    const isUsable = (
      cached: CachedServiceToken | null,
      now: number,
    ): cached is CachedServiceToken =>
      cached !== null && cached.expiresAtEpochSeconds - marginSeconds > now;

    const mintFresh = Effect.gen(function* () {
      const outcome = yield* exchangeConvexServiceToken({
        ...options,
        relayBaseUrl,
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "RelayJwtError"
            ? // A key binding this environment cannot sign means the stored link private key is
              // unusable; no amount of retrying produces a token, only re-linking does.
              new ConvexServiceTokenError({
                reason: "unauthorized",
                message: `environment key binding could not be signed: ${error.message}`,
              })
            : new ConvexServiceTokenError({
                reason: error.reason._tag === "TransportError" ? "offline" : "transport",
                message: `token exchange could not reach ${relayBaseUrl}: ${error.message}`,
              }),
        ),
      );

      if (outcome.status !== 200) {
        const authReason = relayAuthErrorReason(outcome.body);
        const terminal = outcome.status === 400 || outcome.status === 401 || outcome.status === 403;
        return yield* new ConvexServiceTokenError({
          reason: terminal ? "unauthorized" : "transport",
          message: `token exchange returned HTTP ${outcome.status}${
            authReason === null ? "" : ` (auth_invalid/${authReason})`
          }`,
        });
      }

      const response = yield* decodeExchangeResponse(outcome.body).pipe(
        Effect.mapError(
          (error) =>
            new ConvexServiceTokenError({
              reason: "transport",
              message: `token exchange body is not a service token response: ${error.message}`,
            }),
        ),
      );

      const now = yield* nowEpochSeconds;
      const mismatch = checkConvexServiceTokenClaims({
        token: response.access_token,
        environmentId: options.environmentId,
        expectedJkt: options.dpopKeys.thumbprint,
        expectedIssuer: relayBaseUrl,
        expiresInSeconds: response.expires_in,
        nowEpochSeconds: now,
      });
      if (mismatch !== null) {
        // A token whose claims do not match is one Convex will refuse; failing here names the
        // reason instead of letting every sync call fail as a nondescript permission error.
        return yield* new ConvexServiceTokenError({
          reason: "unauthorized",
          message: `minted service token is not usable: ${mismatch}`,
        });
      }

      return {
        token: response.access_token,
        expiresAtEpochSeconds:
          serviceTokenExpiryEpochSeconds(response.access_token) ?? now + response.expires_in,
      } satisfies CachedServiceToken;
    });

    const mint: Effect.Effect<CachedServiceToken, ConvexServiceTokenError> = mintFresh.pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    const token: Effect.Effect<string, ConvexServiceTokenError> = Effect.gen(function* () {
      const now = yield* nowEpochSeconds;
      const cached = yield* Ref.get(cache);
      if (isUsable(cached, now)) return cached.token;
      return yield* mintLock.withPermits(1)(
        Effect.gen(function* () {
          // Re-check on the far side of the lock: whoever held it may have just refreshed, and a
          // queue of waiters must not each perform their own exchange.
          const settled = yield* nowEpochSeconds;
          const current = yield* Ref.get(cache);
          if (isUsable(current, settled)) return current.token;
          const minted = yield* mint;
          yield* Ref.set(cache, minted);
          return minted.token;
        }),
      );
    });

    const invalidate = (staleToken?: string): Effect.Effect<void> =>
      Ref.update(cache, (current) =>
        current === null || (staleToken !== undefined && current.token !== staleToken)
          ? current
          : null,
      );

    return { token, invalidate } satisfies ConvexServiceTokenProvider;
  },
);
