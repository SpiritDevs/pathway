// @effect-diagnostics nodeBuiltinImport:off - runs the SSH-compatible probe against deterministic SDK fixtures.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { deviceSdkInventoryScript } from "./deviceSdkInventory.ts";

it("reports installed SDKs and available runtimes without starting a build", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-sdk-inventory-"));
  try {
    for (const file of [
      "platforms/android-36/android.jar",
      "system-images/android-36/google_apis/arm64-v8a/system.img",
    ]) {
      await NodeFSP.mkdir(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
      await NodeFSP.writeFile(NodePath.join(root, file), "fixture");
    }
    const script = `
Object.defineProperty(process, 'platform', { value: 'darwin' });
require('node:child_process').spawnSync = (command, args) => {
  if (command === 'xcodebuild') return { status: 0, stdout: args[0] === '-version' ? 'Xcode 26.0\\nBuild version fixture' : '-sdk iphonesimulator26.0\\n-sdk iphoneos26.0' };
  if (command === 'xcrun') return { status: 0, stdout: JSON.stringify({ runtimes: [
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-26-0', version: '26.0', isAvailable: true },
    { identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-0', version: '18.0', isAvailable: false }
  ] }) };
  throw Error('Unexpected command: ' + command);
};
${deviceSdkInventoryScript}
console.log(JSON.stringify(inspectDeviceSdks()));`;
    const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      ["-e", script],
      { env: { ...process.env, ANDROID_HOME: root } },
    );
    expect(JSON.parse(stdout)).toEqual({
      xcode: "26.0",
      sdks: [
        { platform: "android", version: "36" },
        { platform: "ios", version: "26.0" },
      ],
      runtimes: [
        { platform: "android", version: "36" },
        { platform: "ios", version: "26.0" },
      ],
      inspectionErrors: [],
    });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("marks failed probes unknown instead of claiming SDKs are missing", async () => {
  const script = `Object.defineProperty(process, 'platform', { value: 'darwin' });
require('node:child_process').spawnSync = () => ({ status: 1, stdout: '' });
${deviceSdkInventoryScript}
console.log(JSON.stringify(inspectDeviceSdks()));`;
  const { stdout } = await NodeUtil.promisify(NodeChildProcess.execFile)(
    process.execPath,
    ["-e", script],
    { env: { ...process.env, ANDROID_HOME: "/nonexistent-pathway-sdk-fixture" } },
  );
  expect(JSON.parse(stdout)).toEqual({
    xcode: null,
    sdks: [],
    runtimes: [],
    inspectionErrors: ["ios:runtime", "ios:sdk", "xcode"],
  });
});
