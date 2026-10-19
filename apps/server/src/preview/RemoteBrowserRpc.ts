import {
  EnvironmentAuthorizationError,
  WS_METHODS,
  type AuthEnvironmentScope,
  type PreviewRemoteCommand,
  type PreviewRemoteFrameInput,
  type PreviewRemoteFrame,
  type PreviewRemoteResult,
  type PreviewRemoteError,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import type { RemoteBrowserService } from "./RemoteBrowser.ts";

/** Applies the same environment scopes as other RPCs without tracing credential payloads. */
export function remoteBrowserRpcHandlers(
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  browser: RemoteBrowserService,
) {
  const denied = (method: string) => {
    const requiredScope = requiredScopeForRpcMethod(method);
    return new EnvironmentAuthorizationError({
      requiredScope,
      message: `The authenticated token is missing required scope: ${requiredScope}.`,
    });
  };
  return {
    [WS_METHODS.previewRemoteCommand]: (input: PreviewRemoteCommand) => {
      const command: Effect.Effect<
        PreviewRemoteResult,
        PreviewRemoteError | EnvironmentAuthorizationError
      > = scopes.includes(requiredScopeForRpcMethod(WS_METHODS.previewRemoteCommand))
        ? browser.command(input)
        : Effect.fail(denied(WS_METHODS.previewRemoteCommand));
      return command.pipe(Effect.provideService(References.TracerEnabled, false));
    },
    [WS_METHODS.subscribePreviewRemoteFrames]: (
      input: typeof PreviewRemoteFrameInput.Type,
    ): Stream.Stream<PreviewRemoteFrame, PreviewRemoteError | EnvironmentAuthorizationError> =>
      scopes.includes(requiredScopeForRpcMethod(WS_METHODS.subscribePreviewRemoteFrames))
        ? browser.frames(input)
        : Stream.fail(denied(WS_METHODS.subscribePreviewRemoteFrames)),
  };
}
