// @effect-diagnostics preferSchemaOverJson:off - JSON string literals embed paths safely into generated JavaScript.
/**
 * A directory holding an `agent-device` launcher that runs the pinned install
 * with a Node runtime. Prepended to provider subprocess PATHs so the agent
 * types `agent-device …` and gets the version the injected instructions were
 * written for, regardless of what is or is not globally installed.
 */
import { HostProcessPlatform } from "@spiritdevs/shared/hostProcess";
import { resolveNodeExecutable } from "./nodeRuntime.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

const SHIM_DIR = "device/bin";

export const ensureAgentDeviceShim = Effect.fn("AgentDeviceShim.ensure")(function* (input: {
  readonly entryPath: string;
  readonly stateDir: string;
}) {
  const { entryPath } = input;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const node = yield* resolveNodeExecutable("Device automation");
  const shimDir = path.join(input.stateDir, SHIM_DIR);
  yield* fs.makeDirectory(shimDir, { recursive: true });
  const launcherPath = path.join(shimDir, "agent-device-launcher.mjs");
  yield* fs.writeFileString(
    launcherPath,
    `import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
const informational = args.length === 1 && ["help", "--help", "-h", "--version", "version"].includes(args[0]);
const hasValue = flag => { const index = args.indexOf(flag); return index >= 0 && !!args[index + 1] && !args[index + 1].startsWith("--"); };
if (!informational && !(hasValue("--config") && hasValue("--session"))) {
  console.error("Call device_open first and include its --config and --session flags.");
  process.exit(1);
}
if (!informational) {
  try {
    const flags = ["--config", "--session", "--platform", "--udid", "--serial"];
    for (const flag of flags) if (args.filter(arg => arg === flag).length > 1 || args.some(arg => arg.startsWith(flag + "="))) throw Error("Ambiguous target flags");
    const value = flag => args[args.indexOf(flag) + 1];
    const session = value("--session");
    if (!/^pathway-[a-f0-9]{24}$/.test(session)) throw Error("Unknown session");
    const grant = JSON.parse(fs.readFileSync(path.join(${JSON.stringify(input.stateDir)}, "device", "targets", session + ".json"), "utf8"));
    process.kill(grant.serverPid, 0);
    if (grant.serverIdentity !== "unknown") {
      const identity = execFileSync("ps", ["-p", String(grant.serverPid), "-o", "lstart="], { encoding: "utf8", timeout: 5000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
      if (identity !== grant.serverIdentity) throw Error("Owning server changed");
    }
    const selector = grant.platform === "ios" ? "--udid" : "--serial";
    const other = grant.platform === "ios" ? "--serial" : "--udid";
    if (!hasValue(selector) || value(selector) !== grant.deviceId || !hasValue("--platform") || value("--platform") !== grant.platform || args.includes(other) || args.some(arg => /^(--device|--all)(=|$)/.test(arg))) throw Error("Target differs from device_open");
    if (value("--config") !== grant.configPath || fs.readFileSync(grant.configPath, "utf8") !== grant.endpoint) throw Error("Device connection changed");
  } catch {
    console.error("Device ownership or target changed. Call device_open again and use its exact target flags.");
    process.exit(1);
  }
}
const env = { ...process.env };
delete env.AGENT_DEVICE_DAEMON_BASE_URL;
delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN;
delete env.AGENT_DEVICE_CONFIG;
const child = spawn(${JSON.stringify(node)}, [${JSON.stringify(entryPath)}, ...args], { stdio: "inherit", env });
child.on("error", error => { console.error(error.message); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`,
  );
  if (platform === "win32") {
    const script = `@echo off\r\n"${node}" "${launcherPath}" %*\r\n`;
    yield* fs.writeFileString(path.join(shimDir, "agent-device.cmd"), script);
  } else {
    const command = [node, launcherPath]
      .map((value) => "'" + value.replaceAll("'", "'\"'\"'") + "'")
      .join(" ");
    const script = `#!/bin/sh\nexec ${command} "$@"\n`;
    const shimPath = path.join(shimDir, "agent-device");
    yield* fs.writeFileString(shimPath, script);
    yield* fs.chmod(shimPath, 0o755);
  }
  return shimDir;
});
