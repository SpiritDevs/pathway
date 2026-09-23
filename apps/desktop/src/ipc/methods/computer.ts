import {
  DesktopComputerHelperState,
  DesktopComputerPermissionKind,
  DesktopComputerSettingsPane,
} from "@spiritdevs/contracts";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopLifecycle from "../../app/DesktopLifecycle.ts";
import {
  agentCursorPreferencePath,
  normalizeAgentCursorStylePreference,
  writeAgentCursorPreference,
} from "../../computer/AgentCursorPreference.ts";
import { DesktopComputer } from "../../computer/DesktopComputer.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MAX_PERMISSION_KINDS = 8;

class ComputerIpcUnauthorizedSenderError extends Schema.TaggedErrorClass<ComputerIpcUnauthorizedSenderError>()(
  "ComputerIpcUnauthorizedSenderError",
  {},
) {
  override get message(): string {
    return "Computer request was rejected.";
  }
}

class ComputerIpcPermissionSetupError extends Schema.TaggedErrorClass<ComputerIpcPermissionSetupError>()(
  "ComputerIpcPermissionSetupError",
  {},
) {
  override get message(): string {
    return "Permission setup requires at least one grant.";
  }
}

// Only the main window's renderer drives the Computer host.
const ensureTrustedComputerSender = Effect.fn("desktop.ipc.computer.ensureTrustedSender")(
  function* (event: DesktopIpc.DesktopIpcInvokeEvent | undefined) {
    const main = yield* (yield* ElectronWindow.ElectronWindow).main;
    if (
      event === undefined ||
      Option.isNone(main) ||
      main.value.webContents.id !== event.sender.id
    ) {
      return yield* new ComputerIpcUnauthorizedSenderError();
    }
  },
);

const decodePermissionKinds = Schema.decodeUnknownOption(
  Schema.Array(DesktopComputerPermissionKind).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_PERMISSION_KINDS),
  ),
);
const decodeSettingsPane = Schema.decodeUnknownOption(DesktopComputerSettingsPane);

/** A deduped, non-empty grant list; none for anything else, which callers read as the default. */
const parsePermissionKinds = (value: unknown) =>
  value === undefined || value === null
    ? Option.none()
    : Option.map(decodePermissionKinds(value), Arr.dedupe);

export const getComputerState = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_GET_STATE_CHANNEL,
  payload: Schema.Unknown,
  result: DesktopComputerHelperState,
  handler: Effect.fn("desktop.ipc.computer.getState")(function* (permissions, event) {
    yield* ensureTrustedComputerSender(event);
    const computer = yield* DesktopComputer;
    return yield* computer.getState(Option.getOrUndefined(parsePermissionKinds(permissions)));
  }),
});

export const requestComputerPermissions = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_REQUEST_PERMISSIONS_CHANNEL,
  payload: Schema.Unknown,
  result: DesktopComputerHelperState,
  handler: Effect.fn("desktop.ipc.computer.requestPermissions")(function* (permissions, event) {
    yield* ensureTrustedComputerSender(event);
    const computer = yield* DesktopComputer;
    return yield* computer.requestPermissions(
      Option.getOrUndefined(parsePermissionKinds(permissions)),
    );
  }),
});

export const startComputerPermissionSetup = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_START_PERMISSION_SETUP_CHANNEL,
  payload: Schema.Unknown,
  result: DesktopComputerHelperState,
  handler: Effect.fn("desktop.ipc.computer.startPermissionSetup")(function* (permissions, event) {
    yield* ensureTrustedComputerSender(event);
    const kinds = parsePermissionKinds(permissions);
    if (Option.isNone(kinds)) return yield* new ComputerIpcPermissionSetupError();
    const computer = yield* DesktopComputer;
    return yield* computer.startPermissionSetup(kinds.value);
  }),
});

export const openComputerPermissionSettings = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_OPEN_PERMISSION_SETTINGS_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.computer.openPermissionSettings")(function* (pane, event) {
    yield* ensureTrustedComputerSender(event);
    const settingsPane = decodeSettingsPane(pane);
    if (Option.isNone(settingsPane)) return false;
    const computer = yield* DesktopComputer;
    return yield* computer.openPermissionSettings(settingsPane.value);
  }),
});

export const showComputerPermissionGuide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_SHOW_PERMISSION_GUIDE_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.showPermissionGuide")(function* (pane, event) {
    yield* ensureTrustedComputerSender(event);
    const settingsPane = decodeSettingsPane(pane);
    if (Option.isNone(settingsPane)) return;
    const computer = yield* DesktopComputer;
    yield* computer.showPermissionGuide(settingsPane.value);
  }),
});

export const hideComputerPermissionGuide = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_HIDE_PERMISSION_GUIDE_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.hidePermissionGuide")(function* (_payload, event) {
    yield* ensureTrustedComputerSender(event);
    const computer = yield* DesktopComputer;
    yield* computer.hidePermissionGuide;
  }),
});

/** Screen Recording applies only after a relaunch. */
export const restartComputerApp = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_RESTART_APP_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.restartApp")(function* (_payload, event) {
    yield* ensureTrustedComputerSender(event);
    const lifecycle = yield* DesktopLifecycle.DesktopLifecycle;
    yield* lifecycle.relaunch("computer-permission-relaunch");
  }),
});

/**
 * The renderer's mirrored value is the authority for the agent cursor: the
 * normalized style is persisted first, so even a failed live push leaves the
 * next driver session correct. Stock (null) removes the stored override.
 */
export const setComputerCursorStyle = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.COMPUTER_SET_CURSOR_STYLE_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.computer.setCursorStyle")(function* (rawStyle, event) {
    yield* ensureTrustedComputerSender(event);
    const style = normalizeAgentCursorStylePreference(rawStyle);
    yield* writeAgentCursorPreference(yield* agentCursorPreferencePath, style);
    const computer = yield* DesktopComputer;
    yield* computer.setCursorStyle(style);
  }),
});
