import {
  DesktopDragGhostSchema,
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

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopDragGhost from "../../window/DesktopDragGhost.ts";
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

// The drag ghost follows a tear-out drag outside every window. It goes away with
// the drag, or with the renderer that started it if that closes mid-drag.
export const startDragGhost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_START_DRAG_GHOST_CHANNEL,
  payload: DesktopDragGhostSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.startDragGhost")(function* (ghost, event) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    yield* Effect.sync(() => {
      DesktopDragGhost.startDragGhost(ghost, environment.platform);
      const sender = event ? Electron.webContents.fromId(event.sender.id) : undefined;
      sender?.once("destroyed", DesktopDragGhost.stopDragGhost);
    });
  }),
});

export const setDragGhostVisible = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_SET_DRAG_GHOST_VISIBLE_CHANNEL,
  payload: Schema.Boolean,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.setDragGhostVisible")(function* (visible) {
    yield* Effect.sync(() => DesktopDragGhost.setDragGhostVisible(visible));
  }),
});

export const stopDragGhost = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.WINDOWS_STOP_DRAG_GHOST_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.windows.stopDragGhost")(function* () {
    yield* Effect.sync(DesktopDragGhost.stopDragGhost);
  }),
});
