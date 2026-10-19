import { EnvironmentId } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "./model.ts";
import {
  connectionCatalogDisplayUrl,
  connectionNoticeText,
  connectionPhaseMessage,
  connectionStatusText,
  connectionStatusTitle,
  presentEnvironmentConnection,
  presentConnectionState,
} from "./presentation.ts";

const TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  connectionId: "connection-1",
});

const ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
  ),
};

function supervisorState(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return {
    desired: true,
    network: "online",
    phase: "connecting",
    stage: "preparing",
    attempt: 1,
    generation: 0,
    lastFailure: null,
    retryAt: null,
    ...overrides,
  };
}

describe("connection presentation", () => {
  it("preserves profile display information without exposing credentials", () => {
    expect(connectionCatalogDisplayUrl(ENTRY)).toBe("https://environment.example.test");
  });

  it("distinguishes initial connection, reconnect, and retry errors", () => {
    expect(presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 }))).toEqual({
      phase: "connecting",
      error: null,
      traceId: null,
      severity: "quiet",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "connecting",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Socket closed.",
            traceId: "trace-previous",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Socket closed.",
      traceId: "trace-previous",
      severity: "notice",
    });
    expect(
      presentConnectionState(
        supervisorState({
          phase: "backoff",
          attempt: 2,
          retryAt: 1,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Disconnected.",
            traceId: "trace-1",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Disconnected.",
      traceId: "trace-1",
      severity: "notice",
    });
  });

  it("preserves the latest failure while the next attempt is active", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connecting",
          stage: "opening",
          attempt: 2,
          lastFailure: new ConnectionTransientError({
            reason: "transport",
            detail: "Relay connection timed out.",
            traceId: "trace-retry",
          }),
        }),
      ),
    ).toEqual({
      phase: "reconnecting",
      error: "Relay connection timed out.",
      traceId: "trace-retry",
      severity: "notice",
    });
  });

  it("gives offline status precedence in global messaging", () => {
    expect(connectionPhaseMessage("connected", TARGET.label, "offline")).toBe("You are offline");
  });

  it("combines reconnect progress with the latest failure", () => {
    const connection = {
      phase: "reconnecting",
      error: "Relay request timed out.",
      traceId: "trace-retry",
    } as const;
    expect(connectionStatusText(connection)).toBe(
      "Failed to connect. Reconnecting... Reason: Relay request timed out.",
    );
    expect(connectionStatusTitle(connection)).toBe("Failed to connect. Reconnecting...");
  });

  it("keeps an unreachable peer a notice however long it retries", () => {
    const unreachable = presentConnectionState(
      supervisorState({
        phase: "backoff",
        attempt: 27,
        retryAt: 1,
        lastFailure: new ConnectionTransientError({
          reason: "relay-unavailable",
          detail: "Relay environment endpoint is unavailable: endpoint_request_failed",
          traceId: "trace-gone",
        }),
      }),
    );
    expect(unreachable.severity).toBe("notice");
    expect(connectionStatusTitle(unreachable)).toBe("Disconnected");
    expect(connectionStatusText(unreachable)).toBe(
      "Disconnected. Reason: Relay environment endpoint is unavailable: endpoint_request_failed",
    );
    expect(connectionNoticeText(unreachable)).toBe(
      "Disconnected. Pathway will reconnect when it is reachable again.",
    );
    // The reason is still recoverable for debugging, just not shouted in the row.
    expect(unreachable.error).toBe(
      "Relay environment endpoint is unavailable: endpoint_request_failed",
    );
    expect(unreachable.traceId).toBe("trace-gone");
  });

  it("escalates a non-unreachable transient failure once the grace attempts run out", () => {
    const failure = new ConnectionTransientError({
      reason: "transport",
      detail: "Socket closed.",
      traceId: "trace-flaky",
    });
    expect(
      presentConnectionState(
        supervisorState({ phase: "backoff", attempt: 3, lastFailure: failure }),
      ).severity,
    ).toBe("notice");
    expect(
      presentConnectionState(
        supervisorState({ phase: "backoff", attempt: 9, lastFailure: failure }),
      ).severity,
    ).toBe("error");
  });

  it("reports a blocked connection as an error immediately", () => {
    const blocked = presentConnectionState(
      supervisorState({
        phase: "blocked",
        attempt: 1,
        lastFailure: new ConnectionBlockedError({
          reason: "authentication",
          detail: "Pairing token was rejected.",
        }),
      }),
    );
    expect(blocked.severity).toBe("error");
    expect(connectionNoticeText(blocked)).toBe(
      "Connection failed. Reason: Pairing token was rejected.",
    );
  });

  it("says nothing at all while a connection is healthy or first attempting", () => {
    expect(
      connectionNoticeText(presentConnectionState(supervisorState({ phase: "connected" }))),
    ).toBe(null);
    expect(
      connectionNoticeText(
        presentConnectionState(supervisorState({ phase: "connecting", attempt: 1 })),
      ),
    ).toBe(null);
  });

  it("presents the supervisor's offline state without consulting shell state", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          network: "offline",
          phase: "offline",
          stage: null,
        }),
      ),
    ).toEqual({
      phase: "offline",
      error: null,
      traceId: null,
      severity: "quiet",
    });
  });

  it("presents a connected supervisor snapshot as connected", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          phase: "connected",
          stage: null,
          generation: 1,
        }),
      ),
    ).toEqual({
      phase: "connected",
      error: null,
      traceId: null,
      severity: "quiet",
    });
  });

  it("preserves an explicitly available environment while offline", () => {
    expect(
      presentEnvironmentConnection(
        supervisorState({
          desired: false,
          network: "offline",
          phase: "available",
          stage: null,
          attempt: 0,
        }),
      ),
    ).toEqual({
      phase: "available",
      error: null,
      traceId: null,
      severity: "quiet",
    });
  });
});
