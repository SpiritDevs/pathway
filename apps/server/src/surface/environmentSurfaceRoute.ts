import {
  AuthOrchestrationReadScope,
  ENVIRONMENT_SURFACE_WS_PATH,
  EnvironmentSurfaceSizing,
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
import { RemoteBrowser, type RemoteBrowserService } from "../preview/RemoteBrowser.ts";
import { makeSurfaceSocket } from "./surfaceSocket.ts";

const Query = Schema.Struct({
  ...EnvironmentSurfaceTarget.fields,
  ...EnvironmentSurfaceViewport.fields,
  sizing: EnvironmentSurfaceSizing,
});
export const decodeSurfaceQuery = Schema.decodeUnknownOption(Query);

export const serveEnvironmentSurface = Effect.fn("serveEnvironmentSurface")(function* (
  socket: Socket.Socket,
  input: typeof Query.Type,
  browser: RemoteBrowserService,
) {
  const ready = yield* Deferred.make<Option.Option<Socket.WebSocket["Service"]>>();
  let alive = true;
  let onPong = () => {};
  const reader = yield* socket
    .runRaw((message) => {
      if (message === "ready")
        return Effect.serviceOption(Socket.WebSocket).pipe(
          Effect.flatMap((native) => Deferred.succeed(ready, native)),
        );
      if (message === "pong") {
        alive = true;
        onPong();
      }
    })
    .pipe(Effect.forkScoped);
  const native = yield* Deferred.await(ready).pipe(
    Effect.timeout("10 seconds"),
    Effect.raceFirst(Fiber.join(reader).pipe(Effect.andThen(Effect.never))),
  );
  const connection = yield* makeSurfaceSocket(socket, native);
  onPong = connection.pong;
  yield* browser.subscribeSurface({ ...input, viewport: input }, connection.sink);
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("15 seconds");
      if (!alive) {
        connection.close("Surface heartbeat expired");
        return;
      }
      alive = false;
      connection.ping();
    }
  }).pipe(Effect.forkScoped);
  yield* Fiber.join(reader).pipe(Effect.raceFirst(connection.failure));
});

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
      sizing: params.get("sizing") ?? "active",
    });
    if (Option.isNone(input))
      return HttpServerResponse.text("Invalid surface target, viewport or sizing", { status: 400 });
    const browser = yield* RemoteBrowser;
    yield* withSessionWebSocket(session.sessionId, (socket) =>
      serveEnvironmentSurface(socket, input.value, browser),
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
