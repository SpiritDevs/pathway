import type { DeviceControlError, DeviceServiceState } from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";

export type DeviceControlCode = DeviceControlError["code"];

/** User-facing copy for each environment control failure. */
export const deviceControlErrorCopy: Record<DeviceControlCode, string> = {
  control_required: "Take control of this device before using it.",
  control_held: "Someone else is in control of this device. Take control to use it.",
  stale_generation: "Your control of this device ended. Take control again to continue.",
  control_draining: "The previous controller's input is still finishing. Try again in a moment.",
  run_stopped: "The agent run that controlled this device has ended.",
  invalid_grant:
    "The agent's device access is no longer valid. It reopens the device when it resumes.",
  input_unconfirmed:
    "Pathway couldn't confirm the last input finished. Restart the device tools, then take control again.",
};

/** A control refusal from a device hub HTTP mutation, read like the RPC error. */
export class DeviceControlRefusal extends Error {
  readonly _tag = "DeviceControlError";
  constructor(readonly code: DeviceControlCode) {
    super(deviceControlErrorCopy[code]);
  }
}

const isDeviceControlCode = (value: unknown): value is DeviceControlCode =>
  typeof value === "string" && Object.hasOwn(deviceControlErrorCopy, value);

/** Reads a control code from an RPC failure cause or an HTTP 409 body. */
export function deviceControlErrorCode(cause: unknown): DeviceControlCode | null {
  if (isDeviceControlCode(cause)) return cause;
  const error: unknown = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (typeof error !== "object" || error === null) return null;
  const tagged = error as { readonly _tag?: unknown; readonly code?: unknown };
  return tagged._tag === "DeviceControlError" && isDeviceControlCode(tagged.code)
    ? tagged.code
    : null;
}

/** Codes meaning this viewer no longer holds the lease it thinks it holds. */
export const deviceControlLost = (code: DeviceControlCode) =>
  code === "stale_generation" || code === "control_held" || code === "control_required";

/** A device whose earlier input the environment couldn't confirm finished. */
export type DeviceControlFence = { readonly hostId: string; readonly deviceId: string };

/** The device an `input_unconfirmed` failure names, so its error can outlive version drift. */
export function deviceControlFence(cause: unknown): DeviceControlFence | null {
  const error: unknown = Cause.isCause(cause) ? Cause.squash(cause) : cause;
  if (deviceControlErrorCode(error) !== "input_unconfirmed") return null;
  const { hostId, deviceId } = error as { readonly hostId?: unknown; readonly deviceId?: unknown };
  return typeof hostId === "string" && typeof deviceId === "string" ? { hostId, deviceId } : null;
}

/** A fence lasts until that device's control leaves `draining`; other devices are unaffected. */
export const deviceStillFenced = (
  state: Pick<DeviceServiceState, "controls">,
  fence: DeviceControlFence,
) =>
  state.controls?.some(
    (control) =>
      control.hostId === fence.hostId &&
      control.deviceId === fence.deviceId &&
      control.phase === "draining",
  ) === true;
