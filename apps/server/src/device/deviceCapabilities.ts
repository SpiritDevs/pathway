import type { DeviceCapabilities, DeviceFamily, DeviceSummary } from "@spiritdevs/contracts";

export function deviceFamily(
  device: Pick<DeviceSummary, "family" | "name" | "version">,
): DeviceFamily {
  // Older hubs have no family. Runtime labels remain authoritative for Watch/TV.
  return (
    device.family ??
    (/^watchOS\b/i.test(device.version)
      ? "watch"
      : /^tvOS\b/i.test(device.version)
        ? "tv"
        : /ipad/i.test(device.name)
          ? "pad"
          : "phone")
  );
}

export function deviceCapabilities(family: DeviceFamily): DeviceCapabilities {
  return {
    streaming: { status: "supported" },
    agentCli:
      family === "watch"
        ? {
            status: "unsupported",
            reason:
              "agent-device 0.21.12 has no watchOS XCTest backend. Use device_input, device_action and device_screenshot.",
          }
        : { status: "supported" },
    inputKinds:
      family === "watch"
        ? ["touch", "digitalCrown", "watchButton"]
        : family === "tv"
          ? ["remoteButton"]
          : ["touch"],
    framing: {
      shape: family === "pad" ? "tablet" : family,
      orientation: family === "tv" ? "landscape" : "portrait",
      aspectRatio:
        family === "tv" ? 16 / 9 : family === "watch" ? 0.82 : family === "pad" ? 3 / 4 : 9 / 19.5,
    },
  };
}
