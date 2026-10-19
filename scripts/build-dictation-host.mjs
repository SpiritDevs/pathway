#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";

// oxlint-disable-next-line pathway/no-global-process-runtime -- Standalone native build has no Effect runtime.
const hostPlatform = NodeOS.platform();
// oxlint-disable-next-line pathway/no-global-process-runtime -- Standalone native build has no Effect runtime.
const hostArchitecture = NodeOS.arch();

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const source = NodePath.join(root, "native/dictation/host");
const output = NodePath.join(root, "native/dictation/build/host");
NodeFS.mkdirSync(output, { recursive: true });
function run(program, args) {
  const result = NodeChildProcess.spawnSync(program, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (hostPlatform === "darwin" && hostArchitecture === "arm64") {
  const swift = NodePath.join(source, "macos");
  const binary = NodePath.join(output, "pathway-dictation-host");
  run("xcrun", [
    "swiftc",
    "-swift-version",
    "5",
    "-O",
    "-target",
    "arm64-apple-macos14.0",
    ...NodeFS.readdirSync(swift)
      .filter((name) => name.endsWith(".swift"))
      .sort()
      .map((name) => NodePath.join(swift, name)),
    "-framework",
    "AppKit",
    "-framework",
    "AVFoundation",
    "-framework",
    "AudioToolbox",
    "-framework",
    "CoreAudio",
    "-framework",
    "ApplicationServices",
    "-Xlinker",
    "-sectcreate",
    "-Xlinker",
    "__TEXT",
    "-Xlinker",
    "__info_plist",
    "-Xlinker",
    NodePath.join(swift, "Info.plist"),
    "-o",
    binary,
  ]);
  // A stable local identity supports macOS permission grants. Release packaging re-signs this executable.
  run("codesign", [
    "--force",
    "--sign",
    "-",
    "--identifier",
    "com.spiritdevs.pathway.dictation-host",
    binary,
  ]);
  if (process.argv.includes("--test")) run(binary, ["--self-test"]);
} else if (hostPlatform === "win32" && hostArchitecture === "x64") {
  // Run in an x64 Native Tools Command Prompt for VS 2022 with Windows 10/11 SDK and C++/WinRT.
  const binary = NodePath.join(output, "pathway-dictation-host.exe");
  run("cl.exe", [
    "/nologo",
    "/std:c++20",
    "/Zc:__cplusplus",
    "/D_WIN32_WINNT=0x0A00",
    "/DWINVER=0x0A00",
    "/EHsc",
    "/O2",
    "/W4",
    "/DUNICODE",
    "/D_UNICODE",
    "/DWIN32_LEAN_AND_MEAN",
    "/DNOMINMAX",
    NodePath.join(source, "windows/main.cpp"),
    `/Fo${NodePath.join(output, "host.obj")}`,
    `/Fe${binary}`,
    "/link",
    "ole32.lib",
    "oleaut32.lib",
    "uuid.lib",
    "user32.lib",
    "gdi32.lib",
    "advapi32.lib",
    "shell32.lib",
    "windowsapp.lib",
    "propsys.lib",
    "wtsapi32.lib",
    "/SUBSYSTEM:CONSOLE",
  ]);
  if (process.argv.includes("--test")) run(binary, ["--self-test"]);
} else {
  throw new Error("Dictation host builds require Apple Silicon macOS or Windows x64.");
}
