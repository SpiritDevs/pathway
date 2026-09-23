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
  COMPUTER_WS_METHODS,
  ComputerError,
  EnvironmentAuthorizationError,
  WsComputerRpcGroup,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

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
