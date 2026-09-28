import type { DeviceServiceState } from "@spiritdevs/contracts";

/**
 * Whether the Devices panel offers managed Xcode setup. Only the environment's own Mac can be set
 * up. macOS ships an `xcrun` stub, so "iOS available" alone does not prove Xcode is installed; a
 * Mac with no iOS simulator on its local host is offered setup too.
 */
export function shouldOfferXcodeSetup(
  state: Pick<DeviceServiceState, "hosts" | "devices">,
  hostSupport: "mac" | "not-mac" | "unknown",
): boolean {
  if (hostSupport !== "mac") return false;
  const local = state.hosts.find((host) => host.kind === "local");
  if (!local) return false;
  const ios = local.platforms.find((platform) => platform.platform === "ios");
  if (ios && !ios.available) return true;
  return !state.devices.some((device) => device.hostId === local.id && device.platform === "ios");
}
