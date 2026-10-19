/**
 * A backend that exists only to carry the reason there is no backend.
 *
 * Backend selection can fail before any display server is contacted: an
 * operator override naming a backend Pathway does not have, or a platform with
 * no backend at all. The service still needs a `ComputerBackend` to hand the
 * manager, and leaving it undefined would special-case every reader and lose
 * the one thing worth keeping, the sentence explaining what went wrong.
 *
 * So the failure is the backend. `availability` reports it, `health()` reports
 * it as the last failure, `capabilities()` is empty, and every action fails
 * with the same words. An operator reading the availability card and an agent
 * reading a tool error see one message, not two descriptions of one fault.
 *
 * @module computer/UnavailableComputerBackend
 */
import type { ComputerAvailability, ComputerHealth, ComputerId } from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  clampComputerMessage,
  DEFAULT_COMPUTER_ID,
  NO_COMPUTER_CAPABILITIES,
  type ComputerBackend,
} from "./ComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";

const FALLBACK_MESSAGE = "The Pathway computer backend is unavailable for an unstated reason.";

export interface UnavailableComputerBackendOptions {
  readonly computerId?: string;
  /**
   * Replaces the default `backend-unavailable` verdict, for platforms where
   * there is no backend because none could exist: the pane keys its blocked
   * copy off the verdict kind, and "unsupported platform" is a different
   * sentence from "the backend failed".
   */
  readonly availability?: ComputerAvailability;
}

export class UnavailableComputerBackend implements ComputerBackend {
  readonly computerId: ComputerId;

  private readonly message: string;
  private readonly at: string;
  private readonly verdict: ComputerAvailability;

  /** `failedAt` is the epoch millis reported as the last failure. */
  constructor(message: string, failedAt: number, options: UnavailableComputerBackendOptions = {}) {
    this.computerId = (options.computerId ?? DEFAULT_COMPUTER_ID) as ComputerId;
    this.message = clampComputerMessage(message, FALLBACK_MESSAGE);
    this.at = DateTime.formatIso(DateTime.makeUnsafe(failedAt));
    this.verdict = options.availability ?? {
      kind: "backend-unavailable",
      message: this.message,
    };
  }

  private readonly refuse = <A = never>(): Effect.Effect<A, ComputerBackendError> =>
    Effect.fail(new ComputerBackendError({ message: this.message, retryable: false }));

  readonly availability = () => Effect.succeed(this.verdict);

  /** The failure is already known and already free to read, so both agree. */
  readonly probeAvailability = () => Effect.succeed(this.verdict);

  readonly health = (): ComputerHealth => ({
    status: "unavailable",
    consecutiveFailures: 1,
    reconnects: 0,
    lastFailure: { message: this.message, at: this.at },
    captureAvailable: false,
  });

  readonly capabilities = () => NO_COMPUTER_CAPABILITIES;

  readonly listWindows = this.refuse;
  readonly getScreenSize = this.refuse;
  readonly getState = this.refuse;
  readonly captureScreenshot = this.refuse;
  readonly launchApp = this.refuse;

  /**
   * Declared even though the interface marks these optional: an absent method
   * makes the manager produce a generic "cannot" error, while refusing here
   * keeps the one message this backend exists to carry.
   */
  readonly listApps = this.refuse;
  readonly setWindowFrame = this.refuse;
  readonly invokeMenu = this.refuse;
  readonly setWindowMinimized = this.refuse;
  readonly setAppVisibility = this.refuse;
  readonly verifyState = this.refuse;
  readonly zoomWindow = this.refuse;
  readonly getAccessibilityTree = this.refuse;
  readonly getCursorPosition = this.refuse;
  readonly killApp = this.refuse;

  readonly click = this.refuse;
  readonly doubleClick = this.refuse;
  readonly tripleClick = this.refuse;
  readonly rightClick = this.refuse;
  readonly moveCursor = this.refuse;
  readonly drag = this.refuse;
  readonly scroll = this.refuse;
  readonly typeText = this.refuse;
  readonly pressKey = this.refuse;
  readonly hotkey = this.refuse;
  readonly setValue = this.refuse;
  readonly performAction = this.refuse;
  readonly selectText = this.refuse;

  readonly attachStream = this.refuse;
  readonly detachStream = () => Effect.void;

  /**
   * Present so the refusal carries this backend's one message, and so
   * `browser` being set does not itself advertise a working surface: the
   * manager gates tools on capability, and every call still fails with the
   * recorded reason.
   */
  readonly browser = { call: this.refuse };

  readonly dispose = () => Effect.void;
}

/** An unavailable backend whose failure time is now. */
export const makeUnavailableComputerBackend = (
  message: string,
  options: UnavailableComputerBackendOptions = {},
): Effect.Effect<UnavailableComputerBackend> =>
  Effect.map(
    Clock.currentTimeMillis,
    (now) => new UnavailableComputerBackend(message, now, options),
  );
