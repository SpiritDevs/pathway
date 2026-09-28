import {
  DesktopScreenPointSchema,
  DesktopScreenRectSchema,
  DesktopWindowInfoSchema,
  DesktopWindowOpenInputSchema,
  DesktopWindowOpenResultSchema,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopWindow from "../../window/DesktopWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

// Tear-out windows. The registry lives in DesktopWindow; these are thin
// wrappers so every renderer (main or torn-out) can drive it.

export const openWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_OPEN_CHANNEL,
  payload: DesktopWindowOpenInputSchema,
  result: DesktopWindowOpenResultSchema,
  handler: Effect.fn("desktop.ipc.windows.open")(function* (input) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.openChild(input);
  }),
});

export const closeWindow = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_CLOSE_CHANNEL,
  payload: Schema.String,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.close")(function* (id) {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.closeChild(id);
  }),
});

export const closeAllWindows = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_CLOSE_ALL_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.closeAll")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.closeAllChildren;
  }),
});

export const listWindows = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_LIST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(DesktopWindowInfoSchema),
  handler: Effect.fn("desktop.ipc.windows.list")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.listChildren;
  }),
});

export const getCursorScreenPoint = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_GET_CURSOR_SCREEN_POINT_CHANNEL,
  payload: Schema.Void,
  result: DesktopScreenPointSchema,
  handler: Effect.fn("desktop.ipc.windows.getCursorScreenPoint")(function* () {
    return yield* Effect.sync(() => Electron.screen.getCursorScreenPoint());
  }),
});

export const getCurrentWindowBounds = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_GET_CURRENT_WINDOW_BOUNDS_CHANNEL,
  payload: Schema.Void,
  result: DesktopScreenRectSchema,
  handler: Effect.fn("desktop.ipc.windows.getCurrentWindowBounds")(function* (_input, event) {
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* ElectronWindow.senderWindowOr(
      event?.sender,
      electronWindow.currentMainOrFirst,
    );
    return Option.match(window, {
      onNone: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      onSome: (window) => window.getBounds(),
    });
  }),
});
