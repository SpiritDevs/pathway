import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
import {
  NativeDictationHost,
  type NativeDictationEvent,
} from "../../../../apps/desktop/src/dictation/NativeDictationHost.ts";

// oxlint-disable-next-line pathway/no-global-process-runtime -- This integrated test locates the host built for this machine.
const extension = NodeOS.platform() === "win32" ? ".exe" : "";
const binaryPath = NodeURL.fileURLToPath(
  new URL(`../../build/host/pathway-dictation-host${extension}`, import.meta.url),
);
const native = describe.skipIf(!NodeFS.existsSync(binaryPath));

native("built native host protocol without hardware capture", () => {
  it("returns real device/permission metadata and rejects unavailable capture safely", async () => {
    const events: NativeDictationEvent[] = [];
    const host = new NativeDictationHost({ binaryPath, onEvent: (event) => events.push(event) });
    try {
      await host.start();
      const [devices, permissions] = await Promise.all([
        host.request({ type: "enumerate" }),
        host.request({ type: "permissions" }),
      ]);
      for (const device of devices) {
        expect(device.id.length).toBeGreaterThan(0);
        expect(typeof device.name).toBe("string");
        expect(typeof device.isDefault).toBe("boolean");
      }
      expect(["granted", "denied", "unknown"]).toContain(permissions.microphone);
      const path = NodePath.join(NodeOS.tmpdir(), "pathway-host-must-not-create.wav");
      await expect(
        host.request({
          type: "startCapture",
          id: "unavailable",
          path,
          deviceId: "pathway-nonexistent-device",
        }),
      ).rejects.toThrow();
      expect(await host.request({ type: "cancelCapture", id: "unavailable" })).toHaveProperty(
        "cancelled",
      );
      expect(
        await host.request({ type: "configureShortcut", shortcut: "F8", enabled: false }),
      ).toEqual({ enabled: false, shortcut: "F8" });
      expect(await host.request({ type: "insert", text: "" })).toMatchObject({ status: "manual" });
      expect(events.some((event) => event.type === "level")).toBe(false);
      expect(await host.request({ type: "shutdown" })).toEqual({ shutdown: true });
    } finally {
      await host.close();
    }
  });

  it("accepts selected permission checks without requesting OS access", async () => {
    const host = new NativeDictationHost({ binaryPath, onEvent: () => {} });
    try {
      const initial = await host.request({ type: "permissions", request: false });
      const microphone = await host.request({
        type: "permissions",
        request: false,
        permission: "microphone",
      });
      const accessibility = await host.request({
        type: "permissions",
        request: false,
        permission: "accessibility",
      });
      for (const snapshot of [initial, microphone, accessibility]) {
        expect(Object.keys(snapshot).sort()).toEqual([
          "accessibility",
          "inputMonitoring",
          "microphone",
        ]);
        for (const status of Object.values(snapshot))
          expect(["granted", "denied", "unknown"]).toContain(status);
      }
    } finally {
      await host.close();
    }
  });

  it("awaits exit before immediately restarting for account metadata refresh", async () => {
    const events: NativeDictationEvent[] = [];
    const host = new NativeDictationHost({ binaryPath, onEvent: (event) => events.push(event) });
    try {
      await host.request({ type: "permissions" });
      const closing = host.close();
      const refreshed = host.request({ type: "permissions" });
      expect(host.close()).toBe(closing);
      await closing;
      expect(["granted", "denied", "unknown"]).toContain((await refreshed).microphone);
      expect(events.filter((event) => event.type === "ready")).toHaveLength(2);
      expect(events.some((event) => event.type === "error")).toBe(false);
    } finally {
      await host.close();
    }
  });
});
