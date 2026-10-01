import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import { HttpServerRequest } from "effect/unstable/http";
import { AppleError } from "@spiritdevs/contracts/apple";
import type { AuthEnvironmentScope } from "@spiritdevs/contracts";
import {
  ReleaseRpcs,
  RELEASE_WS_METHODS,
  type ReleaseTarget,
  type ReleaseUpdate,
} from "@spiritdevs/contracts/releases";
import { authenticatedWebSocketSession } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { resolveAppleCaller, type AppleCaller } from "../auth/appleCaller.ts";
import { makeAppleCallerGuard } from "../auth/appleRpcAuthorization.ts";
import type { AppleRuntime } from "../apple/AppleRuntime.ts";
import { safeReleaseError, type ReleaseRuntime } from "./ReleaseRuntime.ts";

export function makeReleaseRpcHandlers(
  runtime: ReleaseRuntime,
  apple: Pick<AppleRuntime, "authorizeCaller">,
  scopes: readonly AuthEnvironmentScope[],
  resolveCaller: Effect.Effect<AppleCaller | null> = Effect.succeed(null),
) {
  const authorize = makeAppleCallerGuard(apple, scopes, resolveCaller);
  const guard = <A>(
    method: string,
    target: ReleaseTarget,
    run: (caller: AppleCaller, signal: AbortSignal) => Promise<A>,
  ) =>
    authorize(
      method,
      target,
      Effect.gen(function* () {
        const caller = yield* resolveCaller;
        if (!caller)
          return yield* new AppleError({
            code: "forbidden",
            message: "A signed-in Cloud user is required.",
            retryAfterSeconds: null,
          });
        return yield* Effect.tryPromise({
          try: (signal) => run(caller, signal),
          catch: safeReleaseError,
        });
      }),
    );
  return {
    [RELEASE_WS_METHODS.archive]: (input) =>
      guard(RELEASE_WS_METHODS.archive, input, (caller) => runtime.archive(input, caller)),
    [RELEASE_WS_METHODS.prepare]: (input) =>
      guard(RELEASE_WS_METHODS.prepare, input, (caller) =>
        runtime.prepare(input, caller, input.action),
      ),
    [RELEASE_WS_METHODS.execute]: (input) =>
      guard(RELEASE_WS_METHODS.execute, input, (caller) =>
        runtime.execute(input, caller, input.intentId),
      ),
    [RELEASE_WS_METHODS.cancel]: (input) =>
      guard(RELEASE_WS_METHODS.cancel, input, () => runtime.cancel(input, input.jobId)),
    [RELEASE_WS_METHODS.localStatus]: (input) =>
      guard(RELEASE_WS_METHODS.localStatus, input, () => runtime.localStatus(input)),
    [RELEASE_WS_METHODS.refresh]: (input) =>
      guard(RELEASE_WS_METHODS.refresh, input, async () => runtime.refresh(input)),
    [RELEASE_WS_METHODS.subscribe]: (input) =>
      Stream.callback<"organizer" | "local">(
        (queue) =>
          Effect.gen(function* () {
            yield* Effect.acquireRelease(
              Effect.sync(() => runtime.watch(input, (kind) => Queue.offerUnsafe(queue, kind))),
              (unwatch) => Effect.sync(unwatch),
            );
            Queue.offerUnsafe(queue, "local");
            Queue.offerUnsafe(queue, "organizer");
          }),
        { bufferSize: 2, strategy: "sliding" },
      ).pipe(
        Stream.mapEffect((kind) =>
          guard(
            RELEASE_WS_METHODS.subscribe,
            input,
            async (caller, signal): Promise<ReleaseUpdate> =>
              kind === "local"
                ? { kind, local: await runtime.localStatus(input) }
                : { kind, organizer: await runtime.organizer(input, caller, signal) },
          ),
        ),
      ),
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof ReleaseRpcs>>;
}
export const makeReleaseRpcLayer = (
  runtime: ReleaseRuntime,
  apple: Pick<AppleRuntime, "authorizeCaller">,
  scopes: readonly AuthEnvironmentScope[],
) =>
  ReleaseRpcs.toLayer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const secrets = yield* ServerSecretStore;
      const session = authenticatedWebSocketSession(request);
      const caller = session
        ? resolveAppleCaller(session).pipe(Effect.provideService(ServerSecretStore, secrets))
        : Effect.succeed(null);
      return makeReleaseRpcHandlers(runtime, apple, scopes, caller);
    }),
  );
