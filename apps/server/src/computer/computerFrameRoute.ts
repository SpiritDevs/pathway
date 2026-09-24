/** Still-image computer frame WebSocket route. */
import {
  AuthOrchestrationReadScope,
  COMPUTER_FRAME_RESYNC_MESSAGE,
  COMPUTER_FRAME_WS_COMPUTER_ID_PARAM,
  COMPUTER_FRAME_WS_PATH,
} from "@spiritdevs/contracts";
import {
  decodeFrameResyncRequest,
  makeFrameSink,
  type FrameSink,
} from "@spiritdevs/shared/frameTransport";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { ComputerService } from "./Services/ComputerService.ts";

const MAX_CLIENT_MESSAGE_BYTES = 1_024;

export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  return decodeFrameResyncRequest(message, COMPUTER_FRAME_RESYNC_MESSAGE, MAX_CLIENT_MESSAGE_BYTES);
}

export function makeComputerFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): FrameSink {
  return makeFrameSink(options);
}

/**
 * Serves window-scoped still frames to one watching client. Subscribing
 * starts the manager's stream and the last subscriber leaving stops it, so
 * nothing is captured while nobody watches. Watching needs only
 * `orchestration:read`: the Computer access policy governs control, never
 * viewing. The desktop's live frame tap stays on local IPC and never
 * reaches this route.
 */
export const computerFrameRouteLayer = HttpRouter.add(
  "GET",
  COMPUTER_FRAME_WS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationReadScope)) {
      return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
    }

    const computerService = yield* Effect.serviceOption(ComputerService);
    if (Option.isNone(computerService) || !computerService.value.supported) {
      return HttpServerResponse.text("Computer streaming is unavailable", { status: 404 });
    }
    const manager = computerService.value.manager;
    const requestedComputerId = HttpServerRequest.toURL(request).pipe(
      Option.flatMapNullishOr((url) =>
        url.searchParams.get(COMPUTER_FRAME_WS_COMPUTER_ID_PARAM)?.trim(),
      ),
      Option.filter((computerId) => computerId.length > 0),
    );
    if (Option.isNone(requestedComputerId)) {
      return HttpServerResponse.text("Missing computerId", { status: 400 });
    }
    if (requestedComputerId.value !== manager.computerId) {
      return HttpServerResponse.text("Unknown computer", { status: 404 });
    }

    yield* Effect.scoped(
      Effect.gen(function* () {
        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        let open = true;
        // Closing this scope removes the sink, and the last one out detaches the stream.
        yield* manager.subscribeFrames(
          makeComputerFrameSink({
            send: (bytes) => Effect.runPromise(writer(bytes)),
            isOpen: () => open,
          }),
        );
        // Finalizers run in reverse: the sink reports closed before it is removed.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
          }),
        );
        yield* socket.runRaw((message) =>
          decodeResyncRequest(message) === null
            ? undefined
            : Effect.ignore(manager.requestKeyframe()),
        );
      }),
    ).pipe(Effect.catchCause((cause) => Effect.logDebug("computer frame socket closed", cause)));
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
