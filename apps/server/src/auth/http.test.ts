// @effect-diagnostics nodeBuiltinImport:off -- the fixture signs Clerk tokens with a node:crypto RSA key
import * as NodeCrypto from "node:crypto";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthAdministrativeScopes,
  AuthComputerOperateScope,
  AuthEnvironmentBootstrapTokenType,
  AuthSessionId,
  AuthTokenExchangeGrantType,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type AuthEnvironmentScope,
} from "@spiritdevs/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpApiTest } from "effect/unstable/httpapi";

import { CLOUD_LINKED_USER_ID, CLOUD_OWNER_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import { authHttpApiLayer } from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const environmentAuthLayer = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pathway-auth-http-test-" })),
);

const clerkKeyPair = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const clerkIssuer = "https://clerk.auth-http.test";
const clerkPublishableKey = `pk_test_${Buffer.from(`clerk.auth-http.test$`).toString("base64")}`;

/** Serves the fixture JWKS to the cloud sign-in routes. */
const clerkJwksLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          keys: [{ ...clerkKeyPair.publicKey.export({ format: "jwk" }), kid: "clerk-key" }],
        }),
      ),
    ),
  ),
);

const clerkConfigLayer = ConfigProvider.layer(
  ConfigProvider.fromEnv({ env: { PATHWAY_CLERK_PUBLISHABLE_KEY: clerkPublishableKey } }),
);

function clerkSessionToken(userId: string) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "RS256", kid: "clerk-key" })}.${encode({
    iss: clerkIssuer,
    sub: userId,
    // Tests run on the TestClock, so any future expiry is current.
    exp: 4_102_444_800,
  })}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    Buffer.from(signingInput),
    clerkKeyPair.privateKey,
  ).toString("base64url");
  return `${signingInput}.${signature}`;
}

const writeSecretText = (name: string, value: string) =>
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(name, new TextEncoder().encode(value));
  });

/** The real auth routes, with the caller authenticated as a session holding `scopes`. */
const authClient = Effect.fnUntraced(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const requestServices = yield* Effect.context<
    Crypto.Crypto | ServerSecretStore.ServerSecretStore
  >();
  return yield* HttpApiTest.groups(EnvironmentHttpApi, ["auth"]).pipe(
    Effect.provide(
      Layer.mergeAll(
        authHttpApiLayer.pipe(
          HttpRouter.provideRequest(Layer.succeedContext(requestServices)),
          Layer.provide([clerkJwksLayer, clerkConfigLayer]),
        ),
        NodeHttpServer.layerHttpServices,
      ),
    ),
    Effect.provideService(EnvironmentAuthenticatedAuth, (httpEffect) =>
      httpEffect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("test-session"),
          subject: "test-client",
          method: "bearer-access-token",
          scopes: new Set(scopes),
          expiresAt: DateTime.makeUnsafe("2030-01-01T00:00:00.000Z"),
        }),
      ),
    ),
  );
});

it.layer(NodeServices.layer)("auth HTTP routes", (it) => {
  it.effect("exchanges a pairing credential for computer:operate at /oauth/token", () =>
    Effect.gen(function* () {
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const client = yield* authClient(AuthAdministrativeScopes);
      const pairing = yield* serverAuth.issuePairingCredential();

      const token = yield* client.auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: pairing.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: "orchestration:read computer:operate",
        },
      });

      expect(token.scope).toBe("orchestration:read computer:operate");
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("refuses to delegate computer:operate from a session that lacks it", () =>
    Effect.gen(function* () {
      // An administrative session issued before computer:operate existed.
      const client = yield* authClient(
        AuthAdministrativeScopes.filter((scope) => scope !== AuthComputerOperateScope),
      );

      const error = yield* client.auth
        .pairingCredential({
          headers: {},
          payload: { scopes: ["orchestration:read", AuthComputerOperateScope] },
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentScopeRequiredError",
        requiredScope: AuthComputerOperateScope,
      });
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
  it.effect("signs the environment owner in with their Pathway Cloud session", () =>
    Effect.gen(function* () {
      yield* writeSecretText(CLOUD_OWNER_USER_ID, "user_owner");
      const client = yield* authClient([]);

      const session = yield* client.auth.cloudSession({
        payload: { clerkToken: clerkSessionToken("user_owner") },
      });

      expect(session.authenticated).toBe(true);
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("refuses a Pathway Cloud account that does not own the environment", () =>
    Effect.gen(function* () {
      yield* writeSecretText(CLOUD_LINKED_USER_ID, "user_owner");
      yield* writeSecretText(CLOUD_OWNER_USER_ID, "user_other");
      const client = yield* authClient([]);

      const error = yield* client.auth
        .cloudSession({ payload: { clerkToken: clerkSessionToken("user_other") } })
        .pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "EnvironmentAuthInvalidError",
        reason: "not_environment_owner",
      });
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("records the desktop app's signed-in account as owner", () =>
    Effect.gen(function* () {
      const client = yield* authClient(AuthAdministrativeScopes);

      const result = yield* client.auth.cloudOwner({
        headers: {},
        payload: { clerkToken: clerkSessionToken("user_desktop") },
      });

      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const stored = yield* secrets.get(CLOUD_OWNER_USER_ID);
      expect(result.ownerUserId).toBe("user_desktop");
      expect(Option.map(stored, (bytes) => new TextDecoder().decode(bytes))).toEqual(
        Option.some("user_desktop"),
      );
    }).pipe(Effect.provide(environmentAuthLayer)),
  );

  it.effect("requires access write scope to record the owner", () =>
    Effect.gen(function* () {
      const client = yield* authClient(["orchestration:read"]);

      const error = yield* client.auth
        .cloudOwner({ headers: {}, payload: { clerkToken: clerkSessionToken("user_desktop") } })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "EnvironmentScopeRequiredError" });
    }).pipe(Effect.provide(environmentAuthLayer)),
  );
});
