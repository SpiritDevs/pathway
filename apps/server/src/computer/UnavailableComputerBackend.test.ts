import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { type ComputerBackend, NO_COMPUTER_CAPABILITIES } from "./ComputerBackend.ts";
import { ComputerBackendError } from "./computerErrors.ts";
import {
  makeUnavailableComputerBackend,
  UnavailableComputerBackend,
} from "./UnavailableComputerBackend.ts";

const REASON = "No computer backend is available.";

describe("UnavailableComputerBackend", () => {
  it.effect("reports the same sentence through availability, health, and every action", () =>
    Effect.gen(function* () {
      // An operator reading the availability card and an agent reading a tool
      // error must see one message, not two descriptions of the same fault.
      yield* TestClock.setTime(1_700_000_000_000);
      const backend = yield* makeUnavailableComputerBackend(REASON);

      expect(yield* backend.availability()).toEqual({
        kind: "backend-unavailable",
        message: REASON,
      });
      expect(backend.health()).toEqual({
        status: "unavailable",
        consecutiveFailures: 1,
        reconnects: 0,
        lastFailure: { message: REASON, at: "2023-11-14T22:13:20.000Z" },
        captureAvailable: false,
      });
      expect((yield* Effect.flip(backend.listWindows())).message).toBe(REASON);
      expect((yield* Effect.flip(backend.click())).message).toBe(REASON);
      expect((yield* Effect.flip(backend.browser.call())).message).toBe(REASON);
    }),
  );

  it.effect("refuses non-retryably: nothing about a backend that does not exist will change", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(new UnavailableComputerBackend(REASON, 0).getScreenSize());

      expect(error).toBeInstanceOf(ComputerBackendError);
      expect(error).toMatchObject({ _tag: "ComputerBackendError", retryable: false });
    }),
  );

  it("advertises no capabilities, so the panel offers nothing it cannot do", () => {
    expect(new UnavailableComputerBackend(REASON, 0).capabilities()).toEqual(
      NO_COMPUTER_CAPABILITIES,
    );
  });

  it("answers to the shared desktop id, so still-frame routes match every other backend", () => {
    // Cua and Fake both use DEFAULT_COMPUTER_ID ("desktop") while every
    // pane/frame client asks for "desktop": a "primary" here 404s the route.
    expect(new UnavailableComputerBackend(REASON, 0).computerId).toBe("desktop");
    expect(new UnavailableComputerBackend(REASON, 0, { computerId: "custom" }).computerId).toBe(
      "custom",
    );
  });

  it.effect("degrades an empty reason rather than emitting a message the contract rejects", () =>
    Effect.gen(function* () {
      const availability = yield* new UnavailableComputerBackend("   ", 0).availability();

      expect(
        availability.kind === "backend-unavailable" && availability.message.length,
      ).toBeGreaterThan(0);
    }),
  );

  it.effect("detaching and disposing are no-ops, so a failed boot still tears down cleanly", () =>
    Effect.gen(function* () {
      const backend: ComputerBackend = new UnavailableComputerBackend(REASON, 0);

      // Nothing will ever change, so there is no event stream to subscribe to.
      expect(backend.events).toBeUndefined();
      yield* backend.detachStream();
      yield* backend.dispose();
    }),
  );
});
