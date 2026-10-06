/** Resolves the environment's linked account through its authenticated Cloud transport. */
import { api } from "@spiritdevs/backend/convexApi";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { SyncTransportError } from "@spiritdevs/client-runtime/sync";
import * as Effect from "effect/Effect";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  classifyConvexFailure,
  convexHttpClientLike,
  type ConvexClientLike,
} from "./convexSyncTransport.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

export const queryEnvironmentAccountUser = Effect.fn("cloud.queryEnvironmentAccountUser")(
  function* (input: { client: ConvexClientLike; tokens: ConvexServiceTokenProvider }) {
    const call = (token: string) =>
      Effect.tryPromise({
        try: () => {
          input.client.setAuth(token);
          return input.client.query(api.connectGrants.accountUser, {});
        },
        catch: (cause) =>
          new SyncTransportError({
            reason: classifyConvexFailure(cause),
            message: cause instanceof Error ? cause.message : String(cause),
          }),
      });
    const token = yield* input.tokens.token;
    return yield* call(token).pipe(
      Effect.catchIf(
        (error) => error.reason === "unauthorized",
        () =>
          input.tokens
            .invalidate(token)
            .pipe(Effect.andThen(input.tokens.token), Effect.flatMap(call)),
      ),
    );
  },
);

export const resolveEnvironmentAccountUser = Effect.fn("cloud.resolveEnvironmentAccountUser")(
  function* (environmentId: EnvironmentId) {
    const config = yield* resolveCloudSyncConfig;
    if (config._tag !== "Configured")
      return yield* new SyncTransportError({
        reason: "unauthorized",
        message: "Sign in to Pathway Cloud before investigating.",
      });
    const secrets = yield* ServerSecretStore;
    const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
    const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
    return yield* queryEnvironmentAccountUser({
      client: convexHttpClientLike(config.settings.convexUrl),
      tokens,
    });
  },
);
