import { APPLE_WS_METHODS, AppleRpcs, AppleError } from "@spiritdevs/contracts/apple";
import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/unstable/http";
import { authenticatedWebSocketSession } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { resolveAppleCaller, type AppleCaller } from "../auth/appleCaller.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { AppleRuntime, safeAppleError } from "./AppleRuntime.ts";
import { appleIdSessionStub } from "./AppleIdSession.ts";

export function makeAppleRpcHandlers(
  runtime: AppleRuntime,
  scopes: readonly AuthEnvironmentScope[],
  resolveCaller: Effect.Effect<AppleCaller | null> = Effect.succeed(null),
) {
  const requireCaller = resolveCaller.pipe(
    Effect.flatMap((caller) =>
      caller
        ? Effect.succeed(caller)
        : Effect.fail(
            new AppleError({
              code: "forbidden",
              message: "A known Pathway Cloud user is required to use Apple accounts.",
              retryAfterSeconds: null,
            }),
          ),
    ),
  );
  const guard = <A>(
    method: string,
    target: { companyId: string; accountId: string },
    run: () => Promise<A>,
  ): Effect.Effect<A, AppleError | EnvironmentAuthorizationError> => {
    const requiredScope = requiredScopeForRpcMethod(method);
    const operation: Effect.Effect<A, AppleError | EnvironmentAuthorizationError> = scopes.includes(
      requiredScope,
    )
      ? Effect.gen(function* () {
          const caller = yield* requireCaller;
          const authorization = {
            companyId: target.companyId,
            accountId: target.accountId,
            caller,
            manage: requiredScope === "orchestration:operate",
          };
          const result = yield* Effect.tryPromise({
            try: async () => {
              await runtime.authorizeCaller(authorization);
              return await run();
            },
            catch: safeAppleError,
          });
          yield* requireCaller;
          yield* Effect.tryPromise({
            try: () => runtime.authorizeCaller(authorization),
            catch: safeAppleError,
          });
          return result;
        })
      : Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope,
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
          }),
        );
    return operation.pipe(Effect.provideService(References.TracerEnabled, false));
  };
  const stub = (method: string, input: { companyId: string; accountId: string }) =>
    guard(method, input, () =>
      runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
    ).pipe(Effect.andThen(appleIdSessionStub.unavailable));
  return AppleRpcs.of({
    [APPLE_WS_METHODS.registerBundleId]: (input) =>
      guard(APPLE_WS_METHODS.registerBundleId, input, () => runtime.registerBundleId(input)),
    [APPLE_WS_METHODS.createApp]: (input) =>
      guard(APPLE_WS_METHODS.createApp, input, () => runtime.status(input)).pipe(
        Effect.andThen(appleIdSessionStub.createApp),
      ),
    [APPLE_WS_METHODS.status]: (input) =>
      guard(APPLE_WS_METHODS.status, input, () => runtime.status(input)),
    [APPLE_WS_METHODS.testConnection]: (input) =>
      guard(APPLE_WS_METHODS.testConnection, input, () => runtime.testConnection(input)),
    [APPLE_WS_METHODS.listApps]: (input) =>
      guard(APPLE_WS_METHODS.listApps, input, () => runtime.listApps(input)),
    [APPLE_WS_METHODS.listBuilds]: (input) =>
      guard(APPLE_WS_METHODS.listBuilds, input, () => runtime.listBuilds(input, input.appId)),
    [APPLE_WS_METHODS.listBetaGroups]: (input) =>
      guard(APPLE_WS_METHODS.listBetaGroups, input, () =>
        runtime.listBetaGroups(input, input.appId),
      ),
    [APPLE_WS_METHODS.appleIdStart]: (input) => stub(APPLE_WS_METHODS.appleIdStart, input),
    [APPLE_WS_METHODS.appleIdComplete]: (input) => stub(APPLE_WS_METHODS.appleIdComplete, input),
    [APPLE_WS_METHODS.appleIdCancel]: (input) => stub(APPLE_WS_METHODS.appleIdCancel, input),
    [APPLE_WS_METHODS.appleIdSignOut]: (input) => stub(APPLE_WS_METHODS.appleIdSignOut, input),
    [APPLE_WS_METHODS.appleIdStatus]: (input) =>
      guard(APPLE_WS_METHODS.appleIdStatus, input, () =>
        runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
      ).pipe(Effect.andThen(appleIdSessionStub.status)),
    [APPLE_WS_METHODS.appleIdSubscribe]: (input) =>
      Stream.fromEffect(
        guard(APPLE_WS_METHODS.appleIdSubscribe, input, () =>
          runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
        ),
      ).pipe(Stream.flatMap(() => appleIdSessionStub.changes)),
  });
}
export const makeAppleRpcLayer = (runtime: AppleRuntime, scopes: readonly AuthEnvironmentScope[]) =>
  AppleRpcs.toLayer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const secrets = yield* ServerSecretStore;
      const session = authenticatedWebSocketSession(request);
      const caller = session
        ? resolveAppleCaller(session).pipe(Effect.provideService(ServerSecretStore, secrets))
        : Effect.succeed(null);
      return makeAppleRpcHandlers(runtime, scopes, caller);
    }),
  );
