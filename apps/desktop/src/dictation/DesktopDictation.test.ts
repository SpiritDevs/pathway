// @effect-diagnostics nodeBuiltinImport:off -- EventEmitter models native window events in this boundary test.
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Electron from "electron";
import { beforeEach, expect, vi } from "vite-plus/test";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopDictation from "./DesktopDictation.ts";
import * as channels from "./channels.ts";

const native = vi.hoisted(() => ({
  destroyTray: vi.fn(),
  setContextMenu: vi.fn(),
  ipcOn: vi.fn<(channel: string, listener: (event: unknown, value: unknown) => void) => void>(),
  screenOn: vi.fn<(event: string, listener: () => void) => void>(),
  screenRemoveListener: vi.fn(),
  displays: [{ id: 1, workArea: { x: 0, y: 25, width: 1440, height: 795 } }],
  cursorDisplay: 1,
  bounds: { x: 0, y: 0, width: 256, height: 72 },
  setBounds: vi.fn(),
  setAlwaysOnTop: vi.fn(),
  windowOptions: vi.fn(),
  shown: Promise.withResolvers<void>(),
}));
vi.mock("electron", () => ({
  app: { isReady: () => true, prependListener: vi.fn(), removeListener: vi.fn() },
  powerMonitor: { on: vi.fn(), removeListener: vi.fn() },
  ipcMain: { on: native.ipcOn, removeListener: vi.fn() },
  screen: {
    getAllDisplays: () => native.displays,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () =>
      native.displays.find((display) => display.id === native.cursorDisplay),
    on: native.screenOn,
    removeListener: native.screenRemoveListener,
  },
  BrowserWindow: class {
    constructor(options: unknown) {
      native.windowOptions(options);
    }
    webContents = { id: 2, send: vi.fn(), setWindowOpenHandler: vi.fn(), on: vi.fn() };
    setVisibleOnAllWorkspaces() {}
    setAlwaysOnTop = native.setAlwaysOnTop;
    on() {}
    loadURL = async () => {};
    isDestroyed = () => false;
    getBounds = () => native.bounds;
    setBounds(bounds: typeof native.bounds, animate: boolean) {
      native.bounds = bounds;
      native.setBounds(bounds, animate);
    }
    showInactive() {
      native.shown.resolve();
    }
    hide() {}
    destroy() {}
  },
  nativeImage: { createEmpty: () => ({}) },
  Menu: { buildFromTemplate: (items: unknown) => items },
  Tray: class {
    destroy = native.destroyTray;
    setContextMenu = native.setContextMenu;
    setToolTip() {}
    on() {}
  },
}));
vi.mock("../window/DesktopWindow.ts", async () => {
  const Context = await import("effect/Context");
  return { DesktopWindow: Context.Service("test/DesktopWindow") };
});

class TestWindow extends NodeEvents.EventEmitter {
  id = 1;
  destroyed = false;
  visible = true;
  webContents = Object.assign(new NodeEvents.EventEmitter(), { send: vi.fn() });
  hide = vi.fn(() => {
    this.visible = false;
  });
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
}

const environmentLayerFor = (platform: "darwin" | "win32") =>
  DesktopEnvironment.layer({
    dirname: "/repo/apps/desktop/dist-electron",
    homeDirectory: "/Users/alice",
    platform,
    processArch: "x64",
    appVersion: "1.2.3",
    appPath: "/repo",
    isPackaged: false,
    resourcesPath: "/repo/resources",
    runningUnderArm64Translation: false,
  }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))));
const environmentLayer = environmentLayerFor("win32");

function checkLifecycle(
  check: (input: { window: TestWindow; disable: () => void; signOut: () => void }) => void,
) {
  return Effect.gen(function* () {
    const service = yield* DesktopDictation.DesktopDictation;
    vi.spyOn(service.controller, "dispose").mockResolvedValue();
    let state = service.controller.getState();
    state = {
      ...state,
      authenticated: true,
      accountId: "test-account",
      preferences: { ...state.preferences, enabled: true, showIdleBar: false },
      phase: "idle",
    };
    vi.spyOn(service.controller, "getState").mockImplementation(() => state);
    vi.spyOn(service.controller, "isBackgroundEnabled", "get").mockImplementation(
      () => state.authenticated && state.preferences.enabled,
    );
    const window = new TestWindow();
    service.bindMain(window as unknown as Electron.BrowserWindow);
    service.controller.modelChanged();
    check({
      window,
      disable: () => {
        state = {
          ...state,
          phase: "disabled",
          preferences: { ...state.preferences, enabled: false },
        };
        service.controller.modelChanged();
      },
      signOut: () => {
        state = { ...state, phase: "disabled", authenticated: false, accountId: null };
        service.controller.modelChanged();
      },
    });
  }).pipe(
    Effect.provide(
      DesktopDictation.layer.pipe(
        Layer.provide(environmentLayer),
        Layer.provide(
          Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  native.displays = [{ id: 1, workArea: { x: 0, y: 25, width: 1440, height: 795 } }];
  native.cursorDisplay = 1;
  native.bounds = { x: 0, y: 0, width: 256, height: 72 };
  native.shown = Promise.withResolvers<void>();
});
describe("dictation background window lifecycle", () => {
  it.effect("reveals a window retained by dictation when dictation is disabled", () =>
    checkLifecycle(({ window, disable }) => {
      const preventDefault = vi.fn();
      window.emit("close", { preventDefault });
      expect(preventDefault).toHaveBeenCalledOnce();
      expect(window.visible).toBe(false);
      disable();
      expect(window.visible).toBe(true);
      expect(window.focus).toHaveBeenCalledOnce();
      expect(native.destroyTray).toHaveBeenCalledOnce();
      const nextClose = vi.fn();
      window.emit("close", { preventDefault: nextClose });
      expect(nextClose).not.toHaveBeenCalled();
    }),
  );
  it.effect("reveals a retained window on sign-out and removes the tray", () =>
    checkLifecycle(({ window, signOut }) => {
      window.emit("close", { preventDefault: vi.fn() });
      signOut();
      expect(window.visible).toBe(true);
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
  it.effect("does not focus a window that dictation did not hide", () =>
    checkLifecycle(({ window, disable }) => {
      disable();
      expect(window.show).not.toHaveBeenCalled();
      expect(window.focus).not.toHaveBeenCalled();
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
  it.effect("does not reveal a destroyed retained window", () =>
    checkLifecycle(({ window, disable }) => {
      window.emit("close", { preventDefault: vi.fn() });
      window.destroyed = true;
      disable();
      expect(window.show).not.toHaveBeenCalled();
      expect(native.destroyTray).toHaveBeenCalledOnce();
    }),
  );
});

function checkOverlay(
  check: (resize: (width: number, height: number, senderId?: number) => void) => void,
) {
  return Effect.gen(function* () {
    const service = yield* DesktopDictation.DesktopDictation;
    vi.spyOn(service.controller, "initialize").mockResolvedValue();
    vi.spyOn(service.controller, "dispose").mockResolvedValue();
    const initial = service.controller.getState();
    vi.spyOn(service.controller, "getState").mockReturnValue({
      ...initial,
      authenticated: true,
      accountId: "test-account",
      preferences: { ...initial.preferences, enabled: true, showIdleBar: true },
      phase: "idle",
    });
    yield* service.initialize;
    service.controller.modelChanged();
    yield* Effect.promise(() => native.shown.promise);
    const listener = native.ipcOn.mock.calls.find(
      ([channel]) => channel === channels.DICTATION_RESIZE,
    )![1];
    check((width, height, senderId = 2) =>
      listener({ sender: { id: senderId } }, { width, height }),
    );
  }).pipe(
    Effect.provide(
      DesktopDictation.layer.pipe(
        Layer.provide(environmentLayerFor("darwin")),
        Layer.provide(
          Layer.succeed(DesktopWindow.DesktopWindow, {} as DesktopWindow.DesktopWindow["Service"]),
        ),
      ),
    ),
    Effect.scoped,
  );
}

function displayChanged(event = "display-metrics-changed") {
  native.screenOn.mock.calls.find(([name]) => name === event)![1]();
}

describe("dictation overlay placement", () => {
  it.effect("grows upward above the Dock without taking focus", () =>
    checkOverlay((resize) => {
      const idle = { ...native.bounds };
      resize(408, 550);
      expect(native.bounds.y).toBeLessThan(idle.y);
      expect(native.bounds.y + native.bounds.height).toBe(idle.y + idle.height);
      expect(native.bounds.y + native.bounds.height).toBe(802);
      expect(native.setBounds).toHaveBeenLastCalledWith(native.bounds, false);
      expect(native.setAlwaysOnTop).toHaveBeenCalledWith(true, "pop-up-menu");
      expect(native.windowOptions).toHaveBeenCalledWith(
        expect.objectContaining({ focusable: false }),
      );
      resize(256, 72);
      expect(native.bounds).toEqual(idle);
    }),
  );
  it.effect(
    "refreshes the Dock work area and keeps the selected display when the pointer moves",
    () =>
      checkOverlay((resize) => {
        native.displays = [
          { id: 1, workArea: { x: 0, y: 25, width: 1440, height: 680 } },
          { id: 2, workArea: { x: 1440, y: 0, width: 1920, height: 1080 } },
        ];
        native.cursorDisplay = 2;
        displayChanged();
        expect(native.bounds.y + native.bounds.height).toBe(687);
        resize(424, 440);
        expect(native.bounds.x).toBe(508);
        expect(native.bounds.y + native.bounds.height).toBe(687);
      }),
  );
  it.effect(
    "moves off a removed display and fits a small work area without losing the requested size",
    () =>
      checkOverlay((resize) => {
        resize(424, 440);
        native.displays = [{ id: 2, workArea: { x: -320, y: -300, width: 320, height: 300 } }];
        native.cursorDisplay = 2;
        displayChanged("display-removed");
        expect(native.bounds).toEqual({ x: -320, y: -300, width: 320, height: 282 });
        native.displays = [{ id: 2, workArea: { x: -1440, y: -900, width: 1440, height: 900 } }];
        displayChanged();
        expect(native.bounds).toEqual({ x: -932, y: -458, width: 424, height: 440 });
      }),
  );
  it.effect("ignores invalid or untrusted resize requests and avoids redundant native moves", () =>
    checkOverlay((resize) => {
      native.setBounds.mockClear();
      resize(256, 72);
      resize(424, 440, 99);
      resize(Number.NaN, 440);
      resize(424, Number.POSITIVE_INFINITY);
      displayChanged();
      expect(native.setBounds).not.toHaveBeenCalled();
    }),
  );
});
