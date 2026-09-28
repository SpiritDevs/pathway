/**
 * Credentials for the Device panel's media requests.
 *
 * The panel reaches simulator streams through `/api/device-hub/*` on the
 * environment origin. `<img>`, `EventSource`, and `WebSocket` cannot set
 * bearer or DPoP headers, so bearer and DPoP connections mint a
 * short-lived WebSocket ticket and pass it as `wsTicket`, the same way the
 * app's own `/ws` upgrade authenticates. Cookie sessions send the cookie.
 *
 * A ticket lives five minutes server-side and is bound to the session, not
 * to one request, so one ticket covers everything a panel opens at once.
 * Callers fetch a fresh one each time they (re)connect a stream.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";
import { makeEnvironmentHttpApiClient, executeEnvironmentHttpRequest } from "../rpc/http.ts";
import type { DeviceHubAccess } from "../device/hubAccess.ts";

export {
  type DeviceHubAccess,
  deviceHubTicketExpired,
  withDeviceHubQuery,
} from "../device/hubAccess.ts";

const TICKET_TIMEOUT_MS = 8_000;

/** Session credentials for an environment's hub, independent of the hub path. */
export interface DeviceHubCredentials {
  readonly httpBaseUrl: string;
  readonly query: DeviceHubAccess["query"];
  readonly credentials: boolean;
  readonly expiresAt: number | null;
}

export const resolveDeviceHubCredentials = Effect.fn(
  "clientRuntime.state.resolveDeviceHubCredentials",
)(function* (input: {
  readonly prepared: PreparedConnection;
}): Effect.fn.Return<DeviceHubCredentials, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const { httpBaseUrl, httpAuthorization } = input.prepared;
  if (httpAuthorization === null)
    return { httpBaseUrl, query: {}, credentials: true, expiresAt: null };
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const ticketUrl = environmentEndpointUrl(httpBaseUrl, "/api/auth/websocket-ticket");
  const headers = yield* buildEnvironmentAuthHeaders(httpAuthorization, "POST", ticketUrl, signer);
  const client = yield* makeEnvironmentHttpApiClient(httpBaseUrl);
  const ticket = yield* executeEnvironmentHttpRequest(
    ticketUrl,
    TICKET_TIMEOUT_MS,
    client.auth.webSocketTicket({ headers }),
  );
  return {
    httpBaseUrl,
    query: { wsTicket: ticket.ticket },
    credentials: false,
    expiresAt: DateTime.toEpochMillis(ticket.expiresAt),
  };
});

/** Resolves the server's `DeviceServiceState.hubBasePath` against the environment origin. */
export const deviceHubAccessAt = (
  credentials: DeviceHubCredentials,
  hubBasePath: string,
): DeviceHubAccess => {
  const httpBase = environmentEndpointUrl(credentials.httpBaseUrl, hubBasePath);
  return {
    httpBase,
    wsBase: httpBase.replace(/^http/, "ws"),
    query: credentials.query,
    credentials: credentials.credentials,
    expiresAt: credentials.expiresAt,
  };
};

export const resolveDeviceHubAccess = (input: {
  readonly prepared: PreparedConnection;
  readonly hubBasePath: string;
}) =>
  resolveDeviceHubCredentials(input).pipe(
    Effect.map((credentials) => deviceHubAccessAt(credentials, input.hubBasePath)),
  );
