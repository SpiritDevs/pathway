import * as NodeEvents from "node:events";
import { describe, expect, it, vi, beforeEach } from "vite-plus/test";

const electron = vi.hoisted(() => ({
  getPath: vi.fn(() => "/Applications/Pathway (Alpha).app/Contents/MacOS/Pathway"),
  getFileIcon: vi.fn(),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  createWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getPath: electron.getPath, getFileIcon: electron.getFileIcon },
  shell: { openExternal: electron.openExternal, showItemInFolder: electron.showItemInFolder },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 1440, y: 0, width: 1440, height: 900 } }),
  },
  BrowserWindow: function (options: unknown) {
    return electron.createWindow(options);
  },
}));

import type { BrowserWindow } from "electron";
import {
  macPermissionAppBundle,
  macPermissionSetupHtml,
  showMacPermissionSetup,
} from "./MacPermissionSetup.ts";

function mockWindow() {
  let destroyed = false;
  const window = Object.assign(new NodeEvents.EventEmitter(), {
    webContents: Object.assign(new NodeEvents.EventEmitter(), {
      mainFrame: {},
      startDrag: vi.fn(),
      setWindowOpenHandler: vi.fn(),
    }),
    isDestroyed: () => destroyed,
    getBounds: () => ({ x: 1440, y: 0, width: 1000, height: 700 }),
    loadURL: vi.fn().mockResolvedValue(undefined),
    showInactive: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(() => {
      destroyed = true;
      window.emit("closed");
    }),
  });
  return window;
}

beforeEach(() => {
  vi.clearAllMocks();
  electron.getFileIcon.mockResolvedValue({
    isEmpty: () => false,
    toDataURL: () => "data:image/png;base64,a",
  });
  electron.openExternal.mockResolvedValue(undefined);
});

describe("macOS permission app drag", () => {
  it.each([
    [
      "/Applications/Pathway (Alpha).app/Contents/MacOS/Pathway",
      "/Applications/Pathway (Alpha).app",
    ],
    ["/Volumes/Tools/Renamed.app/Contents/MacOS/Pathway", "/Volumes/Tools/Renamed.app"],
    [
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
      "/repo/node_modules/electron/dist/Electron.app",
    ],
  ])("resolves the actual running bundle from %s", (executable, expected) => {
    expect(macPermissionAppBundle(executable)).toBe(expected);
  });

  it("rejects executables outside an app bundle", () => {
    expect(() => macPermissionAppBundle("/usr/local/bin/node")).toThrow("app bundle");
  });

  it.each([
    ["allow-screen-recording", "Privacy_ScreenCapture", "Screen Recording"],
    ["allow-accessibility", "Privacy_Accessibility", "Accessibility"],
  ] as const)(
    "opens %s with a native drag of the app and cleans up on return",
    async (action, pane, title) => {
      const owner = mockWindow();
      const panel = mockWindow();
      electron.createWindow.mockReturnValue(panel);
      await showMacPermissionSetup(owner as unknown as BrowserWindow, action);
      expect(electron.openExternal).toHaveBeenCalledWith(expect.stringContaining(pane));
      expect(decodeURIComponent(panel.loadURL.mock.calls[0]![0])).toContain(title);
      expect(panel.showInactive).toHaveBeenCalledOnce();
      expect(electron.createWindow).toHaveBeenCalledWith(
        expect.objectContaining({
          alwaysOnTop: true,
          x: 1860,
          webPreferences: expect.objectContaining({ sandbox: true, nodeIntegration: false }),
        }),
      );
      panel.webContents.emit("ipc-message", { senderFrame: {} }, "mac-permission:drag");
      expect(panel.webContents.startDrag).not.toHaveBeenCalled();
      panel.webContents.emit(
        "ipc-message",
        { senderFrame: panel.webContents.mainFrame },
        "mac-permission:drag",
        "/tmp/untrusted.app",
      );
      expect(panel.webContents.startDrag).toHaveBeenCalledWith({
        file: "/Applications/Pathway (Alpha).app",
        icon: await electron.getFileIcon.mock.results[0]!.value,
      });
      owner.emit("focus");
      expect(panel.isDestroyed()).toBe(true);
      expect(owner.listenerCount("focus")).toBe(0);
      expect(owner.webContents.listenerCount("did-start-navigation")).toBe(0);
    },
  );

  it("returns to the wizard from Back and reveals the same bundle as a keyboard alternative", async () => {
    const owner = mockWindow();
    const panel = mockWindow();
    electron.createWindow.mockReturnValue(panel);
    await showMacPermissionSetup(owner as unknown as BrowserWindow, "allow-accessibility");
    const event = { senderFrame: panel.webContents.mainFrame };
    panel.webContents.emit("ipc-message", event, "mac-permission:reveal");
    expect(electron.showItemInFolder).toHaveBeenCalledWith("/Applications/Pathway (Alpha).app");
    panel.webContents.emit("ipc-message", event, "mac-permission:back");
    expect(panel.isDestroyed()).toBe(true);
    expect(owner.show).toHaveBeenCalledOnce();
    expect(owner.focus).toHaveBeenCalledOnce();
  });

  it("closes a failed panel and removes its owner listeners", async () => {
    const owner = mockWindow();
    const panel = mockWindow();
    panel.loadURL.mockRejectedValue(new Error("load failed"));
    electron.createWindow.mockReturnValue(panel);
    await expect(
      showMacPermissionSetup(owner as unknown as BrowserWindow, "allow-screen-recording"),
    ).rejects.toThrow("load failed");
    expect(panel.isDestroyed()).toBe(true);
    expect(owner.listenerCount("focus")).toBe(0);
    expect(panel.showInactive).not.toHaveBeenCalled();
  });

  it("escapes renamed app bundles in the panel markup", () => {
    const html = macPermissionSetupHtml(
      'Pathway <img src=x> & "test"',
      "Accessibility",
      "data:image/png;base64,a",
    );
    expect(html).not.toContain("<img src=x>");
    expect(html).toContain("&#60;img src=x&#62;");
  });
});
