// This file mostly exists because we want dev mode to say "Pathway (Dev)" instead of "electron"

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
export const desktopDir = NodePath.resolve(__dirname, "..");
const repoRoot = NodePath.resolve(desktopDir, "..", "..");
const devBundleIdSuffix = NodePath.basename(repoRoot)
  .toLowerCase()
  .replaceAll(/[^a-z0-9]+/g, "");
export const APP_DISPLAY_NAME = isDevelopment ? "Pathway (Dev)" : "Pathway (Alpha)";
export const APP_BUNDLE_ID = isDevelopment
  ? `com.spiritdevs.pathway.dev.${devBundleIdSuffix || "local"}`
  : "com.spiritdevs.pathway";
const APP_PROTOCOL_SCHEMES = isDevelopment ? ["pathway-dev"] : ["pathway"];
const LAUNCHER_VERSION = 17;
const defaultIconPath = NodePath.join(desktopDir, "resources", "icon.icns");
const developmentMacIconPngPath = NodePath.join(
  repoRoot,
  "assets",
  "dev",
  "blueprint-macos-1024.png",
);
// oxlint-disable-next-line pathway/no-global-process-runtime -- Standalone launcher script has no Effect runtime.
const hostPlatform = NodeOS.platform();

function setPlistString(plistPath, key, value) {
  const replaceResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-string", value, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function setPlistJson(plistPath, key, value) {
  const serialized = JSON.stringify(value);
  const replaceResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-replace", key, "-json", serialized, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (replaceResult.status === 0) {
    return;
  }

  const insertResult = NodeChildProcess.spawnSync(
    "plutil",
    ["-insert", key, "-json", serialized, plistPath],
    {
      encoding: "utf8",
    },
  );
  if (insertResult.status === 0) {
    return;
  }

  const details = [replaceResult.stderr, insertResult.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to update plist key "${key}" at ${plistPath}: ${details}`.trim());
}

function runChecked(command, args) {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8" });
  if (result.status === 0) {
    return;
  }

  const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
  throw new Error(`Failed to run ${command} ${args.join(" ")}: ${details}`.trim());
}

export function resolveMacCodeSignArguments(appBundlePath, entitlementsPath) {
  return [
    "--force",
    "--deep",
    "--sign",
    "-",
    "--timestamp=none",
    "--entitlements",
    entitlementsPath,
    appBundlePath,
  ];
}

function signMacLauncherBundle(appBundlePath) {
  const entitlementsPath = NodePath.join(NodePath.dirname(appBundlePath), "entitlements.plist");
  NodeFS.writeFileSync(entitlementsPath, makeMacDevelopmentEntitlements());
  runChecked("codesign", resolveMacCodeSignArguments(appBundlePath, entitlementsPath));
}

export function makeMacDevelopmentEntitlements() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.device.audio-input</key><true/>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <key>com.apple.security.cs.disable-library-validation</key><true/>
</dict></plist>
`;
}

export function makeDevelopmentEnvironmentDefaults(environment) {
  const envEntries = [
    ["VITE_DEV_SERVER_URL", environment.VITE_DEV_SERVER_URL],
    ["PATHWAY_PORT", environment.PATHWAY_PORT],
    ["PATHWAY_HOME", environment.PATHWAY_HOME],
    ["PATHWAY_COMMIT_HASH", environment.PATHWAY_COMMIT_HASH],
    ["PATHWAY_OTLP_TRACES_URL", environment.PATHWAY_OTLP_TRACES_URL],
    ["PATHWAY_OTLP_EXPORT_INTERVAL_MS", environment.PATHWAY_OTLP_EXPORT_INTERVAL_MS],
    ["PATHWAY_DESKTOP_APP_USER_MODEL_ID", APP_BUNDLE_ID],
    ["PATHWAY_DESKTOP_PROTOCOL_REGISTRATION_MANAGED", "1"],
  ].filter((entry) => typeof entry[1] === "string" && entry[1].trim().length > 0);
  return Object.fromEntries(envEntries);
}

export function makeDevelopmentBootstrap({ mainEntryPath, desktopRoot, environmentFilePath }) {
  return [
    '"use strict";',
    'const fs = require("node:fs");',
    'const { app } = require("electron");',
    `const defaults = JSON.parse(fs.readFileSync(${JSON.stringify(environmentFilePath)}, "utf8"));`,
    "for (const [name, value] of Object.entries(defaults)) {",
    "  if (!process.env[name]) process.env[name] = value;",
    "}",
    `app.setAppPath(${JSON.stringify(NodePath.dirname(mainEntryPath))});`,
    // Keep CLI switches and protocol URLs intact. The normal dev runner supplies
    // switches only; LaunchServices can start this app with no arguments.
    `process.argv.splice(1, 0, ${JSON.stringify(`--pathway-dev-root=${desktopRoot}`)}, ${JSON.stringify(mainEntryPath)});`,
    `require(${JSON.stringify(mainEntryPath)});`,
    "",
  ].join("\n");
}

const developmentEnvironmentFilePath = NodePath.join(
  desktopDir,
  ".electron-runtime",
  "dev-environment.json",
);

function writeDevelopmentEnvironmentDefaults() {
  NodeFS.mkdirSync(NodePath.dirname(developmentEnvironmentFilePath), { recursive: true });
  NodeFS.writeFileSync(
    developmentEnvironmentFilePath,
    `${JSON.stringify(makeDevelopmentEnvironmentDefaults(process.env), null, 2)}\n`,
  );
}

function writeIfChanged(path, content) {
  if (NodeFS.existsSync(path) && NodeFS.readFileSync(path, "utf8") === content) {
    return false;
  }
  NodeFS.writeFileSync(path, content);
  return true;
}

export function writeDevelopmentBootstrap(
  appBundlePath,
  {
    mainEntryPath = NodePath.join(desktopDir, "dist-electron", "main.cjs"),
    desktopRoot = desktopDir,
    environmentFilePath = developmentEnvironmentFilePath,
  } = {},
) {
  const appDirectory = NodePath.join(appBundlePath, "Contents", "Resources", "app");
  NodeFS.mkdirSync(appDirectory, { recursive: true });
  const packageChanged = writeIfChanged(
    NodePath.join(appDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: APP_BUNDLE_ID,
        productName: APP_DISPLAY_NAME,
        version: readJson(NodePath.join(desktopDir, "package.json")).version,
        main: "index.cjs",
      },
      null,
      2,
    )}\n`,
  );
  const bootstrapChanged = writeIfChanged(
    NodePath.join(appDirectory, "index.cjs"),
    makeDevelopmentBootstrap({
      mainEntryPath: NodePath.resolve(mainEntryPath),
      desktopRoot,
      environmentFilePath,
    }),
  );
  return packageChanged || bootstrapChanged;
}

function registerMacLauncherBundle(appBundlePath) {
  runChecked(
    "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
    ["-f", appBundlePath],
  );

  if (!isDevelopment) {
    return;
  }

  for (const scheme of APP_PROTOCOL_SCHEMES) {
    runChecked("osascript", [
      "-l",
      "JavaScript",
      "-e",
      [
        'ObjC.import("CoreServices");',
        `const scheme = $.NSString.alloc.initWithUTF8String(${JSON.stringify(scheme)});`,
        `const bundle = $.NSString.alloc.initWithUTF8String(${JSON.stringify(APP_BUNDLE_ID)});`,
        "const status = $.LSSetDefaultHandlerForURLScheme(scheme, bundle);",
        "if (status !== 0) throw new Error(`LSSetDefaultHandlerForURLScheme failed: ${status}`);",
      ].join(" "),
    ]);
  }
}

function ensureDevelopmentIconIcns(runtimeDir) {
  const generatedIconPath = NodePath.join(runtimeDir, "icon-dev.icns");
  NodeFS.mkdirSync(runtimeDir, { recursive: true });

  if (!NodeFS.existsSync(developmentMacIconPngPath)) {
    return defaultIconPath;
  }

  const sourceMtimeMs = NodeFS.statSync(developmentMacIconPngPath).mtimeMs;
  if (
    NodeFS.existsSync(generatedIconPath) &&
    NodeFS.statSync(generatedIconPath).mtimeMs >= sourceMtimeMs
  ) {
    return generatedIconPath;
  }

  const iconsetRoot = NodeFS.mkdtempSync(NodePath.join(runtimeDir, "dev-iconset-"));
  const iconsetDir = NodePath.join(iconsetRoot, "icon.iconset");
  NodeFS.mkdirSync(iconsetDir, { recursive: true });

  try {
    for (const size of [16, 32, 128, 256, 512]) {
      runChecked("sips", [
        "-z",
        String(size),
        String(size),
        developmentMacIconPngPath,
        "--out",
        NodePath.join(iconsetDir, `icon_${size}x${size}.png`),
      ]);

      const retinaSize = size * 2;
      runChecked("sips", [
        "-z",
        String(retinaSize),
        String(retinaSize),
        developmentMacIconPngPath,
        "--out",
        NodePath.join(iconsetDir, `icon_${size}x${size}@2x.png`),
      ]);
    }

    runChecked("iconutil", ["-c", "icns", iconsetDir, "-o", generatedIconPath]);
    return generatedIconPath;
  } catch (error) {
    console.warn(
      "[desktop-launcher] Failed to generate dev macOS icon, falling back to default icon.",
      error,
    );
    return defaultIconPath;
  } finally {
    NodeFS.rmSync(iconsetRoot, { recursive: true, force: true });
  }
}

export function resolveMacBundleInfoPlistStrings(executableName) {
  return {
    CFBundleDisplayName: APP_DISPLAY_NAME,
    CFBundleName: APP_DISPLAY_NAME,
    CFBundleIdentifier: APP_BUNDLE_ID,
    CFBundleExecutable: executableName,
    CFBundleIconFile: "icon.icns",
    NSMicrophoneUsageDescription:
      "Pathway records your voice when you start dictation. Audio is processed on this computer.",
    NSScreenCaptureUsageDescription:
      "Pathway captures the active window when you use the snapshot shortcut.",
    NSDocumentsFolderUsageDescription: "Pathway reads project files you open in the desktop app.",
  };
}

function patchMainBundleInfoPlist(appBundlePath, iconPath, executableName) {
  const infoPlistPath = NodePath.join(appBundlePath, "Contents", "Info.plist");
  for (const [key, value] of Object.entries(resolveMacBundleInfoPlistStrings(executableName))) {
    setPlistString(infoPlistPath, key, value);
  }
  setPlistJson(infoPlistPath, "CFBundleURLTypes", [
    {
      CFBundleURLName: APP_BUNDLE_ID,
      CFBundleURLSchemes: APP_PROTOCOL_SCHEMES,
    },
  ]);

  const resourcesDir = NodePath.join(appBundlePath, "Contents", "Resources");
  NodeFS.copyFileSync(iconPath, NodePath.join(resourcesDir, "icon.icns"));
  NodeFS.copyFileSync(iconPath, NodePath.join(resourcesDir, "electron.icns"));
}

function patchHelperBundleInfoPlists(appBundlePath) {
  const helperBundleNames = [
    ["Electron Helper.app", "helper", `${APP_DISPLAY_NAME} Helper`],
    ["Electron Helper (GPU).app", "helper.gpu", `${APP_DISPLAY_NAME} Helper (GPU)`],
    ["Electron Helper (Plugin).app", "helper.plugin", `${APP_DISPLAY_NAME} Helper (Plugin)`],
    ["Electron Helper (Renderer).app", "helper.renderer", `${APP_DISPLAY_NAME} Helper (Renderer)`],
  ];

  for (const [bundleName, bundleIdentifierSuffix, bundleDisplayName] of helperBundleNames) {
    const infoPlistPath = NodePath.join(
      appBundlePath,
      "Contents",
      "Frameworks",
      bundleName,
      "Contents",
      "Info.plist",
    );
    if (!NodeFS.existsSync(infoPlistPath)) {
      continue;
    }

    setPlistString(infoPlistPath, "CFBundleDisplayName", bundleDisplayName);
    setPlistString(infoPlistPath, "CFBundleName", bundleDisplayName);
    setPlistString(
      infoPlistPath,
      "CFBundleIdentifier",
      `${APP_BUNDLE_ID}.${bundleIdentifierSuffix}`,
    );
  }
}

function readJson(path) {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function resolveMacLauncherPaths(appBundlePath) {
  const executableDir = NodePath.join(appBundlePath, "Contents", "MacOS");
  const launcherExecutableName = "Electron";
  return {
    launcherExecutableName,
    launcherBinaryPath: NodePath.join(executableDir, launcherExecutableName),
    runtimeElectronBinaryPath: NodePath.join(executableDir, "Electron"),
  };
}

function readPlist(path) {
  const result = NodeChildProcess.spawnSync("plutil", ["-convert", "json", "-o", "-", path], {
    encoding: "utf8",
  });
  return result.status === 0 ? JSON.parse(result.stdout) : null;
}

export function canReuseMacRuntime({ hasRuntime, existingPlist, sourcePlist, appBundleId }) {
  return (
    hasRuntime &&
    existingPlist?.CFBundleIdentifier === appBundleId &&
    typeof sourcePlist?.CFBundleVersion === "string" &&
    existingPlist.CFBundleVersion === sourcePlist.CFBundleVersion
  );
}

export function buildMacLauncher(electronBinaryPath, options = {}) {
  const sourceAppBundlePath = NodePath.resolve(NodePath.dirname(electronBinaryPath), "../..");
  const runtimeDir = NodePath.join(desktopDir, ".electron-runtime");
  const targetAppBundlePath = NodePath.join(runtimeDir, `${APP_DISPLAY_NAME}.app`);
  const developmentPaths = resolveMacLauncherPaths(targetAppBundlePath);
  const runtimeElectronBinaryPath = developmentPaths.runtimeElectronBinaryPath;
  const launcherBinaryPath = runtimeElectronBinaryPath;
  const iconPath = isDevelopment ? ensureDevelopmentIconIcns(runtimeDir) : defaultIconPath;
  const metadataPath = NodePath.join(runtimeDir, "metadata.json");

  NodeFS.mkdirSync(runtimeDir, { recursive: true });

  const expectedMetadata = {
    launcherVersion: LAUNCHER_VERSION,
    sourceAppBundlePath,
    sourceAppMtimeMs: NodeFS.statSync(sourceAppBundlePath).mtimeMs,
    iconMtimeMs: NodeFS.statSync(iconPath).mtimeMs,
    appBundleId: APP_BUNDLE_ID,
    appProtocolSchemes: APP_PROTOCOL_SCHEMES,
  };

  // A launcher, icon, or environment change must not recopy the runtime. Besides
  // avoiding a large copy, this preserves repairs to framework symlinks in an
  // existing worktree bundle, even when its launcher metadata has been removed.
  const reuseRuntime = canReuseMacRuntime({
    hasRuntime: NodeFS.existsSync(runtimeElectronBinaryPath),
    existingPlist: readPlist(NodePath.join(targetAppBundlePath, "Contents", "Info.plist")),
    sourcePlist: readPlist(NodePath.join(sourceAppBundlePath, "Contents", "Info.plist")),
    appBundleId: APP_BUNDLE_ID,
  });
  if (!reuseRuntime) {
    if (sourceAppBundlePath === targetAppBundlePath) {
      throw new Error(
        "Cannot replace the runtime bundle with itself; provide the Electron source runtime.",
      );
    }
    NodeFS.rmSync(targetAppBundlePath, { recursive: true, force: true });
    // Preserve framework links relative to this bundle, not node_modules.
    NodeFS.cpSync(sourceAppBundlePath, targetAppBundlePath, {
      recursive: true,
      verbatimSymlinks: true,
    });
  }

  const currentMetadata = readJson(metadataPath);
  let needsSigning =
    !reuseRuntime || JSON.stringify(currentMetadata) !== JSON.stringify(expectedMetadata);
  if (needsSigning) {
    patchMainBundleInfoPlist(targetAppBundlePath, iconPath, "Electron");
    patchHelperBundleInfoPlists(targetAppBundlePath);
    NodeFS.rmSync(
      NodePath.join(targetAppBundlePath, "Contents", "MacOS", `${APP_DISPLAY_NAME} Launcher`),
      { force: true },
    );
  }
  if (isDevelopment) {
    // TCC needs a native bundle entry. Electron loads Resources/app itself on
    // LaunchServices launches; volatile defaults stay outside the signed bundle.
    writeDevelopmentEnvironmentDefaults();
    needsSigning = writeDevelopmentBootstrap(targetAppBundlePath, options) || needsSigning;
  }
  if (needsSigning) {
    signMacLauncherBundle(targetAppBundlePath);
    NodeFS.writeFileSync(metadataPath, `${JSON.stringify(expectedMetadata, null, 2)}\n`);
  }
  registerMacLauncherBundle(targetAppBundlePath);

  return launcherBinaryPath;
}

function isLinuxSetuidSandboxConfigured(electronBinaryPath) {
  if (hostPlatform !== "linux") {
    return true;
  }

  const sandboxPath = NodePath.join(NodePath.dirname(electronBinaryPath), "chrome-sandbox");
  try {
    const sandboxStat = NodeFS.statSync(sandboxPath);
    return sandboxStat.uid === 0 && (sandboxStat.mode & 0o4777) === 0o4755;
  } catch {
    return false;
  }
}

function resolveLinuxSandboxArgs(electronBinaryPath) {
  if (isLinuxSetuidSandboxConfigured(electronBinaryPath)) {
    return [];
  }

  console.warn(
    "[desktop-launcher] Electron chrome-sandbox is not root-owned with mode 4755; launching local Electron with --no-sandbox.",
  );
  return ["--no-sandbox"];
}

export function resolveElectronPath(options = {}) {
  const electronBinaryPath = resolveElectronBinaryPath();

  if (hostPlatform !== "darwin") {
    return electronBinaryPath;
  }

  return buildMacLauncher(electronBinaryPath, options);
}

export function resolveElectronLaunchCommand(args = [], options = {}) {
  const electronPath = resolveElectronPath(options);
  return {
    electronPath,
    args: [...resolveLinuxSandboxArgs(electronPath), ...args],
  };
}

export function resolveElectronBinaryPath({
  ensureRuntime = ensureElectronRuntime,
  createRequire = NodeModule.createRequire,
  moduleUrl = import.meta.url,
} = {}) {
  ensureRuntime();

  const require = createRequire(moduleUrl);
  return require("electron");
}

export function resolveDevProtocolClient(options = {}) {
  if (hostPlatform !== "darwin" || !isDevelopment) {
    return null;
  }

  const electronBinaryPath = resolveElectronBinaryPath();
  const launcherBinaryPath = buildMacLauncher(electronBinaryPath, options);
  return {
    appBundlePath: NodePath.resolve(launcherBinaryPath, "..", "..", ".."),
    appBundleId: APP_BUNDLE_ID,
  };
}
