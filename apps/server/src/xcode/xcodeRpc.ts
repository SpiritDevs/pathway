import type { XcodeStatus, XcodeUpdate } from "@spiritdevs/contracts/xcode";
import type { AppleError } from "@spiritdevs/contracts/apple";
import type { AppleSessionTarget } from "@spiritdevs/backend/appleSession";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { HttpServerRequest } from "effect/unstable/http";
import { XCODE_WS_METHODS, XcodeError, XcodeRpcs } from "@spiritdevs/contracts/xcode";
import type { EnvironmentAuthorizationError, AuthEnvironmentScope } from "@spiritdevs/contracts";
import type { AppleRuntime } from "../apple/AppleRuntime.ts";
import { authenticatedWebSocketSession } from "../auth/EnvironmentAuth.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { resolveAppleCaller, type AppleCaller } from "../auth/appleCaller.ts";
import { makeAppleCallerGuard } from "../auth/appleRpcAuthorization.ts";
import { type XcodeInstall, sameXcodeAccount, xcodeError } from "./XcodeInstall.ts";
const isXcodeError = Schema.is(XcodeError);
export function makeXcodeRpcHandlers(
  runtime: XcodeInstall,
  apple: Pick<AppleRuntime, "authorizeCaller">,
  scopes: readonly AuthEnvironmentScope[],
  resolveCaller: Effect.Effect<AppleCaller | null> = Effect.succeed(null),
) {
  const authorize = makeAppleCallerGuard(apple, scopes, resolveCaller);
  const guard = <A>(method: string, target: AppleSessionTarget, run: () => Promise<A>) =>
    authorize(
      method,
      target,
      Effect.tryPromise({
        try: run,
        catch: (error) =>
          isXcodeError(error) ? error : xcodeError("process-failed", "The Xcode operation failed."),
      }),
    );
  const visible = (target: AppleSessionTarget, status: XcodeStatus): XcodeStatus => ({
    ...status,
    job: status.job && sameXcodeAccount(status.job.account, target) ? status.job : null,
  });
  return {
    [XCODE_WS_METHODS.status]: (input) =>
      guard(XCODE_WS_METHODS.status, input, async () => visible(input, await runtime.status())),
    [XCODE_WS_METHODS.install]: (input) =>
      guard(XCODE_WS_METHODS.install, input, () =>
        runtime.install(input, input.versionId, input.platforms),
      ),
    [XCODE_WS_METHODS.cancel]: (input) =>
      guard(XCODE_WS_METHODS.cancel, input, () => runtime.cancel(input, input.jobId)),
    [XCODE_WS_METHODS.retry]: (input) =>
      guard(XCODE_WS_METHODS.retry, input, () => runtime.retry(input, input.jobId)),
    [XCODE_WS_METHODS.approve]: (input) =>
      guard(XCODE_WS_METHODS.approve, input, () => runtime.approve(input, input.jobId)),
    [XCODE_WS_METHODS.select]: (input) =>
      guard(XCODE_WS_METHODS.select, input, () => runtime.select(input, input.path)),
    [XCODE_WS_METHODS.installRuntimes]: (input) =>
      guard(XCODE_WS_METHODS.installRuntimes, input, () =>
        runtime.installRuntimes(input, input.path, input.platforms),
      ),
    [XCODE_WS_METHODS.subscribe]: (input) =>
      Stream.callback<XcodeUpdate, XcodeError | AppleError | EnvironmentAuthorizationError>(
        (queue) =>
          Effect.gen(function* () {
            const initial = yield* guard(XCODE_WS_METHODS.subscribe, input, () => runtime.status());
            yield* Effect.acquireRelease(
              Effect.sync(() =>
                runtime.watch((snapshot) =>
                  Queue.offerUnsafe(
                    queue,
                    snapshot.job?.state === "completed"
                      ? { kind: "status", status: snapshot }
                      : { kind: "job", job: snapshot.job },
                  ),
                ),
              ),
              (unsubscribe) => Effect.sync(unsubscribe),
            );
            Queue.offerUnsafe(queue, { kind: "status", status: initial });
            Queue.offerUnsafe(queue, {
              kind: "status",
              status: yield* guard(XCODE_WS_METHODS.subscribe, input, () => runtime.status()),
            });
          }).pipe(Effect.catch((error) => Queue.fail(queue, error))),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(
        Stream.mapEffect((snapshot) =>
          guard(XCODE_WS_METHODS.subscribe, input, async () =>
            snapshot.kind === "status"
              ? { kind: "status" as const, status: visible(input, snapshot.status) }
              : {
                  kind: "job" as const,
                  job:
                    snapshot.job && sameXcodeAccount(snapshot.job.account, input)
                      ? snapshot.job
                      : null,
                },
          ),
        ),
      ),
  } satisfies RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof XcodeRpcs>>;
}
export const makeXcodeRpcLayer = (
  runtime: XcodeInstall,
  apple: Pick<AppleRuntime, "authorizeCaller">,
  scopes: readonly AuthEnvironmentScope[],
) =>
  XcodeRpcs.toLayer(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const secrets = yield* ServerSecretStore;
      const session = authenticatedWebSocketSession(request);
      const caller = session
        ? resolveAppleCaller(session).pipe(Effect.provideService(ServerSecretStore, secrets))
        : Effect.succeed(null);
      return makeXcodeRpcHandlers(runtime, apple, scopes, caller);
    }),
  );
