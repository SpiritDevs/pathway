import {
  AVAILABLE_CONNECTION_STATE,
  type SupervisorConnectionState,
} from "@spiritdevs/client-runtime/connection";
import { describe, expect, it } from "vite-plus/test";

import { environmentHoldsLanding } from "./shell";

function connection(overrides: Partial<SupervisorConnectionState>): SupervisorConnectionState {
  return { ...AVAILABLE_CONNECTION_STATE, desired: true, ...overrides };
}

describe("environmentHoldsLanding", () => {
  it("holds the landing while a fresh environment connects", () => {
    expect(environmentHoldsLanding(connection({ phase: "connecting", attempt: 1 }))).toBe(true);
  });

  it("holds the landing through the first backoff rungs", () => {
    expect(environmentHoldsLanding(connection({ phase: "backoff", attempt: 1 }))).toBe(true);
    expect(environmentHoldsLanding(connection({ phase: "backoff", attempt: 2 }))).toBe(true);
  });

  it("holds the landing while a young connection waits for its snapshot", () => {
    expect(environmentHoldsLanding(connection({ phase: "connected", attempt: 1 }))).toBe(true);
  });

  it("settles once later retries start connecting again", () => {
    expect(environmentHoldsLanding(connection({ phase: "connecting", attempt: 3 }))).toBe(false);
    expect(environmentHoldsLanding(connection({ phase: "connecting", attempt: 4 }))).toBe(false);
  });

  it("settles once later retries sit in backoff", () => {
    expect(environmentHoldsLanding(connection({ phase: "backoff", attempt: 3 }))).toBe(false);
  });

  it("does not hold the landing for environments that are not wanted", () => {
    expect(
      environmentHoldsLanding(connection({ phase: "available", desired: false, attempt: 0 })),
    ).toBe(false);
  });

  it("does not hold the landing for offline or blocked environments", () => {
    expect(environmentHoldsLanding(connection({ phase: "offline", attempt: 1 }))).toBe(false);
    expect(environmentHoldsLanding(connection({ phase: "blocked", attempt: 1 }))).toBe(false);
  });
});
