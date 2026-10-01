import { tvInputNativeSource } from "./tvInputNative.ts";
import { tvInputBridgeSource } from "./tvInputBridge.ts";

/** Applied only to a staged expo-device-hub@0.12.0 install, on local and SSH hosts. */
export const DEVICE_HUB_UPSTREAM_VERSION = "0.12.0";

// Kept as plain Node source so an SSH host applies exactly the same patch before publishing its install.
export const deviceHubPatchScript =
  `const pathwayTvNative = ${JSON.stringify(tvInputNativeSource)};\nconst pathwayTvBridge = ${JSON.stringify(tvInputBridgeSource)};\n` +
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
      // Tag 0x12 acknowledges native input completion, not a rendered frame. Keep native errors visible.
      const handler = 'if($[0]===18){let request;try{request=JSON.parse($.subarray(1).toString("utf8"));await this.waitForCapture();if(this.phase!=="running")throw Error("Simulator session is closed");const h=this.hid.handle,p=request.payload;switch(request.tag){case 3:await h.touch(p.type,p.x,p.y,this.width,this.height,0);break;case 4:await h.buttonHid(p.page,p.usage,"press");break;case 6:await h.key("down",p.usage);try{}finally{await h.key("up",p.usage)}break;case 10:await h.digitalCrown(p.delta);break;case 19:this.pathwayTvInput??=createPathwayTvInput(this.udid);await this.pathwayTvInput.send(p.button);break;default:throw Error("Unsupported input tag")}'+socket+'.send(Buffer.concat([Buffer.from([18]),Buffer.from(JSON.stringify({id:request.id,ok:true}))]));}catch(error){'+socket+'.send(Buffer.concat([Buffer.from([18]),Buffer.from(JSON.stringify({id:request?.id,ok:false,error:String(error)}))]));}return;}';
      text = replace(text, signature, signature + handler);
      text = replace(text, 'this.phase="stopped"', 'this.pathwayTvInput?.close();this.phase="stopped"');
      text = 'import { createPathwayTvInput } from "./pathway-tv-input.mjs";\n' + text;
    }
    return [file, text];
  });
  const nativeSource = path.join(root, 'vendor/serve-sim/dist/native/pathway-tv-input.m');
  fs.writeFileSync(nativeSource, pathwayTvNative);
  fs.writeFileSync(path.join(root, 'vendor/serve-sim/dist/pathway-tv-input.mjs'), pathwayTvBridge);
  if (process.platform === 'darwin') {
    require('node:child_process').execFileSync('xcrun', ['clang', '-fobjc-arc', '-fblocks', '-framework', 'Foundation', nativeSource, '-o', path.join(root, 'vendor/serve-sim/dist/native/pathway-tv-input')], { stdio: 'pipe', timeout: 120000 });
  }
  for (const [file, text] of staged) fs.writeFileSync(path.join(root, file), text);
}
`;
