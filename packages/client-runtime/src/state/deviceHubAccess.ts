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
import * as Effect from "effect/Effect";
import type { HttpClient } from "effect/unstable/http";

import type { PreparedConnection } from "../connection/model.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import type { RemoteEnvironmentRequestError } from "../rpc/http.ts";
import { buildEnvironmentAuthHeaders } from "./environmentHttpAuth.ts";
import { makeEnvironmentHttpApiClient, executeEnvironmentHttpRequest } from "../rpc/http.ts";
import type { DeviceHubAccess } from "../device/hubAccess.ts";

export { type DeviceHubAccess, withDeviceHubQuery } from "../device/hubAccess.ts";

const TICKET_TIMEOUT_MS = 8_000;

export const resolveDeviceHubAccess = Effect.fn("clientRuntime.state.resolveDeviceHubAccess")(
  function* (input: {
    readonly prepared: PreparedConnection;
    readonly hubBasePath: string;
  }): Effect.fn.Return<DeviceHubAccess, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
    const httpBase = environmentEndpointUrl(input.prepared.httpBaseUrl, input.hubBasePath);
    const wsBase = httpBase.replace(/^http/, "ws");
    if (input.prepared.httpAuthorization === null) {
      return { httpBase, wsBase, query: {}, credentials: true };
    }
    const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
    const ticketUrl = environmentEndpointUrl(
      input.prepared.httpBaseUrl,
      "/api/auth/websocket-ticket",
    );
    const headers = yield* buildEnvironmentAuthHeaders(
      input.prepared.httpAuthorization,
      "POST",
      ticketUrl,
      signer,
    );
    const client = yield* makeEnvironmentHttpApiClient(input.prepared.httpBaseUrl);
    const ticket = yield* executeEnvironmentHttpRequest(
      ticketUrl,
      TICKET_TIMEOUT_MS,
      client.auth.webSocketTicket({ headers }),
    );
    return {
      httpBase,
      wsBase,
      query: { wsTicket: ticket.ticket },
      credentials: false,
    };
  },
);
