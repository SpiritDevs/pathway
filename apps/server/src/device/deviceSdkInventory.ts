// @effect-diagnostics preferSchemaOverJson:off - standalone Node script also runs over SSH.
import { DeviceSdkInventory } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";

/** Read installed SDKs without executing project files or starting a simulator. */
export const deviceSdkInventoryScript = String.raw`
function inspectDeviceSdks() {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  const spawn = require('node:child_process').spawnSync;
  const inventory = { xcode: null, sdks: [], runtimes: [], inspectionErrors: [] };
  const run = (command, args) => spawn(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 });
  if (process.platform === 'darwin') {
    const xcode = run('xcodebuild', ['-version']);
    inventory.xcode = /^Xcode\s+(\S+)/m.exec(xcode.stdout || '')?.[1] ?? null;
    if (xcode.status !== 0) inventory.inspectionErrors.push('xcode');
    const sdks = run('xcodebuild', ['-showsdks']);
    if (sdks.status !== 0) inventory.inspectionErrors.push('ios:sdk');
    else for (const match of sdks.stdout.matchAll(/-sdk\s+iphonesimulator([0-9.]+)/g)) inventory.sdks.push({ platform: 'ios', version: match[1] });
    const runtimes = run('xcrun', ['simctl', 'list', 'runtimes', '--json']);
    try {
      if (runtimes.status !== 0) throw Error('runtime probe failed');
      const parsed = JSON.parse(runtimes.stdout);
      if (!Array.isArray(parsed.runtimes)) throw Error('invalid runtimes');
      for (const value of parsed.runtimes) if (value.isAvailable && typeof value.version === 'string' && value.identifier?.includes('.iOS-')) inventory.runtimes.push({ platform: 'ios', version: value.version });
    } catch { inventory.inspectionErrors.push('ios:runtime'); }
  }
  const home = os.homedir();
  const explicit = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const candidates = explicit ? [explicit] : [path.join(home, 'Library/Android/sdk'), path.join(home, 'Android/Sdk'), path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Android/Sdk')];
  const sdk = candidates.find(value => fs.existsSync(value));
  const directories = (directory, error) => {
    try { return fs.readdirSync(directory, { withFileTypes: true }).filter(value => value.isDirectory()).map(value => value.name); }
    catch (cause) { if (cause.code !== 'ENOENT') inventory.inspectionErrors.push(error); return []; }
  };
  if (sdk) {
    for (const name of directories(path.join(sdk, 'platforms'), 'android:sdk')) {
      if (/^android-\d+$/.test(name) && fs.existsSync(path.join(sdk, 'platforms', name, 'android.jar'))) inventory.sdks.push({ platform: 'android', version: name.slice(8) });
    }
    for (const name of directories(path.join(sdk, 'system-images'), 'android:runtime')) {
      if (!/^android-\d+$/.test(name)) continue;
      const directory = path.join(sdk, 'system-images', name);
      const installed = directories(directory, 'android:runtime').some(tag => directories(path.join(directory, tag), 'android:runtime').some(arch => fs.existsSync(path.join(directory, tag, arch, 'system.img'))));
      if (installed) inventory.runtimes.push({ platform: 'android', version: name.slice(8) });
    }
  }
  for (const key of ['sdks', 'runtimes']) inventory[key] = [...new Map(inventory[key].map(value => [value.platform + ':' + value.version, value])).values()].sort((a, b) => (a.platform + a.version).localeCompare(b.platform + b.version));
  inventory.inspectionErrors = [...new Set(inventory.inspectionErrors)].sort();
  return inventory;
}
`;

const decodeInventory = Schema.decodeUnknownEffect(Schema.fromJsonString(DeviceSdkInventory));

export const inspectLocalDeviceSdks = Effect.fn("DeviceSdkInventory.inspect")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner.run({
    command: process.execPath,
    args: ["-e", deviceSdkInventoryScript + "\nconsole.log(JSON.stringify(inspectDeviceSdks()));"],
    timeout: "60 seconds",
  });
  return yield* decodeInventory(result.stdout);
});
