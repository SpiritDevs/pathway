// @effect-diagnostics nodeBuiltinImport:off - cross-environment simulator leases are host files, independent of Pathway databases.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import { DeviceOwnership } from "@spiritdevs/contracts";
import {
  isMachineOwnerAlive,
  machineOwner,
  processIdentity,
  withMachineLock,
} from "./deviceMachineLock.ts";

const Helper = Schema.Struct({ pid: Schema.Int, identity: Schema.optional(Schema.String) });
const LeaseOwner = Schema.Struct({
  ...DeviceOwnership.fields,
  ...Helper.fields,
  instance: Schema.String,
  helpers: Schema.optional(Schema.Array(Helper)),
  ownerFile: Schema.optional(Schema.String),
});
const decodeLeaseOwner = Schema.decodeUnknownSync(Schema.fromJsonString(LeaseOwner));
const Lease = Schema.Struct({
  ...LeaseOwner.fields,
  deviceId: Schema.String,
});
const decodeLease = Schema.decodeUnknownSync(Schema.fromJsonString(Lease));

/**
 * Leases last until the owning host stops or its server and recorded helper processes die. A paused
 * live process retains ownership, so it cannot wake up and control a new owner's device.
 * Closing a thread does not release a lease while its helper/socket can still use it.
 */
export function makeDeviceLeases(root: string, owner: DeviceOwnership) {
  const instance = NodeCrypto.randomUUID();
  let helpers: ReadonlyArray<typeof Helper.Type> = [];
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
    const key = `${value.instance}:${value.pid}:${value.identity}`;
    if (!alive.has(key)) {
      const current = value.ownerFile
        ? await NodeFSP.readFile(value.ownerFile, "utf8")
            .then(decodeLeaseOwner)
            .catch((error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return null;
              throw error;
            })
        : null;
      const latest = current?.instance === value.instance ? current : value;
      alive.set(
        key,
        isMachineOwnerAlive(latest) ||
          [...(value.helpers ?? []), ...(latest.helpers ?? [])].some(isMachineOwnerAlive),
      );
    }
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
      const record = { ...owner, ...machineOwner(), instance, deviceId, helpers };
      const file = fileFor(deviceId);
      const temporary = file + "." + instance;
      await NodeFSP.writeFile(temporary, JSON.stringify(record));
      await NodeFSP.rename(temporary, file);
      return null;
    });
  // Keep old helper identities until they exit, including helpers replaced during restart.
  const retainHelpers = (pids: ReadonlyArray<number>) =>
    withMachineLock(directory, async () => {
      helpers = [
        ...helpers.filter(isMachineOwnerAlive),
        ...pids.map((pid) => ({ pid, identity: processIdentity(pid) ?? "unknown" })),
      ];
      helpers = [
        ...new Map(helpers.map((helper) => [`${helper.pid}:${helper.identity}`, helper])).values(),
      ];
      for (const name of await NodeFSP.readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = NodePath.join(directory, name);
        const value = await NodeFSP.readFile(file, "utf8").then(decodeLease);
        if (value.instance !== instance) continue;
        const temporary = file + "." + instance;
        await NodeFSP.writeFile(temporary, JSON.stringify({ ...value, helpers }));
        await NodeFSP.rename(temporary, file);
      }
    });
  const releaseAll = () =>
    withMachineLock(directory, async () => {
      for (const name of await NodeFSP.readdir(directory)) {
        if (!name.endsWith(".json")) continue;
        const file = NodePath.join(directory, name);
        const value = await NodeFSP.readFile(file, "utf8").then(decodeLease);
        if (value.instance === instance && !(value.helpers ?? []).some(isMachineOwnerAlive))
          await NodeFSP.unlink(file);
      }
    });
  return { acquire, inspect, inspectMany, releaseAll, retainHelpers };
}
