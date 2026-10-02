import { describe, expect, it } from "@effect/vitest";

import {
  canInstallAndroidSdk,
  javaMajorFromRelease,
  planAndroidSdkInstall,
} from "./androidSdkInstall.ts";

const target = { apiLevel: "36", arch: "arm64" };

describe("planAndroidSdkInstall", () => {
  it("installs everything, then one virtual device, on a machine without an SDK", () => {
    expect(
      planAndroidSdkInstall(
        { adb: false, emulator: false, avdmanager: false, avdCount: 0 },
        target,
      ),
    ).toEqual({
      commandLineTools: true,
      packages: ["platform-tools", "emulator", "system-images;android-36;google_apis;arm64-v8a"],
      avd: {
        name: "Pixel_9_API_36",
        systemImage: "system-images;android-36;google_apis;arm64-v8a",
        device: "pixel_9",
      },
    });
  });

  it("only adds Command-line Tools to an Android Studio SDK that already has devices", () => {
    expect(
      planAndroidSdkInstall({ adb: true, emulator: true, avdmanager: false, avdCount: 2 }, target),
    ).toEqual({ commandLineTools: true, packages: [], avd: null });
  });

  it("creates a virtual device with an x86_64 image on Intel hosts", () => {
    const plan = planAndroidSdkInstall(
      { adb: true, emulator: true, avdmanager: true, avdCount: 0 },
      { apiLevel: "36", arch: "x64" },
    );
    expect(plan.packages).toEqual(["system-images;android-36;google_apis;x86_64"]);
    expect(plan.avd?.systemImage).toBe("system-images;android-36;google_apis;x86_64");
  });

  it("has nothing to do once the emulator path is complete", () => {
    expect(
      planAndroidSdkInstall({ adb: true, emulator: true, avdmanager: true, avdCount: 1 }, target),
    ).toEqual({ commandLineTools: false, packages: [], avd: null });
  });
});

describe("javaMajorFromRelease", () => {
  it("reads modern and legacy version strings", () => {
    expect(javaMajorFromRelease('IMPLEMENTOR="Amazon"\nJAVA_VERSION="18.0.2"\n')).toBe(18);
    expect(javaMajorFromRelease('JAVA_VERSION="21"')).toBe(21);
    expect(javaMajorFromRelease('JAVA_VERSION="1.8.0_402"')).toBe(8);
    expect(javaMajorFromRelease("IMPLEMENTOR=nobody")).toBeNull();
  });
});

describe("canInstallAndroidSdk", () => {
  it("supports macOS and x64 Linux, where Google ships the emulator", () => {
    expect(canInstallAndroidSdk("darwin", "arm64")).toBe(true);
    expect(canInstallAndroidSdk("darwin", "x64")).toBe(true);
    expect(canInstallAndroidSdk("linux", "x64")).toBe(true);
    expect(canInstallAndroidSdk("linux", "arm64")).toBe(false);
    expect(canInstallAndroidSdk("win32", "x64")).toBe(false);
  });
});
