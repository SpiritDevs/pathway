import { APPLE_WS_METHODS, AppleRpcs, AppleError } from "@spiritdevs/contracts/apple";
import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { AppleRuntime, safeAppleError } from "./AppleRuntime.ts";
import { appleIdSessionStub } from "./AppleIdSession.ts";

export function makeAppleRpcHandlers(
  runtime: AppleRuntime,
  scopes: readonly AuthEnvironmentScope[],
) {
  const guard = <A>(
    method: string,
    run: () => Promise<A>,
  ): Effect.Effect<A, AppleError | EnvironmentAuthorizationError> => {
    const requiredScope = requiredScopeForRpcMethod(method);
    const operation: Effect.Effect<A, AppleError | EnvironmentAuthorizationError> = scopes.includes(
      requiredScope,
    )
      ? Effect.tryPromise({ try: run, catch: safeAppleError })
      : Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope,
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
          }),
        );
    return operation.pipe(Effect.provideService(References.TracerEnabled, false));
  };
  const stub = (method: string, input: { companyId: string; accountId: string }) =>
    guard(method, () =>
      runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
    ).pipe(Effect.andThen(appleIdSessionStub.unavailable));
  return AppleRpcs.of({
    [APPLE_WS_METHODS.registerBundleId]: (input) =>
      guard(APPLE_WS_METHODS.registerBundleId, () => runtime.registerBundleId(input)),
    [APPLE_WS_METHODS.createApp]: (input) =>
      guard(APPLE_WS_METHODS.createApp, () => runtime.status(input)).pipe(
        Effect.andThen(appleIdSessionStub.createApp),
      ),
    [APPLE_WS_METHODS.status]: (input) =>
      guard(APPLE_WS_METHODS.status, () => runtime.status(input)),
    [APPLE_WS_METHODS.testConnection]: (input) =>
      guard(APPLE_WS_METHODS.testConnection, () => runtime.testConnection(input)),
    [APPLE_WS_METHODS.listApps]: (input) =>
      guard(APPLE_WS_METHODS.listApps, () => runtime.listApps(input)),
    [APPLE_WS_METHODS.listBuilds]: (input) =>
      guard(APPLE_WS_METHODS.listBuilds, () => runtime.listBuilds(input, input.appId)),
    [APPLE_WS_METHODS.listBetaGroups]: (input) =>
      guard(APPLE_WS_METHODS.listBetaGroups, () => runtime.listBetaGroups(input, input.appId)),
    [APPLE_WS_METHODS.appleIdStart]: (input) => stub(APPLE_WS_METHODS.appleIdStart, input),
    [APPLE_WS_METHODS.appleIdComplete]: (input) => stub(APPLE_WS_METHODS.appleIdComplete, input),
    [APPLE_WS_METHODS.appleIdCancel]: (input) => stub(APPLE_WS_METHODS.appleIdCancel, input),
    [APPLE_WS_METHODS.appleIdSignOut]: (input) => stub(APPLE_WS_METHODS.appleIdSignOut, input),
    [APPLE_WS_METHODS.appleIdStatus]: (input) =>
      guard(APPLE_WS_METHODS.appleIdStatus, () =>
        runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
      ).pipe(Effect.andThen(appleIdSessionStub.status)),
    [APPLE_WS_METHODS.appleIdSubscribe]: (input) =>
      Stream.fromEffect(
        guard(APPLE_WS_METHODS.appleIdSubscribe, () =>
          runtime.accountStatus({ companyId: input.companyId, accountId: input.accountId }),
        ),
      ).pipe(Stream.flatMap(() => appleIdSessionStub.changes)),
  });
}
export const makeAppleRpcLayer = (runtime: AppleRuntime, scopes: readonly AuthEnvironmentScope[]) =>
  AppleRpcs.toLayer(makeAppleRpcHandlers(runtime, scopes));
