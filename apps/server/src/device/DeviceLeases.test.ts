// @effect-diagnostics nodeBuiltinImport:off - exercise real filesystem contention and process death.
import { afterEach, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeEvents from "node:events";
import { makeDeviceLeases } from "./DeviceLeases.ts";
import { withMachineLock } from "./deviceMachineLock.ts";

const directories: string[] = [];
const temporary = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pathway-device-leases-"));
  directories.push(directory);
  return directory;
};
afterEach(async () => {
  for (const dir of directories.splice(0)) await NodeFSP.rm(dir, { recursive: true, force: true });
});
const alice = { environmentId: "alice", environmentLabel: "Alice's Mac" };
const bob = { environmentId: "bob", environmentLabel: "Bob's environment" };

it("keeps a simulator exclusive across environments and releases only its own leases", async () => {
  const root = await temporary();
  const a = makeDeviceLeases(root, alice);
  const b = makeDeviceLeases(root, bob);
  const results = await Promise.all([a.acquire("ios:phone"), b.acquire("ios:phone")]);
  expect(results.filter((value) => value === null)).toHaveLength(1);
  const winner = results[0] === null ? a : b;
  const loser = winner === a ? b : a;
  const owner = winner === a ? alice : bob;
  expect(await loser.inspect("ios:phone")).toEqual(owner);
  await loser.releaseAll();
  expect(await loser.acquire("ios:phone")).toEqual(owner);
  await winner.releaseAll();
  expect(await loser.acquire("ios:phone")).toBeNull();
});

it("expires a lease when the owner process dies without running cleanup", async () => {
  const root = await temporary();
  const script = NodePath.join(root, "owner.mjs");
  await NodeFSP.writeFile(
    script,
    `import { makeDeviceLeases } from ${JSON.stringify(new URL("./DeviceLeases.ts", import.meta.url).href)};
const lease = makeDeviceLeases(${JSON.stringify(root)}, ${JSON.stringify(alice)});
await lease.acquire('ios:phone');
process.send('acquired');
process.on('message', () => {});`,
  );
  const child = NodeChildProcess.fork(script, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: [],
  });
  try {
    await NodeEvents.EventEmitter.once(child, "message");
    const b = makeDeviceLeases(root, bob);
    expect(await b.acquire("ios:phone")).toEqual(alice);
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    expect(await b.acquire("ios:phone")).toBeNull();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = NodeEvents.EventEmitter.once(child, "exit");
      child.kill();
      await exited;
    }
  }
});

it("reclaims a reused PID and a dead maintenance owner without unlinking a new owner", async () => {
  const root = await temporary();
  const lock = NodePath.join(root, ".maintenance-lock");
  await NodeFSP.mkdir(lock);
  await NodeFSP.writeFile(
    NodePath.join(lock, "stale.json"),
    JSON.stringify({ pid: process.pid, identity: "previous-process-start" }),
  );
  await withMachineLock(root, async () => {
    expect((await NodeFSP.readdir(lock)).length).toBe(1);
  });
  expect(await NodeFSP.readdir(root)).toEqual([]);
});

it("serializes asynchronous critical sections across independent processes", async () => {
  const root = await temporary();
  const script = NodePath.join(root, "contend.mjs");
  await NodeFSP.writeFile(
    script,
    `import * as NodeFSP from 'node:fs/promises';
import { withMachineLock } from ${JSON.stringify(new URL("./deviceMachineLock.ts", import.meta.url).href)};
const root = ${JSON.stringify(root)};
for (let i = 0; i < 4; i++) await withMachineLock(root, async () => {
  await NodeFSP.writeFile(root + '/critical', String(process.pid), { flag: 'wx' });
  await NodeFSP.writeFile(root + '/work', 'data'.repeat(20000));
  if (await NodeFSP.readFile(root + '/critical', 'utf8') !== String(process.pid)) throw Error('overlap');
  await NodeFSP.unlink(root + '/critical');
});`,
  );
  await Promise.all(
    Array.from({ length: 4 }, () =>
      NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [script]),
    ),
  );
  await expect(NodeFSP.stat(NodePath.join(root, ".maintenance-lock"))).rejects.toThrow();
});

it("retains a dead owner's surviving helper and distinguishes instances sharing its PID", async () => {
  const root = await temporary();
  const helper = NodeChildProcess.spawn(
    process.execPath,
    ["-e", "process.stdin.resume();console.log('ready');"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  await NodeEvents.EventEmitter.once(helper.stdout, "data");
  const script = NodePath.join(root, "owner-with-helper.mjs");
  await NodeFSP.writeFile(
    script,
    `
import { makeDeviceLeases } from ${JSON.stringify(new URL("./DeviceLeases.ts", import.meta.url).href)};
const one = makeDeviceLeases(${JSON.stringify(root)}, ${JSON.stringify(alice)});
const two = makeDeviceLeases(${JSON.stringify(root)}, ${JSON.stringify(alice)});
await one.acquire('ios:free-after-crash');
await two.acquire('ios:still-streaming');
await two.retainHelpers([${helper.pid}]);
process.send('acquired');
process.on('message', () => {});
`,
  );
  const child = NodeChildProcess.fork(script, [], {
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    execArgv: [],
  });
  try {
    await NodeEvents.EventEmitter.once(child, "message");
    const exited = NodeEvents.EventEmitter.once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const contender = makeDeviceLeases(root, bob);
    expect(await contender.inspectMany(["ios:free-after-crash", "ios:still-streaming"])).toEqual({
      "ios:still-streaming": alice,
    });
    expect(await contender.acquire("ios:still-streaming")).toEqual(alice);
    const helperExited = NodeEvents.EventEmitter.once(helper, "exit");
    helper.kill();
    await helperExited;
    expect(await contender.acquire("ios:still-streaming")).toBeNull();
  } finally {
    for (const process of [child, helper])
      if (process.exitCode === null && process.signalCode === null) {
        const exited = NodeEvents.EventEmitter.once(process, "exit");
        process.kill();
        await exited;
      }
  }
});
