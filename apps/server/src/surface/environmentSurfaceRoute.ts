import {
  AuthOrchestrationReadScope,
  ENVIRONMENT_SURFACE_WS_PATH,
  EnvironmentSurfaceTarget,
  EnvironmentSurfaceViewport,
} from "@spiritdevs/contracts";
import { Deferred, Effect, Fiber, Option, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";
import { withSessionWebSocket } from "../auth/sessionWebSocket.ts";
import { RemoteBrowser } from "../preview/RemoteBrowser.ts";

const Query = Schema.Struct({
  ...EnvironmentSurfaceTarget.fields,
  ...EnvironmentSurfaceViewport.fields,
});
export const decodeSurfaceQuery = Schema.decodeUnknownOption(Query);

export const environmentSurfaceRouteLayer = HttpRouter.add(
  "GET",
  ENVIRONMENT_SURFACE_WS_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );
    if (!session.scopes.includes(AuthOrchestrationReadScope))
      return yield* failEnvironmentScopeRequired(AuthOrchestrationReadScope);
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) return HttpServerResponse.empty({ status: 400 });
    const params = url.value.searchParams;
    const input = decodeSurfaceQuery({
      kind: params.get("kind"),
      threadId: params.get("threadId"),
      tabId: params.get("tabId"),
      width: Number(params.get("width")),
      height: Number(params.get("height")),
      deviceScale: Number(params.get("deviceScale")),
    });
    if (Option.isNone(input))
      return HttpServerResponse.text("Invalid surface target or viewport", { status: 400 });
    const browser = yield* RemoteBrowser;
    yield* withSessionWebSocket(session.sessionId, (socket) =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<Socket.WebSocket["Service"]>();
        let alive = true;
        const reader = yield* socket
          .runRaw((message) => {
            if (message === "ready")
              return Effect.gen(function* () {
                const ws = yield* Effect.serviceOption(Socket.WebSocket);
                if (Option.isSome(ws)) yield* Deferred.succeed(ready, ws.value);
              });
            if (message === "pong") alive = true;
          })
          .pipe(Effect.forkScoped);
        const ws = yield* Deferred.await(ready).pipe(Effect.timeout("10 seconds"));
        yield* browser.subscribeSurface(
          { ...input.value, viewport: input.value },
          {
            send: (bytes) => ws.send(bytes as Uint8Array<ArrayBuffer>),
            bufferedAmount: () => ws.bufferedAmount,
            close: () => ws.close(1001, "Surface closed"),
          },
        );
        yield* Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep("15 seconds");
            if (!alive) {
              ws.close(1001, "Surface heartbeat expired");
              return;
            }
            alive = false;
            if (ws.bufferedAmount <= 256 * 1024) ws.send("ping");
          }
        }).pipe(Effect.forkScoped);
        yield* Fiber.join(reader);
      }),
    ).pipe(
      Effect.catchTags({
        SocketError: () => Effect.void,
        TimeoutError: () => Effect.void,
        PreviewRemoteError: () => Effect.void,
      }),
    );
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  ),
);
