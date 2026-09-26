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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { HttpApiTest } from "effect/unstable/httpapi";

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

/** The real auth routes, with the caller authenticated as a session holding `scopes`. */
const authClient = Effect.fnUntraced(function* (scopes: ReadonlyArray<AuthEnvironmentScope>) {
  const requestServices = yield* Effect.context<
    Crypto.Crypto | ServerSecretStore.ServerSecretStore
  >();
  return yield* HttpApiTest.groups(EnvironmentHttpApi, ["auth"]).pipe(
    Effect.provide(
      Layer.mergeAll(
        authHttpApiLayer.pipe(HttpRouter.provideRequest(Layer.succeedContext(requestServices))),
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
});
