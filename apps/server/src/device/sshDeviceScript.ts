import { deviceSdkInventoryScript } from "./deviceSdkInventory.ts";
import { remoteDeviceLeaseScript } from "./remoteDeviceLease.ts";
import { deviceToolMaintenanceScript } from "./deviceToolMaintenance.ts";
import { AGENT_DEVICE_VERSION, DEVICE_HUB_VERSION } from "./DeviceToolchain.ts";

export const quoteRemoteArg = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

/** Resolve common non-interactive SDK and Node locations without sourcing user shell scripts. */
export const remoteDeviceEnvironment = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if [ -z "$ANDROID_HOME" ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk";
  elif [ -d "$HOME/Android/Sdk" ]; then export ANDROID_HOME="$HOME/Android/Sdk"; fi
fi
if [ -n "$ANDROID_HOME" ]; then export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"; fi
if [ -z "$JAVA_HOME" ] && ! command -v java >/dev/null 2>&1; then
  for device_java_home in "$HOME/.local/opt/android-studio/jbr" /opt/android-studio/jbr /Applications/Android\\ Studio.app/Contents/jbr "$HOME/Applications/Android Studio.app/Contents/jbr"; do
    if [ -x "$device_java_home/bin/java" ]; then export JAVA_HOME="$device_java_home"; break; fi
  done
fi
if [ -n "$JAVA_HOME" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
`;

/** Node runs this on the host. All paths it returns belong to that host. */
export const remoteDeviceScript = (
  owner: string,
  mode:
    | "probe"
    | "start"
    | "agent-start"
    | "restart-hub"
    | "restart-agent"
    | "restart-tools"
    | "stop-agent"
    | "stop"
    | "update-hub"
    | "update-agent"
    | "lease-acquire"
    | "lease-inspect",
  deviceKey?: string | ReadonlyArray<string>,
) =>
  `
const owner = ${JSON.stringify(owner)};
const mode = ${JSON.stringify(mode)};
const deviceKey = ${JSON.stringify(deviceKey ?? "")};
const hubVersion = ${JSON.stringify(DEVICE_HUB_VERSION)};
const agentVersion = ${JSON.stringify(AGENT_DEVICE_VERSION)};
` +
  deviceToolMaintenanceScript +
  deviceSdkInventoryScript +
  remoteDeviceLeaseScript +
  String.raw`
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const root = path.join(os.homedir(), '.pathway', 'device');
const state = path.join(root, 'hosts', owner);
const cacheRoot = process.env.PATHWAY_DEVICE_CACHE_DIR || path.join(os.homedir(), '.pathway', 'device-cache');
const run = (command, args, options = {}) => spawnSync(command, args, { encoding: 'utf8', timeout: 30000, ...options });
const read = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, value) => { const tmp = file + '.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 }); fs.renameSync(tmp, file); };
const toolVersions = (name, requiredVersion, entry, record) => {
  const directory = path.join(cacheRoot, 'tools', name);
  let names = [];
  try { names = fs.readdirSync(directory); } catch (error) { if (error.code !== 'ENOENT') return null; }
  let unreadable = false;
  const installedVersions = names.filter(version => {
    if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) return false;
    const dir = path.join(directory, version);
    try { return fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version && fs.existsSync(path.join(dir, 'node_modules', name, entry)); } catch (error) { if (error.code !== 'ENOENT') unreadable = true; return false; }
  }).sort();
  if (unreadable) return null;
  let runningVersion = null;
  if (record?.entryPath && record?.pid) {
    const command = run('ps', ['-p', String(record.pid), '-o', 'command=']).stdout || '';
    runningVersion = installedVersions.find(version => {
      const install = path.join(directory, version);
      return record.entryPath === path.join(install, 'node_modules', name, entry) && command.includes(install + path.sep);
    }) ?? null;
  }
  return { requiredVersion, installedVersions, runningVersion };
};
const versions = () => {
  const result = {
  hub: toolVersions('expo-device-hub', hubVersion, 'dist/server/cli.mjs', read(path.join(state, 'hub.json'))),
  agent: toolVersions('agent-device', agentVersion, 'bin/agent-device.mjs', { ...read(path.join(state, 'agent.json')), ...read(path.join(state, 'daemon.json')) }),
  };
  if (!result.hub || !result.agent) return undefined;
  return { ...result, serveSim: { requiredVersion: 'expo-device-hub@' + hubVersion, installedVersions: result.hub.installedVersions.map(version => 'expo-device-hub@' + version), runningVersion: result.hub.runningVersion ? 'expo-device-hub@' + result.hub.runningVersion : null } };
};
const stopHub = hub => {
  if (!hub || hub.owner !== owner) return;
  const command = run('ps', ['-p', String(hub.pid), '-o', 'command=']).stdout || '';
  if (command.includes(hub.entryPath) && command.includes(String(hub.port))) {
    try { process.kill(hub.pid, 'SIGTERM'); } catch {}
  }
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const healthy = async (port, route) => { try { return (await fetch('http://127.0.0.1:' + port + route, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; } };
const port = () => new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); }); });
async function acquireLock(lock, complete = () => false) {
  const deadline = Date.now() + 600000;
  const token = process.pid + ':' + require('node:crypto').randomUUID();
  const owner = () => { try { return fs.readlinkSync(lock); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  while (true) {
    try {
      // Publishing the PID and token is atomic; suspension cannot leave an incomplete owner.
      fs.symlinkSync(token, lock);
      return () => { if (owner() === token) fs.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (complete()) return null;
      const previous = owner();
      if (previous === null) continue;
      const pid = Number(previous.split(':')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('Invalid device lock at ' + lock);
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH' && owner() === previous) {
          try { fs.unlinkSync(lock); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          continue;
        }
      }
      if (Date.now() > deadline) throw Error('Device operation is locked at ' + lock + '. Check the other installer before removing the lock.');
      await sleep(500);
    }
  }
}
async function install(name, version, entry) {
  const tools = path.join(cacheRoot, 'tools');
  return withToolMaintenance(tools, async () => {
    const users = path.join(tools, '.users');
    fs.mkdirSync(users, { recursive: true });
    write(path.join(users, process.pid + '.' + name + '.' + version + '.json'), { pid: process.pid, identity: maintenanceIdentity(process.pid), name, version });
    const dir = path.join(tools, name, version);
    const file = path.join(dir, 'node_modules', name, entry);
    if (fs.existsSync(file) && fs.existsSync(path.join(dir, '.install-complete')) && fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim() === version) return file;
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const staging = fs.mkdtempSync(path.join(path.dirname(dir), '.install-'));
    try {
      const result = run('npm', ['install', '--prefix', staging, '--no-fund', '--no-audit', name + '@' + version], { timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
      if (result.status !== 0) throw Error('Installing ' + name + ' failed. Check npm on the device host.');
      if (!fs.existsSync(path.join(staging, 'node_modules', name, entry))) throw Error('Missing installed entry for ' + name);
      fs.writeFileSync(path.join(staging, '.install-complete'), version);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(staging, dir);
      return file;
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  });
}
(async () => {
  if (mode === 'lease-acquire' || mode === 'lease-inspect') {
    const result = await deviceLease(deviceKey, mode === 'lease-acquire');
    console.log(JSON.stringify(mode === 'lease-acquire' ? { owner: result } : { owners: result })); return;
  }
  if (mode === 'update-hub' || mode === 'update-agent') {
    if (mode === 'update-hub') await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
    else await install('agent-device', agentVersion, 'bin/agent-device.mjs');
    return;
  }
  const ios = process.platform === 'darwin' && run('xcrun', ['simctl', 'help']).status === 0;
  const android = run('adb', ['version']).status === 0;
  const platforms = [
    { platform: 'ios', available: ios, ...(!ios ? { reason: 'iOS needs macOS with Xcode and working xcrun simctl.' } : {}) },
    { platform: 'android', available: android, ...(!android ? { reason: 'Android SDK missing. Set ANDROID_HOME or put adb on the SSH PATH.' } : {}) },
  ];
  if (mode === 'probe') {
    if (Number(process.versions.node.split('.')[0]) < 22) throw Error('Node 22 or newer is required on the device host.');
    if (run('npm', ['--version']).status !== 0) throw Error('npm is missing from the non-interactive SSH PATH.');
    console.log(JSON.stringify({ nodePath: process.execPath, platforms, tools: versions(), sdkInventory: inspectDeviceSdks() })); return;
  }
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  // Serialize starts and stops for this environment/host owner, including agent startup.
  const hostLock = path.join(state, 'runtime.lock');
  const releaseHost = await acquireLock(hostLock);
  try {
  const hubFile = path.join(state, 'hub.json');
  const daemonFile = path.join(state, 'daemon.json');
  const agentFile = path.join(state, 'agent.json');
  if (mode === 'stop' || mode === 'stop-agent') {
    const hub = read(hubFile);
    if (mode === 'stop' && hub && hub.owner === owner) {
      stopHub(hub);
      fs.rmSync(hubFile, { force: true });
    }
    const entry = read(agentFile)?.entryPath || path.join(cacheRoot, 'tools', 'agent-device', agentVersion, 'node_modules', 'agent-device', 'bin', 'agent-device.mjs');
    if (fs.existsSync(entry)) run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]);
    return;
  }
  const restarting = mode.startsWith('restart-');
  const restartHub = mode === 'restart-hub' || mode === 'restart-tools';
  const restartAgent = mode === 'restart-agent' || mode === 'restart-tools';
  const hadAgent = !!read(daemonFile);
  const previousGuardian = read(path.join(state, 'lease-owner.json'));
  if (restarting) {
    if (!previousGuardian || !maintenanceAlive(previousGuardian.pid, previousGuardian.identity)) throw Error('The device connection ended. Reconnect before restarting tools.');
    // A surviving maintenance worker also retains ownership if its guardian crashes mid-restart.
    retainLeaseHelpers([{ pid: process.pid, identity: maintenanceIdentity(process.pid) }]);
    if (restartHub) {
      const previous = read(hubFile);
      const identity = previous?.pid ? maintenanceIdentity(previous.pid) : null;
      stopHub(previous);
      const deadline = Date.now() + 10000;
      while (previous?.pid && maintenanceAlive(previous.pid, identity)) {
        if (Date.now() >= deadline) throw Error('The old device hub is still running.');
        await sleep(25);
      }
      fs.rmSync(hubFile, { force: true });
    }
    if (restartAgent && hadAgent) {
      const previous = read(daemonFile);
      const identity = previous?.pid ? maintenanceIdentity(previous.pid) : null;
      const entry = read(agentFile)?.entryPath;
      if (!entry || run(process.execPath, [entry, 'daemon', 'stop', '--state-dir', state]).status !== 0) throw Error('Could not stop agent tools for restart.');
      const deadline = Date.now() + 10000;
      while (previous?.pid && maintenanceAlive(previous.pid, identity)) {
        if (Date.now() >= deadline) throw Error('The old agent daemon is still running.');
        await sleep(25);
      }
      fs.rmSync(daemonFile, { force: true });
    }
  }
  if (previousGuardian && !restarting) {
    const deadline = Date.now() + 10000;
    while (maintenanceAlive(previousGuardian.pid, previousGuardian.identity)) {
      if (Date.now() >= deadline) throw Error('The previous device connection is still closing. Retry shortly.');
      await sleep(25);
    }
  }
  if (!ios && !android) throw Error(platforms.map(p => p.reason).join(' '));
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const hubEntry = restarting && !restartHub ? read(hubFile)?.entryPath : await install('expo-device-hub', hubVersion, 'dist/server/cli.mjs');
  if (!hubEntry) throw Error('The device hub is not running.');
  let hub = read(hubFile);
  if ((!restarting || restartHub) && (!hub || hub.owner !== owner || hub.entryPath !== hubEntry || !await healthy(hub.port, '/readyz'))) {
    stopHub(hub);
    for (let attempt = 0; attempt < 5; attempt++) {
      const hubPort = await port();
      const log = fs.openSync(path.join(state, 'hub.log'), 'a');
      const child = spawn(process.execPath, [hubEntry, '--port', String(hubPort), '--host', '127.0.0.1', '--hide-sidebar', '--hide-boot-device'], {
        cwd: state, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      });
      try { await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); }
      finally { fs.closeSync(log); }
      child.unref();
      hub = { owner, pid: child.pid, identity: maintenanceIdentity(child.pid), port: hubPort, entryPath: hubEntry };
      write(hubFile, hub);
      if (restarting) retainLeaseHelpers();
      const deadline = Date.now() + 30000;
      let listening = false;
      while (child.exitCode === null && child.signalCode === null) {
        if (await healthy(hub.port, '/readyz')) { listening = true; break; }
        if (Date.now() > deadline) { stopHub(hub); throw Error('Device hub did not become ready. See ' + path.join(state, 'hub.log')); }
        await sleep(200);
      }
      if (listening) break;
      // Port reservation and binding happen in different processes. Retry an early exit with a fresh port.
      fs.rmSync(hubFile, { force: true });
      if (attempt === 4) throw Error('Device hub exited before becoming ready. See ' + path.join(state, 'hub.log'));
    }
  }
  let agentResult = {};
  if (mode === 'agent-start' || (restarting && hadAgent)) {
  const agentEntry = restarting && !restartAgent ? read(agentFile)?.entryPath : await install('agent-device', agentVersion, 'bin/agent-device.mjs');
  const previousAgent = read(agentFile)?.entryPath;
  let daemon = read(daemonFile);
  if ((!restarting || restartAgent) && daemon && (previousAgent !== agentEntry || !await healthy(daemon.httpPort, '/health'))) {
    const stopped = run(process.execPath, [previousAgent || agentEntry, 'daemon', 'stop', '--state-dir', state]);
    if (stopped.status !== 0) throw Error('Could not stop the previous agent-device version.');
    fs.rmSync(daemonFile, { force: true });
    daemon = null;
  }
  if (!daemon && (!restarting || restartAgent)) {
    fs.rmSync(daemonFile, { force: true });
    const env = { ...process.env, AGENT_DEVICE_STATE_DIR: state, AGENT_DEVICE_DAEMON_SERVER_MODE: 'http', AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0', AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1' };
    delete env.AGENT_DEVICE_DAEMON_BASE_URL; delete env.AGENT_DEVICE_DAEMON_AUTH_TOKEN; delete env.AGENT_DEVICE_CONFIG;
    run(process.execPath, [agentEntry, 'devices', '--json'], { env });
    daemon = read(daemonFile);
  }
  if (!daemon || !await healthy(daemon.httpPort, '/health')) throw Error('agent-device daemon did not become ready in ' + state);
  write(agentFile, { entryPath: agentEntry, pid: daemon.pid, identity: maintenanceIdentity(daemon.pid) });
  agentResult = { daemonPort: daemon.httpPort, token: daemon.token, entryPath: agentEntry };
  }
  const vendor = path.resolve(path.dirname(hubEntry), '../../vendor/serve-sim/dist');
  const optional = file => fs.existsSync(file) ? file : null;
  await pruneTools(path.join(cacheRoot, 'tools'), [['expo-device-hub', hubVersion], ...(mode === 'agent-start' ? [['agent-device', agentVersion]] : [])], false).catch(() => {});
  console.log(JSON.stringify({ nodePath: process.execPath, platforms, tools: versions(), hubPort: hub.port, ...agentResult,
    helpers: { serveSimAxSettings: optional(path.join(vendor, 'simax/serve-sim-ax-settings')), serveSimCli: optional(path.join(vendor, 'serve-sim.js')) } }));
  } finally { retainLeaseHelpers(); releaseHost(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
`;
