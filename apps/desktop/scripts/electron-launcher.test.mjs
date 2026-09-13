import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { assert, describe, it } from "vite-plus/test";

import {
  canReuseMacRuntime,
  makeDevelopmentBootstrap,
  makeDevelopmentEnvironmentDefaults,
  makeMacDevelopmentEntitlements,
  resolveElectronBinaryPath,
  resolveMacBundleInfoPlistStrings,
  resolveMacCodeSignArguments,
  resolveMacLauncherPaths,
  writeDevelopmentBootstrap,
} from "./electron-launcher.mjs";

const bootstrapOptions = {
  mainEntryPath: "/repo/apps/desktop/dist-electron/main.cjs",
  desktopRoot: "/repo/apps/desktop",
  environmentFilePath: "/repo/apps/desktop/.electron-runtime/dev-environment.json",
};

function executeBootstrap({ env = {}, args = [], options = bootstrapOptions } = {}) {
  const defaults = makeDevelopmentEnvironmentDefaults({
    VITE_DEV_SERVER_URL: "http://127.0.0.1:8526",
    PATHWAY_PORT: "16566",
    PATHWAY_HOME: "/tmp/pathway's `$HOME`\nprofile",
    UNRELATED_SECRET: "must not persist",
  });
  const childProcess = { env: { ...env }, argv: ["/runtime/Electron", ...args] };
  const calls = [];
  const source = makeDevelopmentBootstrap(options);
  NodeVM.runInNewContext(source, {
    process: childProcess,
    require: (specifier) => {
      if (specifier === "node:fs") {
        return {
          readFileSync: (path) => {
            assert.equal(path, options.environmentFilePath);
            return JSON.stringify(defaults);
          },
        };
      }
      if (specifier === "electron") {
        return { app: { setAppPath: (path) => calls.push(["appPath", path]) } };
      }
      calls.push(["main", specifier, { ...childProcess.env }]);
      return {};
    },
  });
  return { childProcess, calls, source };
}

describe("electron development launcher", () => {
  it("boots the real main entry with defaults when LaunchServices supplies no environment or arguments", () => {
    const { childProcess, calls } = executeBootstrap();
    assert.equal(childProcess.env.VITE_DEV_SERVER_URL, "http://127.0.0.1:8526");
    assert.equal(childProcess.env.PATHWAY_HOME, "/tmp/pathway's `$HOME`\nprofile");
    assert.equal(childProcess.env.PATHWAY_DESKTOP_PROTOCOL_REGISTRATION_MANAGED, "1");
    assert.notProperty(childProcess.env, "UNRELATED_SECRET");
    assert.deepEqual(calls[0], ["appPath", "/repo/apps/desktop/dist-electron"]);
    assert.deepEqual(calls[1], ["main", bootstrapOptions.mainEntryPath, childProcess.env]);
    assert.lengthOf(calls, 2);
    assert.deepEqual(childProcess.argv, [
      "/runtime/Electron",
      "--pathway-dev-root=/repo/apps/desktop",
      bootstrapOptions.mainEntryPath,
    ]);
  });

  it("preserves the live runner environment, debug switches, and protocol URLs", () => {
    const args = ["--remote-debugging-port=9744", "pathway-dev://callback?code=example"];
    const { childProcess, calls } = executeBootstrap({
      env: { VITE_DEV_SERVER_URL: "http://localhost:9000", PATHWAY_HOME: "/tmp/live-profile" },
      args,
    });
    assert.equal(childProcess.env.VITE_DEV_SERVER_URL, "http://localhost:9000");
    assert.equal(calls[1][2].PATHWAY_HOME, "/tmp/live-profile");
    assert.deepEqual(childProcess.argv.slice(3), args);
  });

  it("loads an explicitly prepared isolated test wrapper once", () => {
    const options = { ...bootstrapOptions, mainEntryPath: "/tmp/isolated 'profile'/entry.cjs" };
    const { calls } = executeBootstrap({ options });
    assert.equal(calls[1][1], options.mainEntryPath);
    assert.lengthOf(
      calls.filter(([kind]) => kind === "main"),
      1,
    );
  });

  it("repairs Electron before loading the package entrypoint", () => {
    const calls = [];
    const electronPath = resolveElectronBinaryPath({
      ensureRuntime: () => calls.push("ensure"),
      createRequire: () => (specifier) => {
        calls.push(`require:${specifier}`);
        return "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron";
      },
      moduleUrl: import.meta.url,
    });
    assert.equal(
      electronPath,
      "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    );
    assert.deepEqual(calls, ["ensure", "require:electron"]);
  });

  it("uses the native Electron executable as the bundle and CLI entry", () => {
    const paths = resolveMacLauncherPaths("/runtime/Pathway (Dev).app");
    assert.equal(paths.launcherExecutableName, "Electron");
    assert.equal(paths.launcherBinaryPath, "/runtime/Pathway (Dev).app/Contents/MacOS/Electron");
    assert.equal(paths.launcherBinaryPath, paths.runtimeElectronBinaryPath);
    assert.equal(
      resolveMacBundleInfoPlistStrings(paths.launcherExecutableName).CFBundleExecutable,
      "Electron",
    );
  });

  it("declares protected access and signs the app with microphone and Electron entitlements", () => {
    const values = resolveMacBundleInfoPlistStrings("Electron");
    assert.include(values.NSMicrophoneUsageDescription, "dictation");
    assert.include(values.NSScreenCaptureUsageDescription, "snapshot");
    assert.include(values.NSDocumentsFolderUsageDescription, "project files");
    assert.deepEqual(
      resolveMacCodeSignArguments("/runtime/Pathway (Dev).app", "/runtime/entitlements.plist"),
      [
        "--force",
        "--deep",
        "--sign",
        "-",
        "--timestamp=none",
        "--entitlements",
        "/runtime/entitlements.plist",
        "/runtime/Pathway (Dev).app",
      ],
    );
    assert.include(
      makeMacDevelopmentEntitlements(),
      "<key>com.apple.security.device.audio-input</key><true/>",
    );
    assert.include(
      makeMacDevelopmentEntitlements(),
      "<key>com.apple.security.cs.allow-jit</key><true/>",
    );
  });

  it("keeps existing runtime repairs across launcher migrations and missing metadata", () => {
    const input = {
      hasRuntime: true,
      existingPlist: {
        CFBundleIdentifier: "com.pathway.dev.test",
        CFBundleVersion: "41.5.0",
        CFBundleExecutable: "Old Shell Launcher",
      },
      sourcePlist: { CFBundleVersion: "41.5.0" },
      appBundleId: "com.pathway.dev.test",
    };
    assert.isTrue(canReuseMacRuntime(input));
    assert.isFalse(canReuseMacRuntime({ ...input, sourcePlist: { CFBundleVersion: "42.0.0" } }));
    assert.isFalse(canReuseMacRuntime({ ...input, appBundleId: "com.pathway.dev.other" }));
    assert.isFalse(canReuseMacRuntime({ ...input, hasRuntime: false }));
    assert.isFalse(canReuseMacRuntime({ ...input, existingPlist: null }));
  });

  it("updates the signed bootstrap only when its code changes and leaves framework repairs intact", () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pathway-launcher-"));
    try {
      const framework = NodePath.join(directory, "Contents", "Frameworks", "repaired");
      NodeFS.mkdirSync(NodePath.dirname(framework), { recursive: true });
      NodeFS.symlinkSync("Versions/Current", framework);
      assert.isTrue(writeDevelopmentBootstrap(directory, bootstrapOptions));
      const bootstrapPath = NodePath.join(directory, "Contents", "Resources", "app", "index.cjs");
      const stat = NodeFS.statSync(bootstrapPath);
      assert.isFalse(writeDevelopmentBootstrap(directory, bootstrapOptions));
      assert.equal(NodeFS.statSync(bootstrapPath).mtimeMs, stat.mtimeMs);
      const packageJson = JSON.parse(
        NodeFS.readFileSync(NodePath.join(NodePath.dirname(bootstrapPath), "package.json"), "utf8"),
      );
      assert.equal(packageJson.main, "index.cjs");
      assert.isTrue(
        writeDevelopmentBootstrap(directory, {
          ...bootstrapOptions,
          mainEntryPath: "/tmp/wrapper.cjs",
        }),
      );
      assert.include(NodeFS.readFileSync(bootstrapPath, "utf8"), 'require("/tmp/wrapper.cjs")');
      assert.equal(NodeFS.readlinkSync(framework), "Versions/Current");
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});
