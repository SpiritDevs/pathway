import { tvInputBuildSource } from "./tvInputBuild.ts";
import { simulatorInputBoundarySource } from "./simulatorInputBoundary.ts";
import { tvInputNativeSource } from "./tvInputNative.ts";
import { tvInputBridgeSource } from "./tvInputBridge.ts";

/** Applied only to a staged expo-device-hub@0.12.0 install, on local and SSH hosts. */
export const DEVICE_HUB_UPSTREAM_VERSION = "0.12.0";

// Kept as plain Node source so an SSH host applies exactly the same patch before publishing its install.
export const deviceHubPatchScript =
  `const pathwayTvBuild = ${JSON.stringify(tvInputBuildSource)};\nconst pathwayInputBoundary = ${JSON.stringify(simulatorInputBoundarySource)};\nconst pathwayTvNative = ${JSON.stringify(tvInputNativeSource)};\nconst pathwayTvBridge = ${JSON.stringify(tvInputBridgeSource)};\n` +
  String.raw`
function patchDeviceHub(root) {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const files = [
    ['dist/server/index.mjs', '1cdba1c07d8d6e66c97aef700f4372d8bcae34ba0160b1059f62b20d123e1266'],
    ['vendor/serve-sim/dist/middleware.js', '2c82e875e1cf33b0ec98dd2d6e25271e487d9bc6e162b1c4d86e647bc82dcd9c'],
    ['vendor/serve-sim/dist/serve-sim.js', 'd30d6f03320a98682d988df5231aaedd177e44d7867fe8b856ea4a7af34de24e'],
  ];
  const replace = (text, from, to) => {
    if (text.split(from).length !== 2) throw Error('Device hub patch anchor changed: ' + from);
    return text.replace(from, to);
  };
  const staged = files.map(([file, expected]) => {
    const source = fs.readFileSync(path.join(root, file));
    if (crypto.createHash('sha256').update(source).digest('hex') !== expected) throw Error('Device hub patch checksum mismatch: ' + file);
    let text = source.toString('utf8');
    if (file === 'dist/server/index.mjs') {
      text = replace(text, 'device.platform === "iOS" && device.isAvailable', '["iOS", "watchOS", "tvOS"].includes(device.platform) && device.isAvailable');
      text = replace(text, '}).filter((device) => device.lastUsedAt !== undefined),', '}),');
      text = replace(text, 'name: device.name || "Simulator",', 'name: device.name || "Simulator", family: device.platform === "watchOS" ? "watch" : device.platform === "tvOS" ? "tv" : /\\.iPad-/i.test(device.deviceTypeIdentifier || "") ? "pad" : "phone",');
    } else {
      text = replace(text, 'SimRuntime\\.(iOS|watchOS|visionOS|xrOS)-', 'SimRuntime\\.(iOS|watchOS|tvOS|visionOS|xrOS)-');
      const signature = file.endsWith('middleware.js') ? 'async handleHidMessage($,v){' : 'async handleHidMessage($,U){';
      const socket = file.endsWith('middleware.js') ? 'v' : 'U';
      const handler = 'this.pathwayInput??=createPathwaySimulatorInput(this);return this.pathwayInput.handle($,'+socket+', (data,ws)=>this.pathwayLegacyHidMessage(data,ws));}async pathwayLegacyHidMessage($,'+socket+'){' ;
      text = replace(text, signature, signature + handler);
      text = replace(text, 'this.phase="stopped"', 'this.pathwayInput?.close();this.pathwayTvInput?.close();this.phase="stopped"');
      const inputImport = 'import { createPathwaySimulatorInput } from "./pathway-simulator-input.mjs";\n';
      text = text.startsWith('#!') ? text.replace('\n', '\n' + inputImport) : inputImport + text;
    }
    return [file, text];
  });
  const native = fs.readFileSync(path.join(root, 'vendor/serve-sim/dist/native/serve-sim-native.node'));
  if (crypto.createHash('sha256').update(native).digest('hex') !== '27732f7fbc01c1fdd97f1b850d072cb4b57991e3177fde084a1e6e6c0b061628') throw Error('Device hub patch checksum mismatch: native addon');
  const nativeSource = path.join(root, 'vendor/serve-sim/dist/native/pathway-tv-input.m');
  fs.writeFileSync(nativeSource, pathwayTvNative);
  fs.writeFileSync(path.join(root, 'vendor/serve-sim/dist/pathway-simulator-input.mjs'), pathwayInputBoundary);
  fs.writeFileSync(path.join(root, 'vendor/serve-sim/dist/pathway-tv-input.mjs'), pathwayTvBridge);
  fs.writeFileSync(path.join(root, 'vendor/serve-sim/dist/pathway-tv-build.mjs'), pathwayTvBuild);
  fs.writeFileSync(path.join(root, 'vendor/serve-sim/dist/native/pathway-tv-input.json'), JSON.stringify({ status: 'notBuilt' }));
  for (const [file, text] of staged) fs.writeFileSync(path.join(root, file), text);
}
`;
