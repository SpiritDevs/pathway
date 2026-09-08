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
