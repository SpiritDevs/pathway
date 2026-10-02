// @effect-diagnostics nodeBuiltinImport:off -- RS256 signature checks are node:crypto primitives, as in cloud/convexServiceToken.ts
/**
 * Pathway Cloud sign-in for the environment's owner. A browser on this environment's own origin
 * presents its Clerk session token; when the token names the owner, the browser gets an ordinary
 * cookie session without a pairing code.
 *
 * The owner is the account the environment is linked to through Pathway Connect, or else the
 * account the desktop app last reported as signed in.
 *
 * @module auth/cloudOwner
 */
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { CLOUD_LINKED_USER_ID, CLOUD_OWNER_USER_ID } from "../cloud/config.ts";
import { clerkFrontendApiUrlConfig } from "../cloud/publicConfig.ts";
import { ServerSecretStore } from "./ServerSecretStore.ts";

const CLOCK_SKEW_SECONDS = 5;
const JWKS_REFRESH_INTERVAL_MS = 60_000;

function decodeSegment(segment: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Returns the Clerk user id a session token names when its RS256 signature verifies against the
 * JWKS, its issuer is the Clerk Frontend API, and it is within its lifetime. Otherwise null.
 */
export function verifyClerkSessionToken(input: {
  readonly token: string;
  readonly issuer: string;
  readonly jwks: unknown;
  readonly nowEpochSeconds: number;
}): string | null {
  const segments = input.token.split(".");
  if (segments.length !== 3) return null;
  const header = decodeSegment(segments[0]);
  const payload = decodeSegment(segments[1]);
  if (header === null || payload === null || header["alg"] !== "RS256") return null;
  const keys =
    typeof input.jwks === "object" && input.jwks !== null
      ? (input.jwks as Record<string, unknown>)["keys"]
      : undefined;
  const jwk = Array.isArray(keys)
    ? keys.find(
        (key: unknown) =>
          typeof key === "object" &&
          key !== null &&
          (key as Record<string, unknown>)["kid"] === header["kid"],
      )
    : undefined;
  if (jwk === undefined) return null;
  try {
    const publicKey = NodeCrypto.createPublicKey({
      key: jwk as NodeCrypto.JsonWebKey,
      format: "jwk",
    });
    const signed = NodeCrypto.verify(
      "RSA-SHA256",
      Buffer.from(`${segments[0]}.${segments[1]}`),
      publicKey,
      Buffer.from(segments[2] ?? "", "base64url"),
    );
    if (!signed) return null;
  } catch {
    return null;
  }
  const { iss, sub, exp, nbf } = payload;
  if (iss !== input.issuer || typeof sub !== "string" || sub.length === 0) return null;
  if (typeof exp !== "number" || exp + CLOCK_SKEW_SECONDS <= input.nowEpochSeconds) return null;
  if (typeof nbf === "number" && nbf - CLOCK_SKEW_SECONDS > input.nowEpochSeconds) return null;
  return sub;
}

let cachedJwks: {
  readonly issuer: string;
  readonly jwks: unknown;
  readonly fetchedAt: number;
} | null = null;

const fetchJwks = (issuer: string) =>
  HttpClient.get(`${issuer}/.well-known/jwks.json`).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((response) => response.json),
    Effect.timeout("10 seconds"),
    Effect.option,
  );

/** The Clerk Frontend API this build trusts, or none when Pathway Cloud is not configured. */
export const readClerkIssuer = clerkFrontendApiUrlConfig.pipe(Effect.option);

/**
 * Verifies a Clerk session token against the Clerk instance `issuer`. The JWKS is cached and
 * refetched at most once a minute when a token names a key it lacks.
 */
export const verifyCloudUser = Effect.fn("auth.cloudOwner.verifyCloudUser")(function* (
  issuer: string,
  token: string,
) {
  const nowMs = yield* Clock.currentTimeMillis;
  const verifyWith = (jwks: unknown) =>
    verifyClerkSessionToken({ token, issuer, jwks, nowEpochSeconds: Math.floor(nowMs / 1_000) });
  const cached = cachedJwks?.issuer === issuer ? cachedJwks : null;
  if (cached) {
    const subject = verifyWith(cached.jwks);
    if (subject !== null || nowMs - cached.fetchedAt < JWKS_REFRESH_INTERVAL_MS) {
      return Option.fromNullishOr(subject);
    }
  }
  const fetched = yield* fetchJwks(issuer);
  if (Option.isNone(fetched)) return Option.none<string>();
  cachedJwks = { issuer, jwks: fetched.value, fetchedAt: nowMs };
  return Option.fromNullishOr(verifyWith(fetched.value));
});

const readSecretText = (secrets: ServerSecretStore["Service"], name: string) =>
  secrets.get(name).pipe(
    Effect.option,
    Effect.map((value) =>
      Option.flatten(value).pipe(
        Option.map((bytes) => new TextDecoder().decode(bytes).trim()),
        Option.filter((text) => text.length > 0),
      ),
    ),
  );

/** The Pathway Cloud account that owns this environment, if one is known. */
export const readEnvironmentOwner = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const linked = yield* readSecretText(secrets, CLOUD_LINKED_USER_ID);
  return Option.isSome(linked) ? linked : yield* readSecretText(secrets, CLOUD_OWNER_USER_ID);
});

/** Records the desktop app's signed-in account as owner of an environment that is not linked. */
export const recordEnvironmentOwner = Effect.fn("auth.cloudOwner.recordEnvironmentOwner")(
  function* (userId: string) {
    const secrets = yield* ServerSecretStore;
    yield* secrets.set(CLOUD_OWNER_USER_ID, new TextEncoder().encode(userId));
  },
);
