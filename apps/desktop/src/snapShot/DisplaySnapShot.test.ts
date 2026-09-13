import * as NodeEvents from "node:events";
import type * as Electron from "electron";
import { beforeEach, expect, it, vi } from "vite-plus/test";

const { imageMock, macCaptureMock, nearestDisplayMock } = vi.hoisted(() => ({
  imageMock: vi.fn(),
  macCaptureMock: vi.fn(),
  nearestDisplayMock: vi.fn(),
}));
const windows: MockWindow[] = [];
class MockWindow extends NodeEvents.EventEmitter {
  readonly options: Electron.BrowserWindowConstructorOptions;
  destroyed = false;
  shown = false;
  html = "";
  webContents = Object.assign(new NodeEvents.EventEmitter(), {
    setWindowOpenHandler: vi.fn(),
    executeJavaScript: vi.fn(async () => undefined),
  });
  constructor(options: Electron.BrowserWindowConstructorOptions) {
    super();
    this.options = options;
    windows.push(this);
  }
  setMenu() {}
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setBounds() {}
  focus() {}
  show() {
    this.shown = true;
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  async loadURL(url: string) {
    this.html = decodeURIComponent(url);
  }
}
vi.mock("electron", () => ({
  get BrowserWindow() {
    return MockWindow;
  },
  nativeImage: { createFromBuffer: imageMock },
  screen: {
    getCursorScreenPoint: () => ({ x: -1200, y: 300 }),
    getDisplayNearestPoint: nearestDisplayMock,
  },
}));
vi.mock("./MacSnapShot.ts", () => ({ captureMacScreenSnapshot: macCaptureMock }));

import {
  captureDisplaySnapshot,
  SnapShotRegionCancelled,
  SnapShotRegionPicker,
} from "./DisplaySnapShot.ts";

const bounds = { x: -1440, y: -100, width: 1440, height: 900 };
beforeEach(() => {
  windows.length = 0;
  imageMock.mockReset();
  macCaptureMock.mockReset();
  nearestDisplayMock
    .mockReset()
    .mockReturnValue({ bounds, label: "Studio Display", scaleFactor: 2 });
});

it("selects a live region before capturing only its bounds without querying app context", async () => {
  const order: string[] = [];
  const png = Buffer.from("display");
  const croppedPng = Buffer.from("cropped");
  const cropped = { getSize: () => ({ width: 200, height: 160 }), toPNG: () => croppedPng };
  const image = {
    isEmpty: () => false,
    getSize: () => ({ width: 200, height: 160 }),
    toPNG: () => croppedPng,
    toDataURL: () => "data:image/png;base64,AAAA",
    crop: vi.fn(() => cropped),
  };
  imageMock.mockReturnValue(image);
  macCaptureMock.mockImplementation(async () => {
    order.push("capture");
    return png;
  });
  const picker = new SnapShotRegionPicker("darwin");
  vi.spyOn(picker, "select").mockImplementation(async () => {
    order.push("select");
    return { x: 20, y: 30, width: 100, height: 80 };
  });
  const pool = { capture: vi.fn() };
  const captured = await captureDisplaySnapshot({
    type: "region",
    platform: "darwin",
    imageTempPath: "/tmp/screen.png",
    pool,
    picker,
    maxSize: { width: 2560, height: 1600 },
    isCurrentAccount: () => true,
  });
  expect(order).toEqual(["select", "capture"]);
  expect(nearestDisplayMock).toHaveBeenCalledWith({ x: -1200, y: 300 });
  expect(macCaptureMock).toHaveBeenCalledWith(
    { x: -1420, y: -70, width: 100, height: 80 },
    "/tmp/screen.png",
  );
  expect(pool.capture).not.toHaveBeenCalled();
  expect(image.crop).not.toHaveBeenCalled();
  expect(captured.captureBounds).toEqual({ x: -1420, y: -70, width: 100, height: 80 });
  expect(captured.png).toBe(croppedPng);
  expect(captured.source).toEqual({ name: "Screen region" });
  expect(Number.isNaN(Date.parse(captured.capturedAt))).toBe(false);
});

it("captures a Windows screen using the region worker and bounds output size", async () => {
  const png = Buffer.from("screen");
  const resized = Buffer.from("resized");
  const resize = vi.fn(() => ({ toPNG: () => resized }));
  imageMock.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 2880, height: 1800 }),
    resize,
  });
  const pool = { capture: vi.fn(async () => ({ width: 2880, height: 1800, png })) };
  const picker = new SnapShotRegionPicker("darwin");
  const select = vi.spyOn(picker, "select");
  const result = await captureDisplaySnapshot({
    type: "screen",
    platform: "win32",
    imageTempPath: "/tmp/screen.png",
    pool,
    picker,
    maxSize: { width: 1440, height: 900 },
    isCurrentAccount: () => true,
  });
  expect(pool.capture).toHaveBeenCalledWith(bounds);
  expect(resize).toHaveBeenCalledWith({ width: 1440, height: 900, quality: "best" });
  expect(result.png).toBe(resized);
  expect(result.source.name).toBe("Studio Display");
  expect(select).not.toHaveBeenCalled();
});

it("does not show captured pixels after the account changes", async () => {
  macCaptureMock.mockResolvedValue(Buffer.from("screen"));
  const picker = new SnapShotRegionPicker("darwin");
  const select = vi.spyOn(picker, "select");
  await expect(
    captureDisplaySnapshot({
      type: "region",
      platform: "darwin",
      imageTempPath: "/tmp/screen.png",
      pool: { capture: vi.fn() },
      picker,
      maxSize: bounds,
      isCurrentAccount: () => false,
    }),
  ).rejects.toBeInstanceOf(SnapShotRegionCancelled);
  expect(select).not.toHaveBeenCalled();
  expect(imageMock).not.toHaveBeenCalled();
});

it("closes the region overlay on selection, escape, and account cancellation", async () => {
  const picker = new SnapShotRegionPicker("darwin");
  const selected = picker.select(bounds, 2);
  const selectedWindow = windows[0]!;
  const preventDefault = vi.fn();
  selectedWindow.webContents.emit(
    "will-navigate",
    { preventDefault },
    "pathway-snapshot-region://select?x=20&y=30&width=100&height=80",
  );
  await expect(selected).resolves.toEqual({ x: 20, y: 30, width: 100, height: 80 });
  expect(preventDefault).toHaveBeenCalled();
  expect(selectedWindow.destroyed).toBe(true);
  expect(selectedWindow.options.webPreferences).toMatchObject({
    sandbox: true,
    nodeIntegration: false,
  });
  for (const action of ["escape", "account"] as const) {
    const pending = picker.select(bounds, 2);
    const window = windows.at(-1)!;
    if (action === "escape")
      window.webContents.emit(
        "will-navigate",
        { preventDefault },
        "pathway-snapshot-region://cancel",
      );
    else picker.close();
    await expect(pending).rejects.toBeInstanceOf(SnapShotRegionCancelled);
    expect(window.destroyed).toBe(true);
  }
});

it("does not acquire any pixels when region selection is cancelled", async () => {
  const picker = new SnapShotRegionPicker("darwin");
  vi.spyOn(picker, "select").mockRejectedValue(new SnapShotRegionCancelled());
  const pool = { capture: vi.fn() };
  await expect(
    captureDisplaySnapshot({
      type: "region",
      platform: "darwin",
      imageTempPath: "/tmp/screen.png",
      pool,
      picker,
      maxSize: bounds,
      isCurrentAccount: () => true,
    }),
  ).rejects.toBeInstanceOf(SnapShotRegionCancelled);
  expect(macCaptureMock).not.toHaveBeenCalled();
  expect(pool.capture).not.toHaveBeenCalled();
});
