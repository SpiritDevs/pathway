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
  WORKFLOW_RECORDING_METHODS,
  COMPUTER_WS_METHODS,
  COMPUTER_SURFACE_METHODS,
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
import { randomUuidV4 } from "../orchestration-v2/RandomUuid.ts";
import { ComputerApprovalGate } from "./ComputerApprovalGate.ts";
import { requireComputerAccess } from "./computerAccessPolicy.ts";
import { ComputerEventInterests } from "./computerEventInterests.ts";
import { ComputerService } from "./Services/ComputerService.ts";
import { makeWsComputerHandlers, wrapWsComputerHandlers } from "./wsComputerHandlers.ts";
import { DesktopDispatchAuthority } from "./DesktopOperationQueue.ts";
import { makeComputerSurfaceHandlers } from "./wsComputerSurfaceHandlers.ts";

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
      const surfaceClientId = yield* randomUuidV4;
      yield* Effect.addFinalizer(() =>
        Effect.ignore(computerService.manager.surfaceControl.disconnect(surfaceClientId)),
      );
      const surfaceHandlers = makeComputerSurfaceHandlers(
        computerService.manager,
        surfaceClientId,
        serverSettings.getSettings.pipe(
          Effect.mapError(
            () => new ComputerError({ message: "Failed to read the Computer access policy." }),
          ),
          Effect.flatMap((settings) =>
            requireComputerAccess(settings.computer.accessPolicy, currentSession.scopes),
          ),
        ),
      );
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

      const surfaceCall = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
        permits(method) ? effect : Effect.fail(denied(requiredScopeForRpcMethod(method)));
      return WsComputerRpcGroup.of({
        [WORKFLOW_RECORDING_METHODS.status]: (input) =>
          surfaceCall(
            WORKFLOW_RECORDING_METHODS.status,
            computerService.manager
              .recordWorkflow("status", input.threadId)
              .pipe(Effect.mapError((error) => new ComputerError({ message: error.message }))),
          ),
        [WORKFLOW_RECORDING_METHODS.start]: (input) =>
          surfaceCall(
            WORKFLOW_RECORDING_METHODS.start,
            serverSettings.getSettings.pipe(
              Effect.mapError(
                () => new ComputerError({ message: "Failed to read the Computer access policy." }),
              ),
              Effect.flatMap((settings) =>
                requireComputerAccess(settings.computer.accessPolicy, currentSession.scopes),
              ),
              Effect.andThen(
                computerService.manager
                  .recordWorkflow("start", input.threadId)
                  .pipe(Effect.mapError((error) => new ComputerError({ message: error.message }))),
              ),
            ),
          ),
        [WORKFLOW_RECORDING_METHODS.stop]: (input) =>
          surfaceCall(
            WORKFLOW_RECORDING_METHODS.stop,
            computerService.manager
              .recordWorkflow("stop", input.threadId)
              .pipe(Effect.mapError((error) => new ComputerError({ message: error.message }))),
          ),
        [WORKFLOW_RECORDING_METHODS.cancel]: (input) =>
          surfaceCall(
            WORKFLOW_RECORDING_METHODS.cancel,
            computerService.manager
              .recordWorkflow("cancel", input.threadId)
              .pipe(Effect.mapError((error) => new ComputerError({ message: error.message }))),
          ),

        [COMPUTER_SURFACE_METHODS.getState]: () =>
          surfaceCall(
            COMPUTER_SURFACE_METHODS.getState,
            surfaceHandlers[COMPUTER_SURFACE_METHODS.getState](),
          ),
        [COMPUTER_SURFACE_METHODS.takeControl]: () =>
          surfaceCall(
            COMPUTER_SURFACE_METHODS.takeControl,
            surfaceHandlers[COMPUTER_SURFACE_METHODS.takeControl](),
          ),
        [COMPUTER_SURFACE_METHODS.releaseControl]: () =>
          surfaceCall(
            COMPUTER_SURFACE_METHODS.releaseControl,
            surfaceHandlers[COMPUTER_SURFACE_METHODS.releaseControl](),
          ),
        [COMPUTER_SURFACE_METHODS.input]: (input) =>
          surfaceCall(
            COMPUTER_SURFACE_METHODS.input,
            surfaceHandlers[COMPUTER_SURFACE_METHODS.input](input),
          ),
        [COMPUTER_SURFACE_METHODS.handBack]: (input) =>
          surfaceCall(
            COMPUTER_SURFACE_METHODS.handBack,
            surfaceHandlers[COMPUTER_SURFACE_METHODS.handBack](input),
          ),
        [COMPUTER_SURFACE_METHODS.subscribe]: () =>
          permits(COMPUTER_SURFACE_METHODS.subscribe)
            ? surfaceHandlers[COMPUTER_SURFACE_METHODS.subscribe]()
            : Stream.fail(denied(requiredScopeForRpcMethod(COMPUTER_SURFACE_METHODS.subscribe))),
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
              permits(method)
                ? effect.pipe(
                    Effect.provideService(
                      DesktopDispatchAuthority,
                      computerService.manager.surfaceControl.assertUnclaimed(),
                    ),
                  )
                : Effect.fail(denied(requiredScopeForRpcMethod(method))),
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
