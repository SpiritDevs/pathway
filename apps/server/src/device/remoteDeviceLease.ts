// @effect-diagnostics preferSchemaOverJson:off - literal inputs are escaped into a standalone SSH script.
import type { DeviceOwnership } from "@spiritdevs/contracts";
import { deviceToolMaintenanceScript } from "./deviceToolMaintenance.ts";

/** Shares the local lease format and lock, including when SSH and local environments meet. */
export const remoteDeviceLeaseScript = String.raw`
async function deviceLease(keys, acquire) {
  const directory = path.join(cacheRoot, 'leases');
  return withToolMaintenance(directory, async () => {
    const current = read(path.join(state, 'lease-owner.json'));
    const owners = {};
    const alive = new Map();
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const file = path.join(directory, require('node:crypto').createHash('sha256').update(key).digest('hex') + '.json');
      let previous;
      try { previous = JSON.parse(fs.readFileSync(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (previous) {
        const identity = previous.pid + ':' + previous.identity;
        if (!alive.has(identity)) alive.set(identity, maintenanceAlive(previous.pid, previous.identity));
        if (alive.get(identity) && previous.instance !== current?.instance) {
          owners[key] = { environmentId: previous.environmentId, environmentLabel: previous.environmentLabel };
          continue;
        }
      }
      if (acquire) {
        if (!current || !maintenanceAlive(current.pid, current.identity)) throw Error('Device host connection ended. Reconnect before controlling a simulator.');
        write(file, { ...current, deviceId: key });
      }
    }
    return acquire ? owners[keys] ?? null : owners;
  });
}
`;

/** The SSH channel owns this process. EOF stops its captured helpers before its leases expire. */
export function remoteDeviceGuardian(owner: string, environment: DeviceOwnership) {
  return (
    deviceToolMaintenanceScript +
    `
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(require('node:os').homedir(), '.pathway', 'device');
const state = path.join(root, 'hosts', ${JSON.stringify(owner)});
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const record = { ...${JSON.stringify(environment)}, pid: process.pid, identity: maintenanceIdentity(process.pid), instance: require('node:crypto').randomUUID() };
const file = path.join(state, 'lease-owner.json');
fs.writeFileSync(file, JSON.stringify(record));
// These PIDs came from this environment's helper startup, never from a process-name search.
const helpers = [read(path.join(state, 'hub.json')), read(path.join(state, 'daemon.json'))].filter(value => Number.isSafeInteger(value?.pid) && value.pid > 0).map(value => ({ pid: value.pid, identity: maintenanceIdentity(value.pid) }));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const helper of helpers) if (maintenanceAlive(helper.pid, helper.identity)) {
    try { process.kill(helper.pid, 'SIGTERM'); } catch {}
  }
  for (let attempt = 0; attempt < 100 && helpers.some(helper => maintenanceAlive(helper.pid, helper.identity)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const helper of helpers) if (maintenanceAlive(helper.pid, helper.identity)) {
    try { process.kill(helper.pid, 'SIGKILL'); } catch {}
  }
  if (read(file)?.instance === record.instance) fs.rmSync(file, { force: true });
  process.exit(0);
};
process.stdin.resume();
process.stdin.on('end', stop);
process.on('SIGHUP', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
console.log('ready');
`
  );
}
