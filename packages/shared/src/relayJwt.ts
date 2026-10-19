import {
  decodeJwt,
  decodeProtectedHeader,
  exportJWK,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type JWK,
  type JWTPayload,
} from "jose";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

export const RELAY_LINK_PROOF_TYP = "pathway-env-link+jwt";
export const RELAY_MINT_REQUEST_TYP = "pathway-cloud-mint+jwt";
export const RELAY_HEALTH_REQUEST_TYP = "pathway-cloud-health+jwt";
export const RELAY_MINT_RESPONSE_TYP = "pathway-env-mint+jwt";
export const RELAY_HEALTH_RESPONSE_TYP = "pathway-env-health+jwt";
export const RELAY_ACTIVITY_PUBLISH_TYP = "pathway-env-activity+jwt";
/** Relay-issued environment service token for the `pathway-convex` audience. */
export const RELAY_CONVEX_SERVICE_TOKEN_TYP = "pathway-relay-convex-service+jwt";
/** Relay worker identity for its own Convex persistence calls. */
export const RELAY_CONVEX_CONTROL_PLANE_TOKEN_TYP = "pathway-relay-convex-control-plane+jwt";
/** Convex-issued connect grant the relay validates against its configured Convex issuer. */
export const RELAY_CONVEX_CONNECT_GRANT_TYP = "pathway-convex-connect-grant+jwt";

export class RelayJwtError extends Schema.TaggedErrorClass<RelayJwtError>()("RelayJwtError", {
  operation: Schema.Literals(["sign", "verify"]),
  typ: Schema.String,
  issuer: Schema.optional(Schema.String),
  audience: Schema.optional(Schema.String),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to ${this.operation} relay JWT of type "${this.typ}".`;
  }

  static diagnosticCode(error: RelayJwtError): string {
    if (
      Predicate.isObject(error.cause) &&
      Predicate.hasProperty(error.cause, "code") &&
      Predicate.isString(error.cause.code) &&
      error.cause.code.length > 0
    ) {
      return error.cause.code;
    }

    return error.cause instanceof Error && error.cause.name ? error.cause.name : "unknown";
  }
}

export function normalizeRelayIssuer(value: string): string {
  return value.trim().replace(/\/+$/gu, "");
}

export function decodeRelayJwt(token: string): JWTPayload {
  return decodeJwt(token);
}

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n").trim();
}

export function signRelayJwt(input: {
  readonly privateKey: string;
  readonly typ: string;
  readonly payload: JWTPayload;
}): Effect.Effect<string, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importPKCS8(normalizePem(input.privateKey), "EdDSA");
      return new SignJWT(input.payload)
        .setProtectedHeader({ alg: "EdDSA", typ: input.typ })
        .sign(key);
    },
    catch: (cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause }),
  });
}

export function verifyRelayJwt(input: {
  readonly publicKey: string;
  readonly token: string;
  readonly typ: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  readonly maxTokenAge?: string | number;
}): Effect.Effect<JWTPayload, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importSPKI(normalizePem(input.publicKey), "EdDSA");
      const verified = await jwtVerify(input.token, key, {
        algorithms: ["EdDSA"],
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        maxTokenAge: input.maxTokenAge ?? "5 minutes",
        clockTolerance: 60,
        currentDate: DateTime.toDate(DateTime.makeUnsafe(input.nowEpochSeconds * 1_000)),
      });
      return verified.payload;
    },
    catch: (cause) =>
      new RelayJwtError({
        operation: "verify",
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        cause,
      }),
  });
}

export interface RelayEs256PublicJwk extends JWK {
  readonly alg: "ES256";
  readonly crv: "P-256";
  readonly kid: string;
  readonly kty: "EC";
  readonly use: "sig";
}

export function relayEs256PublicJwk(input: {
  readonly keyId: string;
  readonly publicKey: string;
}): Effect.Effect<RelayEs256PublicJwk, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importSPKI(normalizePem(input.publicKey), "ES256");
      const exported = await exportJWK(key);
      if (exported.kty !== "EC" || exported.crv !== "P-256") {
        throw new Error("Relay Convex signing key must be a P-256 EC key");
      }
      return {
        ...exported,
        alg: "ES256",
        crv: "P-256",
        kid: input.keyId,
        kty: "EC",
        use: "sig",
      };
    },
    catch: (cause) =>
      new RelayJwtError({ operation: "verify", typ: "relay-es256-public-jwk", cause }),
  });
}

export function signRelayEs256Jwt(input: {
  readonly privateKey: string;
  readonly keyId: string;
  readonly typ: string;
  readonly payload: JWTPayload;
}): Effect.Effect<string, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const key = await importPKCS8(normalizePem(input.privateKey), "ES256");
      return new SignJWT(input.payload)
        .setProtectedHeader({ alg: "ES256", typ: input.typ, kid: input.keyId })
        .sign(key);
    },
    catch: (cause) => new RelayJwtError({ operation: "sign", typ: input.typ, cause }),
  });
}

export function verifyRelayEs256Jwt(input: {
  readonly publicKeys: ReadonlyArray<{ readonly keyId: string; readonly publicKey: string }>;
  readonly token: string;
  readonly typ: string;
  readonly issuer: string;
  readonly audience: string;
  readonly nowEpochSeconds: number;
  readonly maxTokenAge?: string | number;
}): Effect.Effect<JWTPayload, RelayJwtError> {
  return Effect.tryPromise({
    try: async () => {
      const header = decodeProtectedHeader(input.token);
      if (header.alg !== "ES256" || typeof header.kid !== "string") {
        throw new Error("Relay Convex JWT is missing its ES256 key identifier");
      }
      const matchingKey = input.publicKeys.find((key) => key.keyId === header.kid);
      if (matchingKey === undefined) {
        throw new Error("Relay Convex JWT uses an unknown signing key");
      }
      const key = await importSPKI(normalizePem(matchingKey.publicKey), "ES256");
      const verified = await jwtVerify(input.token, key, {
        algorithms: ["ES256"],
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        maxTokenAge: input.maxTokenAge ?? "5 minutes",
        clockTolerance: 60,
        currentDate: DateTime.toDate(DateTime.makeUnsafe(input.nowEpochSeconds * 1_000)),
      });
      return verified.payload;
    },
    catch: (cause) =>
      new RelayJwtError({
        operation: "verify",
        typ: input.typ,
        issuer: input.issuer,
        audience: input.audience,
        cause,
      }),
  });
}
