import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** Mode flags of `pathway-helper` (native/pathway-helper/PathwayHelperProtocol.swift). */
export const PathwayHelperMode = {
  checkPermissions: "--check-permissions",
  requestPermissions: "--request-permissions",
  preparePermissionSetup: "--prepare-permission-setup",
  releaseHeldInput: "--release-held-input",
  permissionGuide: "--permission-guide",
  computerFrames: "--computer-frames",
  escapeMonitor: "--escape-monitor",
  shield: "--shield",
} as const;

export type PathwayHelperPermissionCommand =
  | typeof PathwayHelperMode.checkPermissions
  | typeof PathwayHelperMode.requestPermissions
  | typeof PathwayHelperMode.preparePermissionSetup;

export type HelperPermissionKind = "accessibility" | "inputMonitoring" | "screenRecording";
export type HelperPermission = "granted" | "denied";
export type HelperSettingsPane = "accessibility" | "input-monitoring" | "screen-recording";
export type HelperPermissionGuideState = "granted" | "closed";

export type PathwayHelperMessage =
  | {
      type: "permissions";
      accessibility?: HelperPermission;
      inputMonitoring?: HelperPermission;
      screenRecording?: HelperPermission;
    }
  | { type: "ready" }
  | { type: "escape"; capturedAt?: string }
  | {
      type: "physical-input";
      kind: "keyboard" | "pointer";
      pid?: number;
      windowId?: number;
      capturedAt?: string;
    }
  | { type: "escape-monitor-state"; armed: boolean; capturedAt?: string }
  | { type: "permission-guide"; state: HelperPermissionGuideState }
  | { type: "release-held-input"; released?: boolean; reason?: string; details?: string[] }
  | {
      type: "error";
      id?: string;
      code: string;
      message: string;
      capturedAt?: string;
      requestId?: string;
    };

const decodeJsonObject = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Decodes one stdout line to a JSON object, or none for anything else. */
export const decodeHelperJsonLine = (line: string): Option.Option<Record<string, unknown>> =>
  decodeJsonObject(line);

const isPermission = (value: unknown): value is HelperPermission =>
  value === "granted" || value === "denied";

const isIntegerIn = (value: unknown, max: number): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value > 0 && value <= max;

const nonEmpty = (value: unknown): value is string => Predicate.isString(value) && value.length > 0;

const capturedAt = (value: Record<string, unknown>) =>
  Predicate.isString(value.capturedAt) ? { capturedAt: value.capturedAt } : {};

/** Parses one helper stdout line. Unknown or malformed lines are none, never errors. */
export function parsePathwayHelperMessage(line: string): PathwayHelperMessage | null {
  const decoded = decodeHelperJsonLine(line);
  if (Option.isNone(decoded)) return null;
  const value = decoded.value;

  // The helper reports only the permission kinds it was asked about, so every
  // field is optional; a payload carrying none is not a permissions message.
  if (value.type === "permissions") {
    const permissions: Extract<PathwayHelperMessage, { type: "permissions" }> = {
      type: "permissions",
      ...(isPermission(value.accessibility) ? { accessibility: value.accessibility } : {}),
      ...(isPermission(value.inputMonitoring) ? { inputMonitoring: value.inputMonitoring } : {}),
      ...(isPermission(value.screenRecording) ? { screenRecording: value.screenRecording } : {}),
    };
    return permissions.accessibility !== undefined ||
      permissions.inputMonitoring !== undefined ||
      permissions.screenRecording !== undefined
      ? permissions
      : null;
  }
  if (value.type === "ready") return { type: "ready" };
  if (value.type === "escape") return { type: "escape", ...capturedAt(value) };
  if (value.type === "escape-monitor-state" && Predicate.isBoolean(value.armed))
    return { type: "escape-monitor-state", armed: value.armed, ...capturedAt(value) };
  if (value.type === "physical-input" && (value.kind === "keyboard" || value.kind === "pointer"))
    return {
      type: "physical-input",
      kind: value.kind,
      ...(isIntegerIn(value.pid, 0x7fffffff) ? { pid: value.pid } : {}),
      ...(isIntegerIn(value.windowId, 0xffffffff) ? { windowId: value.windowId } : {}),
      ...capturedAt(value),
    };
  if (value.type === "error" && nonEmpty(value.code) && nonEmpty(value.message))
    return {
      type: "error",
      code: value.code,
      message: value.message,
      ...(nonEmpty(value.id) ? { id: value.id } : {}),
      ...capturedAt(value),
      ...(nonEmpty(value.requestId) ? { requestId: value.requestId } : {}),
    };
  if (value.type === "permission-guide" && (value.state === "closed" || value.state === "granted"))
    return { type: "permission-guide", state: value.state };
  if (value.type === "release-held-input")
    return {
      type: "release-held-input",
      ...(Predicate.isBoolean(value.released) ? { released: value.released } : {}),
      ...(Predicate.isString(value.reason) ? { reason: value.reason } : {}),
      ...(Array.isArray(value.details) && value.details.every(Predicate.isString)
        ? { details: value.details }
        : {}),
    };
  return null;
}
