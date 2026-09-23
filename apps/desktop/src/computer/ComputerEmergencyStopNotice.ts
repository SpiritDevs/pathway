import { PRIMARY_LOCAL_ENVIRONMENT_ID } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as DesktopBackendPool from "../backend/DesktopBackendPool.ts";
import * as DesktopLocalEnvironmentAuth from "../backend/DesktopLocalEnvironmentAuth.ts";
import { DesktopComputer } from "./DesktopComputer.ts";

export const DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH = "/api/desktop/computer/emergency-stop";

const REQUEST_TIMEOUT_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 3_000] as const;

/** Where and as whom the notice is posted. */
export interface ComputerEmergencyStopEndpoint {
  /** The desktop-owned backend's HTTP origin. Must be loopback. */
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}

export interface ComputerEmergencyStopNoticeOptions<E> {
  /**
   * Resolved on every attempt, so a backend that restarted mid-retry is
   * picked up. A failure counts as a missing endpoint or credential.
   */
  readonly endpoint: Effect.Effect<ComputerEmergencyStopEndpoint, E>;
  readonly onError?: (message: string) => Effect.Effect<void>;
}

const isLoopbackBackendUrl = (url: URL) =>
  (url.protocol === "http:" || url.protocol === "https:") &&
  // WHATWG URL keeps the brackets on an IPv6 hostname.
  (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost");

/**
 * Best-effort relay of a physical Escape interrupt into the backend's
 * computer manager. The desktop's local interrupt already engaged before
 * this runs, so a lost notice must never delay or weaken the stop: the
 * retries only cover a backend that is mid-restart when the key lands.
 * Callers fork it. The notice carries no payload; everything it means is
 * implied by the authenticated route.
 */
export const notifyBackendComputerEmergencyStop = Effect.fn(
  "desktop.computer.notifyBackendComputerEmergencyStop",
)(function* <E>(options: ComputerEmergencyStopNoticeOptions<E>) {
  const client = yield* HttpClient.HttpClient;
  const report = (message: string) =>
    options.onError ? Effect.exit(options.onError(message)).pipe(Effect.asVoid) : Effect.void;

  /** One POST. Succeeds with a message to report, or none once the backend accepted. */
  const attempt = Effect.gen(function* () {
    const endpoint = yield* options.endpoint.pipe(Effect.option);
    if (Option.isNone(endpoint) || !endpoint.value.httpBaseUrl || !endpoint.value.bearerToken)
      return Option.some("computer emergency-stop notice has no backend endpoint or credential");
    const url = URL.canParse(endpoint.value.httpBaseUrl)
      ? new URL(endpoint.value.httpBaseUrl)
      : undefined;
    if (!url || !isLoopbackBackendUrl(url))
      return Option.some(
        "computer emergency-stop notice failed: the notice requires a loopback backend endpoint",
      );
    url.pathname = DESKTOP_COMPUTER_EMERGENCY_STOP_ROUTE_PATH;
    url.search = "";
    url.hash = "";
    const request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.bearerToken(endpoint.value.bearerToken),
    );
    const status = yield* client.execute(request).pipe(
      Effect.flatMap((response) => response.text.pipe(Effect.ignore, Effect.as(response.status))),
      Effect.timeoutOption(REQUEST_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(status))
      return Option.some(`computer emergency-stop notice failed: ${String(status.failure)}`);
    if (Option.isNone(status.success))
      return Option.some("computer emergency-stop notice failed: the request timed out");
    if (status.success.value === 202) return Option.none();
    return Option.some(`computer emergency-stop notice returned HTTP ${status.success.value}`);
  });

  for (let index = 0; index <= RETRY_DELAYS_MS.length; index += 1) {
    const problem = yield* attempt;
    if (Option.isNone(problem)) return;
    yield* report(problem.value);
    const delay = RETRY_DELAYS_MS[index];
    if (delay !== undefined) yield* Effect.sleep(delay);
  }
});

/**
 * Points the Computer host's Escape notice at the primary local backend, as
 * the desktop's own bearer session. The backend route accepts no other
 * credential.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const computer = yield* DesktopComputer;
    const pool = yield* DesktopBackendPool.DesktopBackendPool;
    const localAuth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
    const client = yield* HttpClient.HttpClient;

    const endpoint = Effect.gen(function* () {
      const primary = (yield* pool.list).find(
        (instance) => instance.id === PRIMARY_LOCAL_ENVIRONMENT_ID,
      );
      const config = primary ? yield* primary.currentConfig : Option.none();
      if (Option.isNone(config)) return yield* Effect.fail("the primary backend is not configured");
      return {
        httpBaseUrl: config.value.httpBaseUrl.href,
        bearerToken: yield* localAuth.getBearerToken,
      } satisfies ComputerEmergencyStopEndpoint;
    });

    yield* computer.setEmergencyStopNotice(
      notifyBackendComputerEmergencyStop({
        endpoint,
        onError: (message) => Effect.logWarning(`[desktop-computer] ${message}`),
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)),
    );
  }),
);
