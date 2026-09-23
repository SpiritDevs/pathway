/** Desktop-only route that relays a physical Escape press into the computer manager. */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { DESKTOP_BOOTSTRAP_SUBJECT } from "../auth/PairingGrantStore.ts";
import * as ServerConfig from "../config.ts";
import { ComputerService } from "./Services/ComputerService.ts";

export const DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH = "/api/desktop/computer/emergency-stop";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const isLoopbackPeer = (remoteAddress: Option.Option<string>): boolean =>
  Option.isSome(remoteAddress) && LOOPBACK_PEERS.has(remoteAddress.value.trim().toLowerCase());

/**
 * The route exists only on a desktop-owned backend, and only for a peer on
 * this machine. Anything else answers 404 before credentials are read.
 */
export const isDesktopEmergencyStopAvailable = (input: {
  readonly config: Pick<ServerConfig.ServerConfig["Service"], "mode" | "desktopBootstrapToken">;
  readonly remoteAddress: Option.Option<string>;
}): boolean =>
  input.config.mode === "desktop" &&
  Boolean(input.config.desktopBootstrapToken?.trim()) &&
  isLoopbackPeer(input.remoteAddress);

const notFound = HttpServerResponse.jsonUnsafe({ error: "Not Found" }, { status: 404 });
const unauthorized = HttpServerResponse.jsonUnsafe(
  { error: "Unauthorized" },
  {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer realm="pathway-desktop-emergency-stop"' },
  },
);

/**
 * The desktop relays physical Escape presses here after its local host latch
 * has already engaged. The manager-side stop is what keeps queued work from
 * dispatching once the desktop side is dead or restarting; both sides fail
 * closed independently rather than trusting a single transport.
 *
 * Only the desktop's own bearer session is accepted: the one it exchanged
 * from its bootstrap credential. Cookies and every paired client's session
 * are refused, even with administrative scopes.
 */
export const desktopComputerEmergencyStopRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig.ServerConfig;
    if (!isDesktopEmergencyStopAvailable({ config, remoteAddress: request.remoteAddress })) {
      return notFound;
    }

    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
      Effect.map(Option.some),
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, () =>
        Effect.succeed(Option.none()),
      ),
    );
    if (
      Option.isNone(session) ||
      session.value.method !== "bearer-access-token" ||
      session.value.subject !== DESKTOP_BOOTSTRAP_SUBJECT
    ) {
      return unauthorized;
    }

    const computerService = yield* Effect.serviceOption(ComputerService);
    if (Option.isNone(computerService)) {
      return HttpServerResponse.jsonUnsafe({ accepted: false }, { status: 404 });
    }

    yield* computerService.value.manager
      .emergencyStopInput()
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("desktop computer emergency stop failed", Cause.pretty(cause)),
        ),
      );
    return HttpServerResponse.jsonUnsafe({ accepted: true }, { status: 202 });
  }).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      Effect.logError("desktop computer emergency stop could not authenticate", error).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe({ error: "Internal Server Error" }, { status: 500 }),
        ),
      ),
    ),
  ),
);
