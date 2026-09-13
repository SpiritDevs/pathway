#!/usr/bin/env node
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const hostPlatform = HostProcessPlatform.defaultValue();
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const source = NodePath.join(root, "native/dictation/engines");
const build = NodePath.join(root, "native/dictation/build");
const options = process.argv.slice(2);
if (options.includes("--help")) {
  console.log(
    "node scripts/build-dictation-engines.mjs [--cpu|--gpu] [--speech|--cleanup] [-- CMake configure arguments]",
  );
  console.log(
    "Requires CMake >=3.24 and a C++17 compiler. Mac defaults to Metal; Windows defaults to CPU. Windows --gpu requires the Vulkan SDK.",
  );
  process.exit(0);
}
if (hostPlatform !== "darwin" && hostPlatform !== "win32")
  throw new Error("Build dictation engines on macOS or Windows.");
const divider = options.indexOf("--");
const extra = divider < 0 ? [] : options.slice(divider + 1);
const flags = divider < 0 ? options : options.slice(0, divider);
for (const option of flags)
  if (!["--cpu", "--gpu", "--speech", "--cleanup"].includes(option))
    throw new Error(`Unknown option: ${option}`);
if (flags.includes("--cpu") && flags.includes("--gpu"))
  throw new Error("Choose either --cpu or --gpu.");
const gpu = flags.includes("--gpu") || (hostPlatform === "darwin" && !flags.includes("--cpu"));
const engines = flags.includes("--speech")
  ? ["speech"]
  : flags.includes("--cleanup")
    ? ["cleanup"]
    : ["speech", "cleanup"];
function cmake(args) {
  const result = NodeChildProcess.spawnSync(process.env.PATHWAY_CMAKE ?? "cmake", args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const engine of engines) {
  const directory = NodePath.join(build, `${engine}-${gpu ? "gpu" : "cpu"}`);
  cmake([
    "-S",
    source,
    "-B",
    directory,
    `-DPATHWAY_ENGINE=${engine}`,
    `-DPATHWAY_ENGINE_GPU=${gpu ? "ON" : "OFF"}`,
    `-DPATHWAY_ENGINE_OUTPUT=${NodePath.join(directory, "bin")}`,
    "-DCMAKE_BUILD_TYPE=Release",
    ...(hostPlatform === "darwin"
      ? ["-DCMAKE_OSX_ARCHITECTURES=arm64", "-DCMAKE_OSX_DEPLOYMENT_TARGET=14.0"]
      : ["-A", "x64"]),
    ...extra,
  ]);
  cmake([
    "--build",
    directory,
    "--config",
    "Release",
    "--target",
    `pathway-${engine}-engine`,
    "--parallel",
    String(Math.min(NodeOS.availableParallelism(), 8)),
  ]);
  await NodeFSP.cp(NodePath.join(directory, "bin"), NodePath.join(build, "engines"), {
    recursive: true,
  });
}
console.log(`Dictation engines and notices: ${NodePath.join(build, "engines")}`);
