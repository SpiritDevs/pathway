import type { DeviceFamily, DeviceSummary } from "@spiritdevs/contracts";

const GROUPS = [
  { key: "phone", label: "iPhone" },
  { key: "pad", label: "iPad" },
  { key: "watch", label: "Apple Watch" },
  { key: "tv", label: "Apple TV" },
  // Older servers omit family; their Apple devices keep the combined heading.
  { key: "ios", label: "iOS Simulators" },
  { key: "android", label: "Android Emulators" },
] as const;

export type DeviceGroupKey = (typeof GROUPS)[number]["key"];

/** The server's family, never a guess from a user-renamed simulator label. */
export function deviceFamily(device: Pick<DeviceSummary, "platform" | "family">) {
  return device.platform === "ios" ? (device.family ?? null) : null;
}

/** Running devices first, then by name, in a fixed family order. */
export function groupDevicesByFamily(devices: ReadonlyArray<DeviceSummary>) {
  const groups: Array<{ key: DeviceGroupKey; label: string; devices: DeviceSummary[] }> = [];
  for (const group of GROUPS) {
    const members = devices
      .filter((device) =>
        device.platform === "android"
          ? group.key === "android"
          : (device.family ?? "ios") === group.key,
      )
      .toSorted((a, b) => Number(b.booted) - Number(a.booted) || a.name.localeCompare(b.name));
    if (members.length > 0) groups.push({ ...group, devices: members });
  }
  return groups;
}

/** Same-host iPhones that can be a Watch companion. */
export function companionPhones(watch: DeviceSummary, devices: ReadonlyArray<DeviceSummary>) {
  return devices
    .filter((device) => device.hostId === watch.hostId && device.family === "phone")
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

/** `undefined` when the server cannot report pairing for this device. */
export function watchPairLabel(watch: DeviceSummary, devices: ReadonlyArray<DeviceSummary>) {
  if (watch.family !== "watch" || watch.watchPair === undefined) return undefined;
  if (watch.watchPair === null) return "Not paired";
  const phoneId = watch.watchPair.phoneDeviceId;
  const phone = devices.find((device) => device.hostId === watch.hostId && device.id === phoneId);
  return `Paired with ${phone?.name ?? "an iPhone"}`;
}

export function familyNoun(family: DeviceFamily | null) {
  return family === "watch" ? "Apple Watch" : family === "tv" ? "Apple TV" : "Simulator";
}

/** Wheel pixels for the Digital Crown; line and page modes scale to pixels. */
export function crownDeltaFromWheel(event: { deltaY: number; deltaMode: number }) {
  return event.deltaMode === 1
    ? event.deltaY * 16
    : event.deltaMode === 2
      ? event.deltaY * 400
      : event.deltaY;
}
