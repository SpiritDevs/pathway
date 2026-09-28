import {
  COMPUTER_FRAME_WS_PATH,
  ENVIRONMENT_SURFACE_WS_PATH,
  type EnvironmentSurfaceTarget,
  type EnvironmentSurfaceViewport,
  type AuthWebSocketTicketResult,
} from "@spiritdevs/contracts";
import { Effect, Option } from "effect";
import {
  issueRemoteDpopWebSocketTicket,
  issueRemoteWebSocketTicket,
} from "../authorization/remote.ts";
import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import type { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";
import { computerFrameSocketBaseUrl } from "../state/computerFrameSocket.ts";
function frameSocketUrl(base: string, ticket: AuthWebSocketTicketResult | null) {
  const url = new URL(base);
  if (ticket) url.searchParams.set("wsTicket", ticket.ticket);
  return { url: url.toString(), expiresAt: ticket?.expiresAt.epochMilliseconds ?? null };
}
export const resolveSurfaceSocketUrl = Effect.fn("clientRuntime.surface.resolveSurfaceSocketUrl")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly target: EnvironmentSurfaceTarget;
    readonly viewport: EnvironmentSurfaceViewport;
    readonly signer: Option.Option<ManagedRelayDpopSigner["Service"]>;
    readonly timeoutMs?: number;
  }) {
    const { prepared } = input;
    const base = new URL(computerFrameSocketBaseUrl(prepared.socketUrl));
    base.pathname = base.pathname.replace(COMPUTER_FRAME_WS_PATH, ENVIRONMENT_SURFACE_WS_PATH);
    for (const [key, value] of Object.entries({ ...input.target, ...input.viewport }))
      base.searchParams.set(key, String(value));
    const wsBaseUrl = base.toString();
    const timeout = input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs };
    const authorization = prepared.httpAuthorization;
    if (authorization === null) {
      return frameSocketUrl(wsBaseUrl, null);
    }
    if (authorization._tag === "Bearer") {
      const ticket = yield* issueRemoteWebSocketTicket({
        httpBaseUrl: prepared.httpBaseUrl,
        bearerToken: authorization.token,
        ...timeout,
      });
      return frameSocketUrl(wsBaseUrl, ticket);
    }
    if (Option.isNone(input.signer)) {
      return yield* new RemoteEnvironmentAuthFetchError({
        message: "No DPoP signer is available to authorize the surface socket.",
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
              message: "Could not create the surface socket authorization proof.",
              cause,
            }),
        ),
      );
    const ticket = yield* issueRemoteDpopWebSocketTicket({
      httpBaseUrl: prepared.httpBaseUrl,
      accessToken: authorization.accessToken,
      dpopProof,
      ...timeout,
    });
    return frameSocketUrl(wsBaseUrl, ticket);
  },
);
