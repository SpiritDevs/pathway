/**
 * Supervision health accounting, shared by every plugin-backed computer backend.
 *
 * The counters are the part of health that is identical whatever the display
 * server is: how many attempts have failed since the last good connection, how
 * many times the backend has come back, what went wrong most recently, and the
 * de-duplication that keeps one outage from being counted twice. What differs
 * per backend is only the *status* — which live objects have to exist for a
 * backend to call itself connected — so that stays a callback the owner
 * supplies rather than state this module tries to model.
 *
 * @module computer/computerHealthState
 */
import type {
  ComputerHealth,
  ComputerHealthFailure,
  ComputerHealthStatus,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";

import { clampComputerMessage } from "./ComputerBackend.ts";

/** The part of health only the owning backend can answer. */
export interface ComputerHealthStatusReading {
  readonly status: ComputerHealthStatus;
  readonly captureAvailable: boolean;
  /**
   * Set only by a backend that can tell its input delivery has lost a rung.
   * Left absent everywhere else, so a backend with no such notion encodes
   * exactly as it did before the field existed.
   */
  readonly backgroundInputDegraded?: boolean;
  /**
   * Set only by a backend that let its desktop or connection go on purpose
   * and brings it back on the next use; see `ComputerHealth.dormant`.
   */
  readonly dormant?: boolean;
}

export interface ComputerHealthStateOptions {
  /**
   * Read live status. Called on every `health()` so what a panel is told and
   * what the next action will find cannot drift apart, which means it must stay
   * synchronous and side-effect free: it runs from inside the handler of the
   * very event that changed it.
   */
  readonly readStatus: () => ComputerHealthStatusReading;
  /** Publishes a changed health snapshot. Never called for an unchanged one. */
  readonly emit: (health: ComputerHealth) => void;
  /** Wall-clock milliseconds, for `lastFailure.at`. */
  readonly now: () => number;
  /** Used when the failure carried no message of its own. */
  readonly failureFallbackMessage: string;
}

export interface ComputerHealthState {
  readonly consecutiveFailures: () => number;
  readonly reconnects: () => number;
  readonly health: () => ComputerHealth;
  /**
   * Records one supervision failure. Mutates only: the transition that follows
   * it — a scheduled reconnect, a refusal with no retry — decides the status,
   * and publishing here would put an "unavailable" event on the wire that the
   * next line immediately corrects.
   */
  readonly recordFailure: (error: unknown) => void;
  /**
   * Records a successful connection. A connection re-established after the
   * first one is a recovery, whether a reconnect timer or the next action drove
   * it. `lastFailure` survives on purpose: it is how a healed outage can still
   * be explained.
   */
  readonly recordConnected: () => void;
  /** Publishes health to observers, and only on a real change. */
  readonly publish: () => void;
}

export function makeComputerHealthState(options: ComputerHealthStateOptions): ComputerHealthState {
  let consecutiveFailures = 0;
  let reconnects = 0;
  let lastFailure: ComputerHealthFailure | undefined;
  let hasConnected = false;
  /**
   * The error the failure counters were last moved for. One connection loss
   * reaches the counters twice — the connect path fails with what the caller
   * then reports — and both hops carry the same value, so identity is what
   * keeps a single outage from counting as two.
   */
  let countedFailure: unknown;
  let publishedHealth: ComputerHealth | undefined;

  const health = (): ComputerHealth => {
    const reading = options.readStatus();
    return {
      status: reading.status,
      consecutiveFailures,
      reconnects,
      ...(lastFailure ? { lastFailure } : {}),
      captureAvailable: reading.captureAvailable,
      ...(reading.backgroundInputDegraded === undefined
        ? {}
        : { backgroundInputDegraded: reading.backgroundInputDegraded }),
      ...(reading.dormant === true ? { dormant: true } : {}),
    };
  };

  return {
    consecutiveFailures: () => consecutiveFailures,
    reconnects: () => reconnects,
    health,
    recordFailure: (error) => {
      if (error === countedFailure) return;
      countedFailure = error;
      consecutiveFailures += 1;
      lastFailure = {
        message: clampComputerMessage(
          error instanceof Error ? error.message : String(error),
          options.failureFallbackMessage,
        ),
        at: DateTime.formatIso(DateTime.makeUnsafe(options.now())),
      };
    },
    recordConnected: () => {
      if (hasConnected) reconnects += 1;
      hasConnected = true;
      consecutiveFailures = 0;
      countedFailure = undefined;
    },
    publish: () => {
      const next = health();
      if (publishedHealth && sameComputerHealth(publishedHealth, next)) return;
      publishedHealth = next;
      options.emit(next);
    },
  };
}

export function sameComputerHealth(left: ComputerHealth, right: ComputerHealth): boolean {
  return (
    left.status === right.status &&
    left.consecutiveFailures === right.consecutiveFailures &&
    left.reconnects === right.reconnects &&
    left.captureAvailable === right.captureAvailable &&
    left.backgroundInputDegraded === right.backgroundInputDegraded &&
    left.dormant === right.dormant &&
    left.lastFailure?.at === right.lastFailure?.at &&
    left.lastFailure?.message === right.lastFailure?.message
  );
}
