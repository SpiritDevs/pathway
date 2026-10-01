import type { DeviceSummary } from "@spiritdevs/contracts";
import { expect, it } from "vite-plus/test";
import { companionPhones, groupDevicesByFamily, watchPairLabel } from "./deviceFamily";

const device = (overrides: Partial<DeviceSummary> & Pick<DeviceSummary, "id" | "name">) =>
  ({
    hostId: "local",
    platform: "ios",
    version: "27.0",
    booted: false,
    physical: false,
    ...overrides,
  }) satisfies DeviceSummary;

const phone = device({ id: "phone", name: "iPhone 18 Pro", family: "phone" });
const otherHostPhone = device({ id: "far", name: "iPhone Air", family: "phone", hostId: "mac" });
const watch = device({
  id: "watch",
  name: "Renamed iPhone",
  family: "watch",
  watchPair: { pairId: "pair", phoneDeviceId: "phone", state: "(active, connected)" },
});

it("groups by server family, not the device label, with legacy Apple devices kept together", () => {
  const groups = groupDevicesByFamily([
    device({ id: "tv", name: "Apple TV 4K", family: "tv", booted: true }),
    watch,
    phone,
    device({ id: "legacy", name: "iPhone 15" }),
    device({ id: "pixel", name: "Pixel", platform: "android" }),
    device({ id: "pad", name: "iPad Air", family: "pad" }),
  ]);
  expect(groups.map((group) => [group.label, group.devices.map((item) => item.id)])).toEqual([
    ["iPhone", ["phone"]],
    ["iPad", ["pad"]],
    ["Apple Watch", ["watch"]],
    ["Apple TV", ["tv"]],
    ["iOS Simulators", ["legacy"]],
    ["Android Emulators", ["pixel"]],
  ]);
});

it("describes Watch pairing and offers only same-host iPhones", () => {
  const devices = [phone, otherHostPhone, watch];
  expect(watchPairLabel(watch, devices)).toBe("Paired with iPhone 18 Pro");
  expect(watchPairLabel({ ...watch, watchPair: null }, devices)).toBe("Not paired");
  expect(watchPairLabel({ ...watch, watchPair: undefined }, devices)).toBeUndefined();
  expect(watchPairLabel(phone, devices)).toBeUndefined();
  expect(companionPhones(watch, devices).map((item) => item.id)).toEqual(["phone"]);
});
