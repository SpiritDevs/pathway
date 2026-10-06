import type { DesktopBridge } from "@spiritdevs/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import { __resetDesktopPrimaryAuthForTests, readDesktopPrimaryBearerToken } from "./desktopAuth";

describe("desktop primary auth", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    Reflect.deleteProperty(globalThis, "window");
  });

  it("reuses the main-process bearer token across renderer requests", async () => {
    const getLocalEnvironmentBearerToken = vi.fn().mockResolvedValue("desktop-bearer-token");
    window.desktopBridge = {
      getLocalEnvironmentBearerToken,
    } as unknown as DesktopBridge;

    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("desktop-bearer-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(1);
  });

  it("retries a failed pre-ready token request without caching its rejection", async () => {
    const getLocalEnvironmentBearerToken = vi
      .fn()
      .mockRejectedValueOnce(new Error("Local backend is still starting"))
      .mockResolvedValue("ready-token");
    window.desktopBridge = { getLocalEnvironmentBearerToken } as unknown as DesktopBridge;
    await expect(readDesktopPrimaryBearerToken()).rejects.toThrow(
      "Local backend is still starting",
    );
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("ready-token");
    await expect(readDesktopPrimaryBearerToken()).resolves.toBe("ready-token");
    expect(getLocalEnvironmentBearerToken).toHaveBeenCalledTimes(2);
  });

  it("does not require desktop auth in a browser", async () => {
    await expect(readDesktopPrimaryBearerToken()).resolves.toBeNull();
  });
});
