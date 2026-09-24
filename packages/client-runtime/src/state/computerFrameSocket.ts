import type { ComputerId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { HttpClient } from "effect/unstable/http";
import type { Atom } from "effect/unstable/reactivity";

import {
  resolveRemoteDpopWebSocketConnectionUrl,
  resolveRemoteWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import type { PreparedConnection } from "../connection/model.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { createEnvironmentCommand } from "./runtime.ts";

// Mirrors `@spiritdevs/shared/computerFrame`, whose codec pulls in Node-only
// transport code that this browser/React Native package must not type against.
const COMPUTER_FRAME_WS_PATH = "/ws/computer-frames";
const COMPUTER_FRAME_WS_COMPUTER_ID_PARAM = "computerId";

/**
 * The frame route beside the connection's RPC socket. The prepared socket URL
 * ends in the RPC path (`/ws`, possibly under a proxy prefix) and may carry an
 * already-consumed ticket, so only its origin and prefix are kept.
 */
export function computerFrameSocketBaseUrl(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.search = "";
  url.hash = "";
  const prefix = url.pathname.replace(/\/+$/, "").replace(/\/ws$/, "");
  url.pathname = `${prefix}${COMPUTER_FRAME_WS_PATH}`;
  return url.toString();
}

function withComputerId(socketUrl: string, computerId: ComputerId): string {
  const url = new URL(socketUrl);
  url.searchParams.set(COMPUTER_FRAME_WS_COMPUTER_ID_PARAM, computerId);
  return url.toString();
}

/**
 * Resolve the binary frame socket URL for one computer on a prepared
 * connection, authenticated the same way as the RPC socket:
 * - primary/local connections are same-origin and ride the session cookie,
 * - bearer connections mint a `wsTicket`,
 * - relay connections mint the ticket with a DPoP proof.
 *
 * Tickets are signed and expire after a few minutes; they are not consumed,
 * so one URL serves reconnects until the server refuses it.
 */
export const resolveComputerFrameSocketUrl = Effect.fn(
  "clientRuntime.state.resolveComputerFrameSocketUrl",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly computerId: ComputerId;
  readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
  readonly timeoutMs?: number;
}) {
  const { prepared } = input;
  const wsBaseUrl = computerFrameSocketBaseUrl(prepared.socketUrl);
  const timeout = input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs };
  const authorization = prepared.httpAuthorization;
  if (authorization === null) {
    return withComputerId(wsBaseUrl, input.computerId);
  }
  if (authorization._tag === "Bearer") {
    const url = yield* resolveRemoteWebSocketConnectionUrl({
      wsBaseUrl,
      httpBaseUrl: prepared.httpBaseUrl,
      bearerToken: authorization.token,
      ...timeout,
    });
    return withComputerId(url, input.computerId);
  }
  if (Option.isNone(input.signer)) {
    return yield* new RemoteEnvironmentAuthFetchError({
      message: "No DPoP signer is available to authorize the computer frame socket.",
      cause: authorization._tag,
    });
  }
  const dpopProof = yield* input.signer.value
    .createProof({
      method: "POST",
      url: environmentEndpointUrl(prepared.httpBaseUrl, "/api/auth/websocket-ticket"),
      accessToken: authorization.accessToken,
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new RemoteEnvironmentAuthFetchError({
            message: "Could not create the computer frame socket authorization proof.",
            cause,
          }),
      ),
    );
  const url = yield* resolveRemoteDpopWebSocketConnectionUrl({
    wsBaseUrl,
    httpBaseUrl: prepared.httpBaseUrl,
    accessToken: authorization.accessToken,
    dpopProof,
    ...timeout,
  });
  return withComputerId(url, input.computerId);
});

/**
 * `resolveUrl` mints a fresh frame socket URL for the environment's current
 * prepared connection. The binary socket itself stays in the client.
 */
export function createComputerFrameSocketAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | HttpClient.HttpClient | R, E>,
) {
  return {
    resolveUrl: createEnvironmentCommand(runtime, {
      label: "environment-data:computer:frame-socket-url",
      execute: (input: { readonly computerId: ComputerId }, _registry, environmentId) =>
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          const prepared = yield* SubscriptionRef.get(supervisor.prepared);
          if (Option.isNone(prepared)) {
            return yield* new EnvironmentRpcUnavailableError({
              environmentId,
              message: "The environment is not connected.",
            });
          }
          const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
          return yield* resolveComputerFrameSocketUrl({
            prepared: prepared.value,
            computerId: input.computerId,
            signer,
          });
        }),
    }),
  };
}
