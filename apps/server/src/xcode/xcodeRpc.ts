import type { XcodeStatus } from "@spiritdevs/contracts/xcode";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { XCODE_WS_METHODS, XcodeError, XcodeRpcs } from "@spiritdevs/contracts/xcode";
import { EnvironmentAuthorizationError, type AuthEnvironmentScope } from "@spiritdevs/contracts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { type XcodeInstall, xcodeError } from "./XcodeInstall.ts";
const isXcodeError = Schema.is(XcodeError);
export function makeXcodeRpcHandlers(
  runtime: XcodeInstall,
  scopes: readonly AuthEnvironmentScope[],
) {
  const guard = <A>(
    method: string,
    run: () => Promise<A>,
  ): Effect.Effect<A, XcodeError | EnvironmentAuthorizationError> => {
    const requiredScope = requiredScopeForRpcMethod(method);
    return scopes.includes(requiredScope)
      ? Effect.tryPromise({
          try: run,
          catch: (error) =>
            isXcodeError(error)
              ? error
              : xcodeError("process-failed", "The Xcode operation failed."),
        })
      : Effect.fail(
          new EnvironmentAuthorizationError({
            requiredScope,
            message: `The authenticated token is missing required scope: ${requiredScope}.`,
          }),
        );
  };
  return {
    [XCODE_WS_METHODS.status]: () => guard(XCODE_WS_METHODS.status, () => runtime.status()),
    [XCODE_WS_METHODS.install]: (input) =>
      guard(XCODE_WS_METHODS.install, () =>
        runtime.install(input, input.versionId, input.platforms),
      ),
    [XCODE_WS_METHODS.cancel]: (input) =>
      guard(XCODE_WS_METHODS.cancel, () => runtime.cancel(input.jobId)),
    [XCODE_WS_METHODS.retry]: (input) =>
      guard(XCODE_WS_METHODS.retry, () => runtime.retry(input.jobId)),
    [XCODE_WS_METHODS.approve]: (input) =>
      guard(XCODE_WS_METHODS.approve, () => runtime.approve(input.jobId)),
    [XCODE_WS_METHODS.select]: (input) =>
      guard(XCODE_WS_METHODS.select, () => runtime.select(input.path)),
    [XCODE_WS_METHODS.installRuntimes]: (input) =>
      guard(XCODE_WS_METHODS.installRuntimes, () =>
        runtime.installRuntimes(input.path, input.platforms),
      ),
    [XCODE_WS_METHODS.subscribe]: () =>
      Stream.callback<XcodeStatus, XcodeError | EnvironmentAuthorizationError>(
        (queue) =>
          Effect.gen(function* () {
            const initial = yield* guard(XCODE_WS_METHODS.subscribe, () => runtime.status());
            yield* Effect.acquireRelease(
              Effect.sync(() => runtime.watch((snapshot) => Queue.offerUnsafe(queue, snapshot))),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            Queue.offerUnsafe(queue, initial);
            Queue.offerUnsafe(
              queue,
              yield* guard(XCODE_WS_METHODS.subscribe, () => runtime.status()),
            );
          }),
        { bufferSize: 1, strategy: "sliding" },
      ),
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof XcodeRpcs>>;
}
export const makeXcodeRpcLayer = (runtime: XcodeInstall, scopes: readonly AuthEnvironmentScope[]) =>
  XcodeRpcs.toLayer(makeXcodeRpcHandlers(runtime, scopes));
