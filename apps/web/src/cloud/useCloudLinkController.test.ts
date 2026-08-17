import { describe, expect, it } from "vite-plus/test";

import {
  ALWAYS_ON_CLOUD_LINK_STATE,
  AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
  automaticCloudRetryDelayMs,
  isAlwaysOnCloudLinkState,
  shouldScheduleAutomaticCloudRetry,
} from "./useCloudLinkController";

describe("always-on Pathway Connect state", () => {
  it("requires a linked managed tunnel and activity publishing", () => {
    expect(ALWAYS_ON_CLOUD_LINK_STATE).toEqual({ managedTunnel: true, publish: true });
    expect(
      isAlwaysOnCloudLinkState({
        linked: true,
        managedTunnelActive: true,
        publishAgentActivity: true,
      }),
    ).toBe(true);

    for (const state of [
      { linked: false, managedTunnelActive: true, publishAgentActivity: true },
      { linked: true, managedTunnelActive: false, publishAgentActivity: true },
      { linked: true, managedTunnelActive: true, publishAgentActivity: false },
    ]) {
      expect(isAlwaysOnCloudLinkState(state)).toBe(false);
    }
  });

  it("backs off between the five bounded attempts", () => {
    expect([0, 1, 2, 3, 4, 20].map(automaticCloudRetryDelayMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 10_000, 10_000,
    ]);
  });

  it("stops automatic reconnection after five attempts", () => {
    expect(AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS).toBe(5);
    expect(shouldScheduleAutomaticCloudRetry(4)).toBe(true);
    expect(shouldScheduleAutomaticCloudRetry(5)).toBe(false);
    expect(shouldScheduleAutomaticCloudRetry(6)).toBe(false);
  });
});
