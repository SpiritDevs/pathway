import { ipcRenderer } from "electron";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as IpcChannels from "../ipc/channels.ts";
import { createComputerPreloadBridge, parseComputerPreviewFrame } from "./ComputerPreloadBridge.ts";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", async () => {
  const NodeEvents = await import("node:events");
  return {
    ipcRenderer: Object.assign(new NodeEvents.EventEmitter(), { invoke: mocks.invoke }),
  };
});

beforeEach(() => {
  ipcRenderer.removeAllListeners();
  mocks.invoke.mockReset();
  mocks.invoke.mockResolvedValue(undefined);
});

describe("parseComputerPreviewFrame", () => {
  it("normalizes every byte shape the frame can arrive in", () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
    expect(parseComputerPreviewFrame({ windowId: 4, seq: 1, jpeg: bytes })?.jpeg).toBe(bytes);
    expect(
      parseComputerPreviewFrame({ windowId: 4, seq: 1, jpeg: bytes.buffer })?.jpeg,
    ).toStrictEqual(bytes);
    expect(
      parseComputerPreviewFrame({
        windowId: 4,
        seq: 2,
        jpeg: new DataView(bytes.buffer, 1, 2),
      })?.jpeg,
    ).toStrictEqual(new Uint8Array([0xd8, 0xff]));
    expect(
      parseComputerPreviewFrame({
        windowId: 4,
        seq: 3,
        jpeg: { type: "Buffer", data: [0xff, 0xd8] },
      }),
    ).toStrictEqual({ windowId: 4, seq: 3, jpeg: new Uint8Array([0xff, 0xd8]) });
  });

  it("drops frames without a usable window, sequence or image", () => {
    const jpeg = new Uint8Array([0xff]);
    expect(parseComputerPreviewFrame(null)).toBeNull();
    expect(parseComputerPreviewFrame({ windowId: Number.NaN, seq: 1, jpeg })).toBeNull();
    expect(parseComputerPreviewFrame({ windowId: 1, seq: "2", jpeg })).toBeNull();
    expect(parseComputerPreviewFrame({ windowId: 1, seq: 2, jpeg: new Uint8Array() })).toBeNull();
    expect(parseComputerPreviewFrame({ windowId: 1, seq: 2, jpeg: "ff" })).toBeNull();
  });
});

describe("createComputerPreloadBridge", () => {
  it("invokes each command on its own channel", async () => {
    const bridge = createComputerPreloadBridge();
    await bridge.getState(["accessibility"]);
    await bridge.requestPermissions();
    await bridge.startPermissionSetup(["screenRecording"]);
    await bridge.openPermissionSettings("screen-recording");
    await bridge.showPermissionGuide("accessibility");
    await bridge.hidePermissionGuide();
    await bridge.restartApp();
    await bridge.setCursorStyle({ fill: "#aabbcc" });
    await bridge.setCursorStyle(null);
    expect(mocks.invoke.mock.calls).toStrictEqual([
      [IpcChannels.COMPUTER_GET_STATE_CHANNEL, ["accessibility"]],
      [IpcChannels.COMPUTER_REQUEST_PERMISSIONS_CHANNEL, undefined],
      [IpcChannels.COMPUTER_START_PERMISSION_SETUP_CHANNEL, ["screenRecording"]],
      [IpcChannels.COMPUTER_OPEN_PERMISSION_SETTINGS_CHANNEL, "screen-recording"],
      [IpcChannels.COMPUTER_SHOW_PERMISSION_GUIDE_CHANNEL, "accessibility"],
      [IpcChannels.COMPUTER_HIDE_PERMISSION_GUIDE_CHANNEL],
      [IpcChannels.COMPUTER_RESTART_APP_CHANNEL],
      [IpcChannels.COMPUTER_SET_CURSOR_STYLE_CHANNEL, { fill: "#aabbcc" }],
      [IpcChannels.COMPUTER_SET_CURSOR_STYLE_CHANNEL, null],
    ]);
  });

  it("forwards valid pushes until unsubscribed", () => {
    const bridge = createComputerPreloadBridge();
    const states: unknown[] = [];
    const errors: unknown[] = [];
    const guides: unknown[] = [];
    const frames: unknown[] = [];
    const unsubscribers = [
      bridge.onState((state) => states.push(state)),
      bridge.onError((error) => errors.push(error)),
      bridge.onPermissionGuideState((state) => guides.push(state)),
      bridge.onPreviewFrame((frame) => frames.push(frame)),
    ];
    const state = { supported: true, status: "ready" };
    const error = { code: "permission_setup_identity_mismatch", message: "x", capturedAt: "t" };
    const frame = { windowId: 9, seq: 1, jpeg: new Uint8Array([1]) };

    ipcRenderer.emit(IpcChannels.COMPUTER_STATE_CHANNEL, {}, state);
    ipcRenderer.emit(IpcChannels.COMPUTER_STATE_CHANNEL, {}, "not-a-state");
    ipcRenderer.emit(IpcChannels.COMPUTER_ERROR_CHANNEL, {}, error);
    ipcRenderer.emit(IpcChannels.COMPUTER_ERROR_CHANNEL, {}, null);
    ipcRenderer.emit(IpcChannels.COMPUTER_PERMISSION_GUIDE_STATE_CHANNEL, {}, "granted");
    ipcRenderer.emit(IpcChannels.COMPUTER_PERMISSION_GUIDE_STATE_CHANNEL, {}, "opened");
    ipcRenderer.emit(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL, {}, frame);
    ipcRenderer.emit(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL, {}, { windowId: 9 });

    expect(states).toStrictEqual([state]);
    expect(errors).toStrictEqual([error]);
    expect(guides).toStrictEqual(["granted"]);
    expect(frames).toStrictEqual([frame]);

    for (const unsubscribe of unsubscribers) unsubscribe();
    ipcRenderer.emit(IpcChannels.COMPUTER_STATE_CHANNEL, {}, state);
    ipcRenderer.emit(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL, {}, frame);
    expect(states).toHaveLength(1);
    expect(frames).toHaveLength(1);
    expect(ipcRenderer.listenerCount(IpcChannels.COMPUTER_PREVIEW_FRAME_CHANNEL)).toBe(0);
  });
});
