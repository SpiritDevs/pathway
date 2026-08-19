import type { ServerConfig } from "@spiritdevs/contracts";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientReason,
  NetworkStatus,
  SupervisorConnectionState,
} from "./model.ts";

export type EnvironmentConnectionPhase =
  | "available"
  | "offline"
  | "connecting"
  | "reconnecting"
  | "connected"
  | "error";

/**
 * How loudly the UI should report the current connection state.
 *
 * - `quiet` — nothing worth saying (connected, idle, first attempt in flight).
 * - `notice` — the environment is simply not reachable right now. A machine
 *   that was shut down is the normal case, so this reads as "disconnected",
 *   not as a fault, and never escalates on its own.
 * - `error` — something is actually wrong on our side (auth, configuration,
 *   permissions) or a transient failure has outlasted the grace attempts.
 */
export type ConnectionSeverity = "quiet" | "notice" | "error";

/**
 * The phase/error shape the status-text helpers read. Callers that only hold a
 * phase and a message (mobile rows, project pickers) can pass their own summary
 * without materialising a full presentation.
 */
export interface ConnectionStatusSummary {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId?: string | null;
  readonly severity?: ConnectionSeverity;
}

export interface EnvironmentConnectionPresentation extends ConnectionStatusSummary {
  readonly phase: EnvironmentConnectionPhase;
  readonly error: string | null;
  readonly traceId: string | null;
  readonly severity: ConnectionSeverity;
}

/**
 * Failures that mean "the other end is not there", as opposed to "this end is
 * misconfigured". Losing the peer is an ordinary event — the user closed their
 * laptop — so it stays a notice however long it lasts.
 */
const UNREACHABLE_REASONS: ReadonlySet<ConnectionTransientReason> = new Set([
  "network",
  "endpoint-unavailable",
  "relay-unavailable",
  "remote-unavailable",
]);

/**
 * How many attempts a non-unreachable transient failure gets before the UI
 * calls it an error. A flaky first attempt is not news; a fourth one is.
 */
const TRANSIENT_GRACE_ATTEMPTS = 3;

export function connectionFailureIsUnreachable(failure: ConnectionAttemptError | null): boolean {
  return (
    failure !== null &&
    failure._tag === "ConnectionTransientError" &&
    UNREACHABLE_REASONS.has(failure.reason)
  );
}

function retryingSeverity(
  failure: ConnectionAttemptError | null,
  attempt: number,
): ConnectionSeverity {
  if (failure === null) return "quiet";
  if (failure._tag === "ConnectionBlockedError") return "error";
  if (connectionFailureIsUnreachable(failure)) return "notice";
  return attempt > TRANSIENT_GRACE_ATTEMPTS ? "error" : "notice";
}

export interface EnvironmentPresentation {
  readonly entry: ConnectionCatalogEntry;
  readonly connection: EnvironmentConnectionPresentation;
  readonly serverConfig: ServerConfig | null;
}

export function presentConnectionState(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  switch (state.phase) {
    case "available":
      return { phase: "available", error: null, traceId: null, severity: "quiet" };
    case "offline":
      return { phase: "offline", error: null, traceId: null, severity: "quiet" };
    case "connecting":
      return {
        phase: state.attempt <= 1 && state.lastFailure === null ? "connecting" : "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        severity: retryingSeverity(state.lastFailure, state.attempt),
      };
    case "connected":
      return { phase: "connected", error: null, traceId: null, severity: "quiet" };
    case "backoff":
      return {
        phase: "reconnecting",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        severity: retryingSeverity(state.lastFailure, state.attempt),
      };
    case "blocked":
      return {
        phase: "error",
        error: state.lastFailure?.message ?? null,
        traceId: state.lastFailure?.traceId ?? null,
        severity: "error",
      };
  }
}

export function connectionStatusText(connection: ConnectionStatusSummary): string {
  switch (connection.phase) {
    case "available":
      return "Available";
    case "offline":
      return "Offline";
    case "connecting":
      return "Connecting...";
    case "reconnecting":
      if (connection.error === null) return "Reconnecting...";
      // A notice keeps the reason — a hover or a bug report still needs it —
      // but drops "Failed", which overstates a machine that is merely off.
      return connection.severity === "notice"
        ? `Disconnected. Reason: ${connection.error}`
        : `Failed to connect. Reconnecting... Reason: ${connection.error}`;
    case "connected":
      return "Connected";
    case "error":
      return connection.error
        ? `Connection failed. Reason: ${connection.error}`
        : "Connection failed";
  }
}

export function connectionStatusTitle(connection: ConnectionStatusSummary): string {
  if (connection.severity === "notice" && connection.phase === "reconnecting") {
    return "Disconnected";
  }
  if (connection.phase === "reconnecting" && connection.error) {
    return "Failed to connect. Reconnecting...";
  }
  return connectionStatusText({ ...connection, error: null });
}

/**
 * The line a list row shows under an environment's name.
 *
 * A `notice` deliberately drops the raw failure reason: "Relay environment
 * endpoint is unavailable: endpoint_request_fai..." is what a shut-down laptop
 * looks like from here, and reading it in red teaches the user to distrust a
 * state that is entirely normal. The reason stays available on the status dot's
 * tooltip and behind Copy trace ID for when someone is actually debugging.
 */
export function connectionNoticeText(connection: ConnectionStatusSummary): string | null {
  switch (connection.severity ?? "quiet") {
    case "quiet":
      return null;
    case "notice":
      return "Disconnected. Pathway will reconnect when it is reachable again.";
    case "error":
      return connectionStatusText(connection);
  }
}

export function presentEnvironmentConnection(
  state: SupervisorConnectionState,
): EnvironmentConnectionPresentation {
  return presentConnectionState(state);
}

export function connectionCatalogDisplayUrl(entry: ConnectionCatalogEntry): string | null {
  switch (entry.target._tag) {
    case "PrimaryConnectionTarget":
      return entry.target.httpBaseUrl;
    case "RelayConnectionTarget":
      return null;
    case "BearerConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "BearerConnectionProfile"
        ? entry.profile.value.httpBaseUrl
        : null;
    case "SshConnectionTarget":
      return Option.isSome(entry.profile) && entry.profile.value._tag === "SshConnectionProfile"
        ? `${entry.profile.value.target.username}@${entry.profile.value.target.hostname}`
        : null;
  }
}

export function connectionPhaseMessage(
  phase: EnvironmentConnectionPhase,
  label: string,
  networkStatus: NetworkStatus,
): string {
  if (networkStatus === "offline" || phase === "offline") {
    return "You are offline";
  }
  switch (phase) {
    case "available":
      return "Available";
    case "connecting":
      return `Connecting to ${label}...`;
    case "reconnecting":
      return `Reconnecting to ${label}...`;
    case "connected":
      return "Connected";
    case "error":
      return "Connection failed";
  }
}
