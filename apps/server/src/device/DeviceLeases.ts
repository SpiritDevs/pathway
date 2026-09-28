// @effect-diagnostics nodeBuiltinImport:off - cross-environment simulator leases are host files, independent of Pathway databases.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { DeviceOwnership } from "@spiritdevs/contracts";
import { isMachineOwnerAlive, machineOwner, withMachineLock } from "./deviceMachineLock.ts";

const Lease = Schema.Struct({
  ...DeviceOwnership.fields,
  pid: Schema.Int,
  identity: Schema.optional(Schema.String),
  instance: Schema.String,
  deviceId: Schema.String,
});
const decodeLease = Schema.decodeUnknownSync(Schema.fromJsonString(Lease));

/**
 * Leases last until the owning host stops or its server process dies. A paused
 * live process retains ownership, so it cannot wake up and control a new owner's device.
 * Closing a thread does not release a lease while its helper/socket can still use it.
 */
export function makeDeviceLeases(root: string, owner: DeviceOwnership) {
  const instance = NodeCrypto.randomUUID();
  const directory = NodePath.join(root, "leases");
  const fileFor = (deviceId: string) =>
    NodePath.join(
      directory,
      NodeCrypto.createHash("sha256").update(deviceId).digest("hex") + ".json",
    );
  const read = async (deviceId: string, alive = new Map<string, boolean>()) => {
    const value = await NodeFSP.readFile(fileFor(deviceId), "utf8")
      .then(decodeLease)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (!value) return null;
    const key = `${value.pid}:${value.identity}`;
    if (!alive.has(key)) alive.set(key, isMachineOwnerAlive(value));
    return alive.get(key) ? value : null;
  };
  const inspectMany = (deviceIds: ReadonlyArray<string>) =>
    withMachineLock(directory, async () => {
      const owners: Record<string, DeviceOwnership> = {};
      const alive = new Map<string, boolean>();
      for (const deviceId of deviceIds) {
        const value = await read(deviceId, alive);
        if (value && value.instance !== instance)
          owners[deviceId] = {
            environmentId: value.environmentId,
            environmentLabel: value.environmentLabel,
          };
      }
      return owners;
    });
  const inspect = async (deviceId: string) => (await inspectMany([deviceId]))[deviceId] ?? null;
  const acquire = (deviceId: string) =>
    withMachineLock(directory, async () => {
      const value = await read(deviceId);
      if (value && value.instance !== instance)
        return { environmentId: value.environmentId, environmentLabel: value.environmentLabel };
      const record = { ...owner, ...machineOwner(), instance, deviceId };
      const file = fileFor(deviceId);
      const temporary = file + "." + instance;
      await NodeFSP.writeFile(temporary, JSON.stringify(record));
      await NodeFSP.rename(temporary, file);
      return null;
    });
  const releaseAll = () =>
    withMachineLock(directory, async () => {
      for (const name of await NodeFSP.readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = NodePath.join(directory, name);
        const value = await NodeFSP.readFile(file, "utf8").then(decodeLease);
        if (value.instance === instance) await NodeFSP.unlink(file);
      }
    });
  return { acquire, inspect, inspectMany, releaseAll };
}
