/**
 * The Computer half of the WebSocket RPC surface, built per socket beside the
 * main WS handler layer. It is its own layer because one handler literal for
 * the whole WS group is past what the compiler can infer: adding Computer to
 * it degraded the layer's requirements to `any`.
 *
 * @module computer/wsComputerRpcLayer
 */
import {
  type AuthEnvironmentScope,
  type AuthSessionId,
  COMPUTER_WS_METHODS,
  ComputerError,
  EnvironmentAuthorizationError,
  WsComputerRpcGroup,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { type Rpc, type RpcGroup, RpcServer } from "effect/unstable/rpc";

import { withSessionWebSocket } from "../auth/sessionWebSocket.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
} from "../observability/RpcInstrumentation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";
import { requireComputerAccess } from "./computerAccessPolicy.ts";
import { ComputerEventInterests } from "./computerEventInterests.ts";
import { ComputerService } from "./Services/ComputerService.ts";
import { makeWsComputerHandlers, wrapWsComputerHandlers } from "./wsComputerHandlers.ts";

const TRACE_ATTRIBUTES = { "rpc.aggregate": "computer" } as const;

/**
 * Serves `group` on the current request's WebSocket. Run it inside the route
 * handler and run the returned effect to upgrade.
 *
 * `handlers` is built into the request scope, which the HTTP server closes only
 * after the socket closes, so per-socket state (such as this module's event
 * interests) lives exactly as long as the socket. `Effect.provide(handlers)`
 * would instead close that state as soon as the upgrade effect was built.
 */
export const serveRpcWebSocket = <Rpcs extends Rpc.Any, ROut, E, RIn>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Layer.Layer<ROut, E, RIn>,
  sessionId: AuthSessionId,
) =>
  Layer.build(handlers).pipe(
    Effect.flatMap((context) =>
      RpcServer.toHttpEffectWebsocket(group, { disableTracing: true }).pipe(
        Effect.provideContext(context),
      ),
    ),
    Effect.map((httpEffect) =>
      withSessionWebSocket(sessionId, (socket) =>
        Effect.gen(function* () {
          const request = (yield* HttpServerRequest.HttpServerRequest).modify({});
          Object.defineProperty(request, "upgrade", { value: Effect.succeed(socket) });
          yield* httpEffect.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, request),
          );
        }),
      ).pipe(Effect.as(HttpServerResponse.empty())),
    ),
  );

export const makeWsComputerRpcLayer = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  WsComputerRpcGroup.toLayer(
    Effect.gen(function* () {
      const computerService = yield* ComputerService;
      const serverSettings = yield* ServerSettingsService;
      const handlers = makeWsComputerHandlers(computerService, {
        approvalGate: yield* ComputerApprovalGate,
        // Read per call: an admin can change the policy while this socket is open.
        admitComputerUse: serverSettings.getSettings.pipe(
          Effect.mapError(
            () => new ComputerError({ message: "Failed to read the Computer access policy." }),
          ),
          Effect.flatMap((settings) =>
            requireComputerAccess(settings.computer.accessPolicy, currentSession.scopes),
          ),
        ),
      });

      // This layer is built per socket, so one key names the connection and the
      // layer's scope is its lifetime.
      const connectionKey = "connection";
      const interestCleanups = new Set<() => void>();
      let connectionOpen = true;
      const interests = new ComputerEventInterests((_key, cleanup) => {
        if (connectionOpen) interestCleanups.add(cleanup);
        return connectionOpen;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          connectionOpen = false;
          for (const cleanup of interestCleanups) cleanup();
          interestCleanups.clear();
        }),
      );

      const denied = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const permits = (method: string) =>
        currentSession.scopes.includes(requiredScopeForRpcMethod(method));

      return WsComputerRpcGroup.of({
        ...wrapWsComputerHandlers(
          {
            ...handlers,
            [COMPUTER_WS_METHODS.getThreadState]: (input) =>
              Effect.suspend(() => {
                interests.watch(connectionKey, input.threadId);
                return handlers[COMPUTER_WS_METHODS.getThreadState](input);
              }),
          },
          (method, effect) =>
            instrumentRpcEffect(
              method,
              permits(method) ? effect : Effect.fail(denied(requiredScopeForRpcMethod(method))),
              TRACE_ATTRIBUTES,
            ),
        ),
        [COMPUTER_WS_METHODS.subscribeEvents]: (_input) =>
          instrumentRpcStream(
            COMPUTER_WS_METHODS.subscribeEvents,
            !permits(COMPUTER_WS_METHODS.subscribeEvents)
              ? Stream.fail(denied(requiredScopeForRpcMethod(COMPUTER_WS_METHODS.subscribeEvents)))
              : computerService.supported
                ? interests.subscribe(connectionKey, computerService.manager.events)
                : Stream.never,
            TRACE_ATTRIBUTES,
          ),
      });
    }),
  );
