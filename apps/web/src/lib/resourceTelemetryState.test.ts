import { describe, expect, it } from "vite-plus/test";

import { isAwaitingFirstEmission } from "./resourceTelemetryState";

describe("isAwaitingFirstEmission", () => {
  it("is loading while the first snapshot has not arrived", () => {
    expect(isAwaitingFirstEmission({ isPending: true, data: null })).toBe(true);
  });

  it("stops loading once a snapshot arrives on the still-open stream", () => {
    // Subscriptions never complete, so the underlying atom keeps reporting
    // `waiting` here; the refresh control must not spin forever.
    expect(isAwaitingFirstEmission({ isPending: true, data: { cpuPercent: 1 } })).toBe(false);
  });

  it("is not loading when nothing is in flight", () => {
    expect(isAwaitingFirstEmission({ isPending: false, data: null })).toBe(false);
  });
});
