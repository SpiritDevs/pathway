import { describe, expect, it } from "vite-plus/test";
import type { HostResourcesSnapshot } from "@spiritdevs/contracts";
import fixtures from "./fixtures/load-balancing.json" with { type: "json" };
import { chooseLoadBalancedEnvironment } from "./load-balancing.ts";

const resources: HostResourcesSnapshot = {
  sampledAt: 0,
  cpuUtilization: 0.25,
  cpuCount: 8,
  availableMemoryBytes: 500,
  totalMemoryBytes: 1000,
};
const candidate = (
  environmentId: string,
  overrides: Partial<HostResourcesSnapshot> = {},
  weight = 50,
) => ({ environmentId, resources: { ...resources, ...overrides }, receivedAt: 20_000, weight });

describe("chooseLoadBalancedEnvironment", () => {
  it("keeps critical storage advisory by default and prefers alternatives only when enabled", () => {
    const critical = candidate("critical", {
      cpuCount: 64,
      storagePressure: "critical",
      storageSampledAt: 0,
    });
    const healthy = candidate("healthy", { storagePressure: "healthy", storageSampledAt: 0 });
    expect(chooseLoadBalancedEnvironment([critical, healthy], 20_000)).toBe("critical");
    expect(
      chooseLoadBalancedEnvironment([critical, healthy], 20_000, undefined, {
        avoidCriticalStorage: true,
      }),
    ).toBe("healthy");
    expect(
      chooseLoadBalancedEnvironment([healthy, critical], 20_000, undefined, {
        avoidCriticalStorage: true,
      }),
    ).toBe("healthy");
    expect(
      chooseLoadBalancedEnvironment([critical], 20_000, undefined, { avoidCriticalStorage: true }),
    ).toBe("critical");
  });
  it("uses storage age relative to the remote resource clock and ignores stale pressure", () => {
    const options = { avoidCriticalStorage: true };
    const critical = candidate("critical", {
      sampledAt: 9_000_000,
      storageSampledAt: 8_999_000,
      storagePressure: "critical",
      cpuCount: 64,
    });
    expect(
      chooseLoadBalancedEnvironment([critical, candidate("healthy")], 20_000, undefined, options),
    ).toBe("healthy");
    const stale = {
      ...critical,
      resources: { ...critical.resources, storageSampledAt: 8_000_000 },
    };
    expect(
      chooseLoadBalancedEnvironment([stale, candidate("healthy")], 20_000, undefined, options),
    ).toBe("critical");
  });
  it.each(fixtures)("matches shared native conformance fixture: $name", (fixture) => {
    expect(chooseLoadBalancedEnvironment(fixture.candidates, fixture.now)).toBe(
      fixture.expectedEnvironmentId,
    );
  });
  it("scores host capacity and preference while using receipt time across remote clocks", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [candidate("small"), candidate("large", { cpuCount: 16 })],
        20_001,
      ),
    ).toBe("large");
    expect(
      chooseLoadBalancedEnvironment(
        [candidate("small", {}, 100), candidate("large", { cpuCount: 16 }, 25)],
        20_001,
      ),
    ).toBe("small");
  });
  it.each([
    { cpuUtilization: null },
    { cpuUtilization: 0.95 },
    { cpuUtilization: -0.1 },
    { cpuUtilization: Number.NaN },
    { availableMemoryBytes: 50 },
    { availableMemoryBytes: 1001 },
    { availableMemoryBytes: Number.POSITIVE_INFINITY },
    { totalMemoryBytes: 0 },
    { totalMemoryBytes: Number.NaN },
    { cpuCount: 0 },
    { cpuCount: 1.5 },
  ])("rejects unknown, invalid, or busy resources: %j", (overrides) => {
    expect(chooseLoadBalancedEnvironment([candidate("invalid", overrides)], 20_000)).toBeNull();
  });
  it("rejects missing, stale, future and manual-only candidates", () => {
    expect(
      chooseLoadBalancedEnvironment(
        [{ ...candidate("missing"), resources: null }, candidate("manual", {}, 0)],
        20_000,
      ),
    ).toBeNull();
    expect(chooseLoadBalancedEnvironment([candidate("stale")], 35_001)).toBeNull();
    expect(chooseLoadBalancedEnvironment([candidate("future")], 14_999)).toBeNull();
    expect(chooseLoadBalancedEnvironment([candidate("nan", {}, Number.NaN)], 20_000)).toBeNull();
    expect(
      chooseLoadBalancedEnvironment([{ ...candidate("nan"), receivedAt: Number.NaN }], 20_000),
    ).toBeNull();
  });
  it("keeps ties stable for a draft irrespective of candidate order", () => {
    const candidates = [candidate("a"), candidate("b")];
    expect(chooseLoadBalancedEnvironment(candidates, 20_000)).toBe("a");
    expect(chooseLoadBalancedEnvironment(candidates, 20_000, "draft-1")).toBe(
      chooseLoadBalancedEnvironment(candidates.toReversed(), 20_000, "draft-1"),
    );
  });
});
