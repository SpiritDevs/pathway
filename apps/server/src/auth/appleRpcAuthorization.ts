import { AppleError } from "@spiritdevs/contracts/apple";
import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import { safeAppleError, type AppleRuntime } from "../apple/AppleRuntime.ts";
import type { AppleCaller } from "./appleCaller.ts";
import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

/** Scopes authorize the host action; Cloud separately authorizes the current user and account. */
export function makeAppleCallerGuard(
  runtime: Pick<AppleRuntime, "authorizeCaller">,
  scopes: readonly AuthEnvironmentScope[],
  resolveCaller: Effect.Effect<AppleCaller | null>,
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
  return <A, E>(
    method: string,
    target: { companyId: string; accountId: string },
    run: Effect.Effect<A, E>,
  ): Effect.Effect<A, E | AppleError | EnvironmentAuthorizationError> => {
    const requiredScope = requiredScopeForRpcMethod(method);
    const operation: Effect.Effect<A, E | AppleError | EnvironmentAuthorizationError> =
      scopes.includes(requiredScope)
        ? Effect.gen(function* () {
            const authorize = Effect.gen(function* () {
              const caller = yield* requireCaller;
              yield* Effect.tryPromise({
                try: () =>
                  runtime.authorizeCaller({
                    companyId: target.companyId,
                    accountId: target.accountId,
                    caller,
                    manage: requiredScope === "orchestration:operate",
                  }),
                catch: safeAppleError,
              });
            });
            yield* authorize;
            const result = yield* run;
            yield* authorize;
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
}
