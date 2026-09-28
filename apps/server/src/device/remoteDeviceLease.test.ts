// @effect-diagnostics nodeBuiltinImport:off - exercise SSH channel EOF with real child processes and no SSH server.
import { expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeUtil from "node:util";
import { remoteDeviceGuardian } from "./remoteDeviceLease.ts";
import { remoteDeviceScript } from "./sshDeviceScript.ts";
import { makeDeviceLeases } from "./DeviceLeases.ts";

it("shares SSH and local leases and expires ownership after channel EOF stops captured helpers", async () => {
  const home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-remote-lease-"));
  const state = NodePath.join(home, ".pathway/device/hosts/test");
  await NodeFSP.mkdir(state, { recursive: true });
  const helper = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "process.stdin.resume();console.log('ready');"],
    {
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  await NodeEvents.EventEmitter.once(helper.stdout, "data");
  await NodeFSP.writeFile(NodePath.join(state, "hub.json"), JSON.stringify({ pid: helper.pid }));
  const owner = { environmentId: "ssh", environmentLabel: "Remote environment" };
  const guardian = NodeChildProcess.spawn(
    process.execPath,
    ["-e", remoteDeviceGuardian("test", owner)],
    {
      env: { ...process.env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  try {
    await NodeEvents.EventEmitter.once(guardian.stdout, "data");
    const result = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      ["-e", remoteDeviceScript("test", "lease-acquire", "ios:phone")],
      { env: { ...process.env, HOME: home } },
    );
    expect(JSON.parse(result.stdout)).toEqual({ owner: null });
    const inspected = await NodeUtil.promisify(NodeChildProcess.execFile)(
      process.execPath,
      ["-e", remoteDeviceScript("other", "lease-inspect", ["ios:phone", "ios:free"])],
      { env: { ...process.env, HOME: home } },
    );
    expect(JSON.parse(inspected.stdout)).toEqual({ owners: { "ios:phone": owner } });
    const local = makeDeviceLeases(NodePath.join(home, ".pathway/device-cache"), {
      environmentId: "local",
      environmentLabel: "Local environment",
    });
    expect(await local.acquire("ios:phone")).toEqual(owner);
    const helperExit = NodeEvents.EventEmitter.once(helper, "exit");
    const guardianExit = NodeEvents.EventEmitter.once(guardian, "exit");
    guardian.stdin.end();
    await Promise.all([helperExit, guardianExit]);
    expect(await local.acquire("ios:phone")).toBeNull();
  } finally {
    for (const child of [guardian, helper])
      if (child.exitCode === null && child.signalCode === null) {
        const exited = NodeEvents.EventEmitter.once(child, "exit");
        child.kill();
        await exited;
      }
    await NodeFSP.rm(home, { recursive: true, force: true });
  }
});
