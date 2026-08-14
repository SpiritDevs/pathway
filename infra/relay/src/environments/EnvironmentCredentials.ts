import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
  RelayManagedEndpoint,
} from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { api } from "@t3tools/backend/convexApi";

import { RelayConvexClient } from "../db.ts";

export class EnvironmentCredentialCreatePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialCreatePersistenceError>()(
  "EnvironmentCredentialCreatePersistenceError",
  {
    stage: Schema.Literals([
      "generate-credential",
      "hash-token",
      "insert-credential",
      "revoke-previous-credentials",
    ]),
    environmentId: Schema.String,
    credentialId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential creation failed during '${this.stage}' for environment '${this.environmentId}'${this.credentialId === undefined ? "" : `, credential '${this.credentialId}'`}`;
  }
}

export class EnvironmentCredentialAuthenticatePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialAuthenticatePersistenceError>()(
  "EnvironmentCredentialAuthenticatePersistenceError",
  {
    stage: Schema.Literals(["hash-token", "lookup-credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential authentication failed during '${this.stage}'`;
  }
}

export class EnvironmentCredentialRevokePersistenceError extends Schema.TaggedErrorClass<EnvironmentCredentialRevokePersistenceError>()(
  "EnvironmentCredentialRevokePersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke credentials for environment '${this.environmentId}'`;
  }
}

export interface EnvironmentCredentialPrincipal {
  readonly credentialId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}

export class EnvironmentCredentials extends Context.Service<
  EnvironmentCredentials,
  {
    readonly create: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<string, EnvironmentCredentialCreatePersistenceError>;
    readonly replaceLinkAndCreate: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkRequest;
      readonly proof: RelayEnvironmentLinkProofPayload;
      readonly endpoint: RelayManagedEndpoint;
    }) => Effect.Effect<string, EnvironmentCredentialCreatePersistenceError>;
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<
      Option.Option<EnvironmentCredentialPrincipal>,
      EnvironmentCredentialAuthenticatePersistenceError
    >;
    readonly revokeForEnvironmentPublicKey: (input: {
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<boolean, EnvironmentCredentialRevokePersistenceError>;
  }
>()("pathway-relay/environments/EnvironmentCredentials") {}

const make = Effect.gen(function* () {
  const client = yield* RelayConvexClient;
  const crypto = yield* Crypto.Crypto;
  const hashToken = (token: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.map(Encoding.encodeBase64Url));
  const randomTokenPart = (segments: number) =>
    Effect.map(Effect.all(Array.from({ length: segments }, () => crypto.randomUUIDv4)), (values) =>
      values.join("").replaceAll("-", ""),
    );
  const makeCredential = Effect.fnUntraced(function* () {
    const credentialId = yield* randomTokenPart(2);
    const secret = yield* randomTokenPart(3);
    return {
      credentialId,
      token: `t3env_${credentialId}_${secret}`,
    };
  });
  const prepareCredential = Effect.fn("relay.environment_credentials.prepare")(function* (
    environmentId: string,
  ) {
    const credential = yield* makeCredential().pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentCredentialCreatePersistenceError({
            stage: "generate-credential",
            environmentId,
            cause,
          }),
      ),
    );
    const credentialHash = yield* hashToken(credential.token).pipe(
      Effect.mapError(
        (cause) =>
          new EnvironmentCredentialCreatePersistenceError({
            stage: "hash-token",
            environmentId,
            credentialId: credential.credentialId,
            cause,
          }),
      ),
    );
    return { ...credential, credentialHash };
  });

  return EnvironmentCredentials.of({
    create: Effect.fn("relay.environment_credentials.create")(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const credential = yield* prepareCredential(input.environmentId);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* client
        .mutation(api.relayPersistence.insertEnvironmentCredential, {
          credentialId: credential.credentialId,
          environmentId: input.environmentId,
          environmentPublicKey: input.environmentPublicKey,
          credentialHash: credential.credentialHash,
          now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialCreatePersistenceError({
                stage: "insert-credential",
                environmentId: input.environmentId,
                credentialId: credential.credentialId,
                cause,
              }),
          ),
        );
      return credential.token;
    }),

    replaceLinkAndCreate: Effect.fn("relay.environment_credentials.replace_link_and_create")(
      function* (input) {
        const environmentId = input.proof.environmentId;
        const credential = yield* prepareCredential(environmentId);
        const now = DateTime.formatIso(yield* DateTime.now);
        yield* client
          .mutation(api.relayPersistence.replaceEnvironmentLinkAndCredential, {
            userId: input.userId,
            environmentId,
            environmentLabel: input.proof.descriptor.label,
            environmentPublicKey: input.proof.environmentPublicKey,
            endpointHttpBaseUrl: input.endpoint.httpBaseUrl,
            endpointWsBaseUrl: input.endpoint.wsBaseUrl,
            endpointProviderKind: input.endpoint.providerKind,
            notificationsEnabled: input.request.notificationsEnabled,
            liveActivitiesEnabled: input.request.liveActivitiesEnabled,
            managedTunnelsEnabled: input.request.managedTunnelsEnabled,
            createdByDeviceId: input.request.deviceId ?? null,
            credentialId: credential.credentialId,
            credentialHash: credential.credentialHash,
            now,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new EnvironmentCredentialCreatePersistenceError({
                  stage: "insert-credential",
                  environmentId,
                  credentialId: credential.credentialId,
                  cause,
                }),
            ),
          );
        return credential.token;
      },
    ),

    authenticate: Effect.fn("relay.environment_credentials.authenticate")(function* (token) {
      const credentialHash = yield* hashToken(token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialAuthenticatePersistenceError({
              stage: "hash-token",
              cause,
            }),
        ),
      );
      const row = yield* client
        .query(api.relayPersistence.authenticateEnvironmentCredential, { credentialHash })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialAuthenticatePersistenceError({
                stage: "lookup-credential",
                cause,
              }),
          ),
        );
      if (row) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": row.environmentId });
      }
      return row
        ? Option.some({
            credentialId: row.credentialId,
            environmentId: row.environmentId,
            environmentPublicKey: row.environmentPublicKey,
          })
        : Option.none();
    }),

    revokeForEnvironmentPublicKey: Effect.fn(
      "relay.environment_credentials.revoke_for_environment_public_key",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      return yield* client
        .mutation(api.relayPersistence.revokeEnvironmentCredentialsForPublicKey, {
          ...input,
          now: revokedAt,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialRevokePersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
    }),
  });
});

export const layer = Layer.effect(EnvironmentCredentials, make);
