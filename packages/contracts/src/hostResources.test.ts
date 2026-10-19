import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HostResourcesSnapshot } from "./resourceTelemetry.ts";
import { ClientSettingsPatch, ClientSettingsSchema } from "./settings.ts";

const decodeSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);
const decode = Schema.decodeUnknownSync(HostResourcesSnapshot);

describe("load balancing contracts", () => {
  it("defaults existing clients to opt out and accepts reversible preferences", () => {
    expect(decodeSettings({})).toMatchObject({
      loadBalancingEnabled: false,
      loadBalancingAvoidCriticalStorage: false,
      loadBalancingWeights: {},
    });
    expect(
      decodeSettingsPatch({
        loadBalancingEnabled: true,
        loadBalancingWeights: { manual: 0, less: 25, normal: 50, preferred: 100 },
      }).loadBalancingWeights,
    ).toEqual({ manual: 0, less: 25, normal: 50, preferred: 100 });
    for (const value of [-1, 101, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decodeSettingsPatch({ loadBalancingWeights: { invalid: value } })).toThrow();
    }
  });
  it("allows users to opt into storage avoidance and reverse that choice", () => {
    expect(
      decodeSettingsPatch({ loadBalancingAvoidCriticalStorage: true })
        .loadBalancingAvoidCriticalStorage,
    ).toBe(true);
    expect(
      decodeSettingsPatch({ loadBalancingAvoidCriticalStorage: false })
        .loadBalancingAvoidCriticalStorage,
    ).toBe(false);
  });
  it("accepts unknown CPU and rejects malformed resource metrics", () => {
    const snapshot = {
      sampledAt: 0,
      cpuCount: 8,
      cpuUtilization: null,
      availableMemoryBytes: 500,
      totalMemoryBytes: 1000,
    };
    expect(decode(snapshot)).toEqual(snapshot);
    for (const cpuUtilization of [-1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decode({ ...snapshot, cpuUtilization })).toThrow();
    }
  });
});
