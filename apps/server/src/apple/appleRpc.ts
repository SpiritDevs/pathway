import type { AppleIdSessionState } from "@spiritdevs/contracts/apple";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
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
import { AppleIdSession } from "./AppleIdSession.ts";
import * as Queue from "effect/Queue";

export function makeAppleRpcHandlers(
  runtime: AppleRuntime,
  scopes: readonly AuthEnvironmentScope[],
  sessions: AppleIdSession,
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
  return {
    [APPLE_WS_METHODS.registerBundleId]: (input) =>
      guard(APPLE_WS_METHODS.registerBundleId, input, () => runtime.registerBundleId(input)),
    [APPLE_WS_METHODS.createApp]: (input) =>
      guard(APPLE_WS_METHODS.createApp, input, () => runtime.status(input)).pipe(
        Effect.andThen(
          Effect.fail(
            new AppleError({
              code: "not-implemented",
              message: "App creation is not supported by the Apple ID download session service.",
              retryAfterSeconds: null,
            }),
          ),
        ),
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
    [APPLE_WS_METHODS.appleIdStart]: (input) =>
      guard(APPLE_WS_METHODS.appleIdStart, input, () => sessions.start(input, input.password)),
    [APPLE_WS_METHODS.appleIdComplete]: (input) =>
      guard(APPLE_WS_METHODS.appleIdComplete, input, () =>
        sessions.complete(input, input.flowId, input.code),
      ),
    [APPLE_WS_METHODS.appleIdRequestCode]: (input) =>
      guard(APPLE_WS_METHODS.appleIdRequestCode, input, () =>
        sessions.requestCode(input, input.flowId, input.phoneNumberId),
      ),
    [APPLE_WS_METHODS.appleIdCancel]: (input) =>
      guard(APPLE_WS_METHODS.appleIdCancel, input, () => sessions.cancel(input, input.flowId)),
    [APPLE_WS_METHODS.appleIdSignOut]: (input) =>
      guard(APPLE_WS_METHODS.appleIdSignOut, input, () => sessions.signOut(input)),
    [APPLE_WS_METHODS.appleIdStatus]: (input) =>
      guard(APPLE_WS_METHODS.appleIdStatus, input, () => sessions.status(input)),
    [APPLE_WS_METHODS.appleIdSubscribe]: (input) =>
      Stream.callback<typeof AppleIdSessionState.Type, AppleError | EnvironmentAuthorizationError>(
        (queue) =>
          Effect.gen(function* () {
            const initial = yield* guard(APPLE_WS_METHODS.appleIdSubscribe, input, () =>
              sessions.status(input),
            );
            yield* Effect.acquireRelease(
              Effect.sync(() => sessions.watch(input, (state) => Queue.offerUnsafe(queue, state))),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            Queue.offerUnsafe(queue, initial);
            // Re-read after registering to cover a challenge racing the initial authorization.
            yield* guard(APPLE_WS_METHODS.appleIdSubscribe, input, () => sessions.status(input));
          }),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(
        Stream.mapEffect(() =>
          guard(APPLE_WS_METHODS.appleIdSubscribe, input, () => sessions.status(input)),
        ),
      ),
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof AppleRpcs>>;
}
export const makeAppleRpcLayer = (
  runtime: AppleRuntime,
  scopes: readonly AuthEnvironmentScope[],
  sessions: AppleIdSession,
) =>
  AppleRpcs.toLayer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const secrets = yield* ServerSecretStore;
      const session = authenticatedWebSocketSession(request);
      const caller = session
        ? resolveAppleCaller(session).pipe(Effect.provideService(ServerSecretStore, secrets))
        : Effect.succeed(null);
      return makeAppleRpcHandlers(runtime, scopes, sessions, caller);
    }),
  );
