import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "@spiritdevs/contracts";
import {
  SimBuildError,
  SimBuildRpcs,
  SIM_BUILD_WS_METHODS,
  type SimBuildJobInput,
} from "@spiritdevs/contracts/simBuild";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { safeSimBuildError, type SimBuildRuntime } from "./SimBuildRuntime.ts";

export function makeSimBuildRpcHandlers(
  runtime: SimBuildRuntime,
  scopes: readonly AuthEnvironmentScope[],
) {
  const guard = <A>(
    method: string,
    run: (signal: AbortSignal) => Promise<A>,
  ): Effect.Effect<A, SimBuildError | EnvironmentAuthorizationError> => {
    const requiredScope = requiredScopeForRpcMethod(method);
    return scopes.includes(requiredScope)
      ? Effect.tryPromise({ try: run, catch: safeSimBuildError })
      : Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope,
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
          }),
        );
  };
  const subscribe = (input: SimBuildJobInput) =>
    Stream.unwrap(
      Effect.sync(() => {
        let receipt = 0;
        let log = 0;
        return Stream.callback<void, SimBuildError | EnvironmentAuthorizationError>(
          (queue) =>
            Effect.acquireRelease(
              guard(SIM_BUILD_WS_METHODS.subscribe, () =>
                runtime.watch(input, () => {
                  Queue.offerUnsafe(queue, undefined);
                }),
              ),
              (stop) => Effect.sync(stop),
            ).pipe(Effect.catch((error) => Queue.fail(queue, error))),
          { bufferSize: 1, strategy: "sliding" },
        ).pipe(
          Stream.mapEffect(() =>
            guard(SIM_BUILD_WS_METHODS.subscribe, async () => {
              const update = await runtime.get(input, receipt, log);
              receipt = update.receipts.at(-1)?.sequence ?? receipt;
              log = update.nextLogSequence - 1;
              return update;
            }),
          ),
          Stream.takeUntil((update) => update.job.terminal),
        );
      }),
    );
  return {
    [SIM_BUILD_WS_METHODS.discover]: (input) =>
      guard(SIM_BUILD_WS_METHODS.discover, (signal) => runtime.discover(input, signal)),
    [SIM_BUILD_WS_METHODS.start]: (input) =>
      guard(SIM_BUILD_WS_METHODS.start, () => runtime.start(input)),
    [SIM_BUILD_WS_METHODS.list]: (input) =>
      guard(SIM_BUILD_WS_METHODS.list, () => runtime.list(input)),
    [SIM_BUILD_WS_METHODS.get]: (input) =>
      guard(SIM_BUILD_WS_METHODS.get, () => runtime.get(input)),
    [SIM_BUILD_WS_METHODS.cancel]: (input) =>
      guard(SIM_BUILD_WS_METHODS.cancel, () => runtime.cancel(input)),
    [SIM_BUILD_WS_METHODS.subscribe]: subscribe,
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof SimBuildRpcs>>;
}
export const makeSimBuildRpcLayer = (
  runtime: SimBuildRuntime,
  scopes: readonly AuthEnvironmentScope[],
) => SimBuildRpcs.toLayer(makeSimBuildRpcHandlers(runtime, scopes));
