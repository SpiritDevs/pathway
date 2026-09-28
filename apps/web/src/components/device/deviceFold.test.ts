import type { DeviceHubAccess } from "@spiritdevs/client-runtime/state/deviceHubAccess";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readAndroidFold, setAndroidFold } from "./deviceFold";

const access: DeviceHubAccess = {
  httpBase: "https://env.example/api/device-hub",
  wsBase: "wss://env.example/api/device-hub",
  query: {},
  credentials: true,
};

const respond = (status: number, body: unknown) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(body), { status }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readAndroidFold", () => {
  it("reports no fold capability when the route is missing", async () => {
    respond(404, { error: "Not Found" });
    await expect(readAndroidFold(access, "emulator-5554")).resolves.toEqual({
      supported: false,
      posture: null,
      hingeAngle: null,
    });
  });

  it("still fails a fold command against a missing route", async () => {
    respond(404, { error: "Not Found" });
    await expect(setAndroidFold(access, "emulator-5554", "closed")).rejects.toThrow("Not Found");
  });
});
