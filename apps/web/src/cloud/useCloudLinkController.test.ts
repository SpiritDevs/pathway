import { describe, expect, it } from "vite-plus/test";

import {
  ALWAYS_ON_CLOUD_LINK_STATE,
  AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
  automaticCloudRetryDelayMs,
  isAlwaysOnCloudLinkState,
  isCloudAccountLinkConflict,
  resolveCloudAccountMembership,
  shouldRelinkCloudEnvironment,
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
        linkedRelayUrl: "https://relay.example.test/",
        configuredRelayUrl: "https://relay.example.test",
      }),
    ).toBe(true);

    for (const state of [
      {
        linked: false,
        managedTunnelActive: true,
        publishAgentActivity: true,
        linkedRelayUrl: "https://relay.example.test",
        configuredRelayUrl: "https://relay.example.test",
      },
      {
        linked: true,
        managedTunnelActive: false,
        publishAgentActivity: true,
        linkedRelayUrl: "https://relay.example.test",
        configuredRelayUrl: "https://relay.example.test",
      },
      {
        linked: true,
        managedTunnelActive: true,
        publishAgentActivity: false,
        linkedRelayUrl: "https://relay.example.test",
        configuredRelayUrl: "https://relay.example.test",
      },
      {
        linked: true,
        managedTunnelActive: true,
        publishAgentActivity: true,
        linkedRelayUrl: "https://relay-dev.example.test",
        configuredRelayUrl: "https://relay.example.test",
      },
    ]) {
      expect(isAlwaysOnCloudLinkState(state)).toBe(false);
    }
  });

  it("backs off between the five bounded attempts", () => {
    expect([0, 1, 2, 3, 4, 20].map(automaticCloudRetryDelayMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 10_000, 10_000,
    ]);
  });

  it("relinks an environment when the installed relay deployment changed", () => {
    expect(
      shouldRelinkCloudEnvironment({
        linked: true,
        managedTunnelActive: true,
        desiredManagedTunnel: true,
        linkedRelayUrl: "https://relay-dev.example.test",
        configuredRelayUrl: "https://relay.example.test",
      }),
    ).toBe(true);
    expect(
      shouldRelinkCloudEnvironment({
        linked: true,
        managedTunnelActive: true,
        desiredManagedTunnel: true,
        linkedRelayUrl: "https://relay.example.test/",
        configuredRelayUrl: "https://relay.example.test",
      }),
    ).toBe(false);
  });

  it("stops automatic reconnection after five attempts", () => {
    expect(AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS).toBe(5);
    expect(shouldScheduleAutomaticCloudRetry(4)).toBe(true);
    expect(shouldScheduleAutomaticCloudRetry(5)).toBe(false);
    expect(shouldScheduleAutomaticCloudRetry(6)).toBe(false);
  });

  it("stops immediately when the environment belongs to another cloud account", () => {
    const conflict =
      "Could not configure environment relay access: This environment is already linked to a different cloud account. Unlink it before switching accounts.";

    expect(isCloudAccountLinkConflict(conflict)).toBe(true);
    expect(shouldScheduleAutomaticCloudRetry(1, AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS, conflict)).toBe(
      false,
    );
    expect(isCloudAccountLinkConflict("Relay is temporarily unavailable.")).toBe(false);
    expect(
      shouldScheduleAutomaticCloudRetry(
        1,
        AUTOMATIC_CLOUD_LINK_MAX_ATTEMPTS,
        "Relay is temporarily unavailable.",
      ),
    ).toBe(true);
  });
});

describe("Pathway Connect account membership", () => {
  const listing = {
    listed: true,
    hasError: false,
    offline: false,
    environmentIds: ["environment-1", "environment-2"],
    environmentId: "environment-1",
  };

  it("reads membership from an established account listing", () => {
    expect(resolveCloudAccountMembership(listing)).toBe("present");
    expect(resolveCloudAccountMembership({ ...listing, environmentId: "environment-3" })).toBe(
      "absent",
    );
    expect(
      resolveCloudAccountMembership({
        ...listing,
        environmentIds: [],
        environmentId: "environment-1",
      }),
    ).toBe("absent");
  });

  it("never infers absence from an unestablished listing", () => {
    for (const state of [
      { ...listing, listed: false },
      { ...listing, hasError: true },
      { ...listing, offline: true },
      { ...listing, environmentId: null },
    ]) {
      expect(resolveCloudAccountMembership(state)).toBe("unknown");
    }
  });

  it("treats an environment the account dropped as unsatisfied and relinks it", () => {
    const linkState = {
      linked: true,
      managedTunnelActive: true,
      publishAgentActivity: true,
      linkedRelayUrl: "https://relay.example.test",
      configuredRelayUrl: "https://relay.example.test",
    };
    expect(isAlwaysOnCloudLinkState({ ...linkState, accountMembership: "present" })).toBe(true);
    expect(isAlwaysOnCloudLinkState({ ...linkState, accountMembership: "unknown" })).toBe(true);
    expect(isAlwaysOnCloudLinkState({ ...linkState, accountMembership: "absent" })).toBe(false);

    const relinkState = {
      linked: true,
      managedTunnelActive: true,
      desiredManagedTunnel: true,
      linkedRelayUrl: "https://relay.example.test",
      configuredRelayUrl: "https://relay.example.test",
    };
    expect(shouldRelinkCloudEnvironment({ ...relinkState, accountMembership: "present" })).toBe(
      false,
    );
    expect(shouldRelinkCloudEnvironment({ ...relinkState, accountMembership: "unknown" })).toBe(
      false,
    );
    expect(shouldRelinkCloudEnvironment({ ...relinkState, accountMembership: "absent" })).toBe(
      true,
    );
  });
});
