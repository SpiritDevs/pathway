import { ipcRenderer } from "electron";
import type {
  DesktopComputerBridge,
  DesktopComputerHelperError,
  DesktopComputerHelperState,
  DesktopComputerPreviewFrame,
} from "@spiritdevs/contracts";

import * as IpcChannels from "../ipc/channels.ts";

// Structured clone delivers a Node Buffer as Uint8Array; the JSON-era
// {type:"Buffer",data:[...]} shape is normalized too so the listener always
// receives a plain Uint8Array.
function computerPreviewFrameBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { readonly type?: unknown }).type === "Buffer" &&
    Array.isArray((value as { readonly data?: unknown }).data)
  ) {
    return Uint8Array.from((value as { readonly data: readonly number[] }).data);
  }
  return null;
}

export function parseComputerPreviewFrame(payload: unknown): DesktopComputerPreviewFrame | null {
  if (!payload || typeof payload !== "object") return null;
  const frame = payload as Record<string, unknown>;
  if (typeof frame.windowId !== "number" || !Number.isFinite(frame.windowId)) return null;
  if (typeof frame.seq !== "number" || !Number.isFinite(frame.seq)) return null;
  const jpeg = computerPreviewFrameBytes(frame.jpeg);
  if (!jpeg || jpeg.byteLength === 0) return null;
  return { windowId: frame.windowId, seq: frame.seq, jpeg };
}

/** Subscribes to a main-process push; the returned function unsubscribes. */
function subscribe<T>(
  channel: string,
  parse: (payload: unknown) => T | null,
  listener: (value: T) => void,
): () => void {
  const receive = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    const value = parse(payload);
    if (value !== null) listener(value);
  };
  ipcRenderer.on(channel, receive);
  return () => {
    ipcRenderer.removeListener(channel, receive);
  };
}

const objectPayload = <T>(payload: unknown): T | null =>
  typeof payload === "object" && payload !== null ? (payload as T) : null;

/**
 * `DesktopBridge.computer`: the desktop Computer host's grants, permission
 * guide, agent cursor and live frame tap. The main process owns validation,
 * persistence and the live push to a running driver.
 */
export function createComputerPreloadBridge(): DesktopComputerBridge {
  return {
    getState: (permissions) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_GET_STATE_CHANNEL, permissions),
    requestPermissions: (permissions) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_REQUEST_PERMISSIONS_CHANNEL, permissions),
    startPermissionSetup: (permissions) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_START_PERMISSION_SETUP_CHANNEL, permissions),
    openPermissionSettings: (pane) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_OPEN_PERMISSION_SETTINGS_CHANNEL, pane),
    showPermissionGuide: (pane) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_SHOW_PERMISSION_GUIDE_CHANNEL, pane),
    hidePermissionGuide: () =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_HIDE_PERMISSION_GUIDE_CHANNEL),
    restartApp: () => ipcRenderer.invoke(IpcChannels.COMPUTER_RESTART_APP_CHANNEL),
    setCursorStyle: (style) =>
      ipcRenderer.invoke(IpcChannels.COMPUTER_SET_CURSOR_STYLE_CHANNEL, style),
    onState: (listener) =>
      subscribe(
        IpcChannels.COMPUTER_STATE_CHANNEL,
        objectPayload<DesktopComputerHelperState>,
        listener,
      ),
    onError: (listener) =>
      subscribe(
        IpcChannels.COMPUTER_ERROR_CHANNEL,
        objectPayload<DesktopComputerHelperError>,
        listener,
      ),
    onPermissionGuideState: (listener) =>
      subscribe(
        IpcChannels.COMPUTER_PERMISSION_GUIDE_STATE_CHANNEL,
        (state) => (state === "granted" || state === "closed" ? state : null),
        listener,
      ),
    onPreviewFrame: (listener) =>
      subscribe(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL, parseComputerPreviewFrame, listener),
  };
}
