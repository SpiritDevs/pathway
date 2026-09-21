import {
  resolveDeviceModelId,
  type DeviceAccessorySource,
  type DeviceModelSource,
} from "@spiritdevs/client-runtime/device/model";
import type { DevicePlatform } from "@spiritdevs/contracts";

const duo: DeviceModelSource = { id: "iphone-duo", url: "procedural:duo" };

/** Phone/tablet bodies use the viewer's procedural fallback; Duo uses our original hinge rig. */
export function deviceModel(
  platform: DevicePlatform,
  name: string,
  supportsHingeAngle = false,
): DeviceModelSource | null {
  return platform === "ios" &&
    (supportsHingeAngle || resolveDeviceModelId(platform, name) === "iphone-duo")
    ? duo
    : null;
}

export function deviceKeyboard(
  _platform: DevicePlatform,
  _name: string,
): DeviceAccessorySource | null {
  return null;
}
