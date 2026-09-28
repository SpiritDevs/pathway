// @effect-diagnostics preferSchemaOverJson:off - literal inputs are escaped into a standalone SSH script.
import type { DeviceOwnership } from "@spiritdevs/contracts";
import { deviceToolMaintenanceScript } from "./deviceToolMaintenance.ts";

/** Shares the local lease format and lock, including when SSH and local environments meet. */
export const remoteDeviceLeaseScript = String.raw`
function retainLeaseHelpers(extra = []) {
  const file = path.join(state, 'lease-owner.json');
  const current = read(file);
  if (!current) return;
  const captured = [read(path.join(state, 'hub.json')), { ...read(path.join(state, 'agent.json')), ...read(path.join(state, 'daemon.json')) }]
    .filter(value => Number.isSafeInteger(value?.pid) && value.pid > 0)
    .map(value => ({ pid: value.pid, identity: value.identity || current.helpers?.find(helper => helper.pid === value.pid)?.identity || maintenanceIdentity(value.pid) }));
  const helpers = [...(current.helpers || []).filter(value => maintenanceAlive(value.pid, value.identity)), ...extra, ...captured];
  write(file, { ...current, helpers: [...new Map(helpers.map(value => [value.pid + ':' + value.identity, value])).values()] });
}

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
        const relinquished = previous.relinquished === true;
        const identity = relinquished ? previous.instance + ':relinquished:' + previous.deviceId : previous.instance + ':' + previous.pid + ':' + previous.identity;
        if (!alive.has(identity)) {
          let latest = previous;
          if (!relinquished && previous.ownerFile) {
            let currentOwner;
            try { currentOwner = JSON.parse(fs.readFileSync(previous.ownerFile, 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            if (currentOwner?.instance === previous.instance) latest = currentOwner;
          }
          alive.set(identity, (!relinquished && maintenanceAlive(latest.pid, latest.identity)) || [...(previous.helpers || []), ...(latest.helpers || [])].some(helper => maintenanceAlive(helper.pid, helper.identity)));
        }
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
const file = path.join(state, 'lease-owner.json');
const previous = read(file);
const record = { ...${JSON.stringify(environment)}, pid: process.pid, identity: maintenanceIdentity(process.pid), instance: previous?.instance || require('node:crypto').randomUUID(), ownerFile: file };
// These PIDs came from this environment's helper startup, never from a process-name search.
const helpers = [read(path.join(state, 'hub.json')), { ...read(path.join(state, 'agent.json')), ...read(path.join(state, 'daemon.json')) }].filter(value => Number.isSafeInteger(value?.pid) && value.pid > 0).map(value => ({ pid: value.pid, identity: value.identity || previous?.helpers?.find(helper => helper.pid === value.pid)?.identity || maintenanceIdentity(value.pid) }));
record.helpers = [...(previous?.helpers || []).filter(value => maintenanceAlive(value.pid, value.identity)), ...helpers];
fs.writeFileSync(file, JSON.stringify(record));
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const helpers = read(file)?.helpers || record.helpers;
  for (const helper of helpers) if (maintenanceAlive(helper.pid, helper.identity)) {
    try { process.kill(helper.pid, 'SIGTERM'); } catch {}
  }
  for (let attempt = 0; attempt < 100 && helpers.some(helper => maintenanceAlive(helper.pid, helper.identity)); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  for (const helper of helpers) if (maintenanceAlive(helper.pid, helper.identity)) {
    try { process.kill(helper.pid, 'SIGKILL'); } catch {}
  }
  // Retain the last helper identities so SIGKILL and slow exits cannot free leases early.
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
