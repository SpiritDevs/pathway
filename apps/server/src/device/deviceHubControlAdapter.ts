/**
 * Hub 0.12.0's iOS socket does not await HID calls or acknowledge them. This
 * process-local loader adds receipts without editing the shared tool install.
 * Children inherit NODE_OPTIONS, so the serve-sim helper loads the same adapter.
 * Keep the anchors pinned: an upstream change must fail closed, never lose a fence.
 */
export function patchDeviceHubControlSource(source: string): string {
  const start = /async handleHidMessage\([\w$]+,[\w$]+\)\{/.exec(source)?.[0];
  if (!start) throw new Error("Unsupported serve-sim control protocol");
  const end = "queueHingeControl($){";
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error("Unsupported serve-sim control protocol");
  let method = source
    .slice(from, to)
    .replace("async handleHidMessage", "async pathwayHandleHidMessage");
  method = method.replaceAll(
    /(?<!await )this\.hid\.(touch|buttonHid|button|multiTouch|key|caDebug|memoryWarning|digitalCrown|scroll|softwareKeyboard)\(/g,
    "await this.hid.$1(",
  );
  method = method.replace(
    /([\w$]+)\(this\.udid,"hardware-keyboard",/g,
    'await $1(this.udid,"hardware-keyboard",',
  );
  const wrapper = `handleHidMessage(packet,socket){
    if(packet[0]!==126)return;
    const task=(this.pathwayInputQueue??Promise.resolve()).then(async()=>{
      let request;
      try{
        request=JSON.parse(packet.subarray(1).toString("utf8"));
        if(!Number.isSafeInteger(request.id)||typeof request.packet!=="string")throw Error("Invalid managed input");
        const input=Buffer.from(request.packet,"base64");
        if(![3,4,5,6,7,8,9,10,11,12,13,14,15,16].includes(input[0]))throw Error("Unsupported input");
        await this.pathwayHandleHidMessage(input,socket);
        await this.softwareKeyboardSync;
        await this.hingeControlUpdate;
        socket.send(Buffer.concat([Buffer.from([254]),Buffer.from(JSON.stringify({id:request.id,ok:true}))]));
      }catch(error){socket.send(Buffer.concat([Buffer.from([254]),Buffer.from(JSON.stringify({id:request?.id,ok:false}))]));}
    });
    this.pathwayInputQueue=task.catch(()=>{});
    return task;
  }`;
  // The environment finishes held input explicitly. The vendor's last-socket
  // keyboard reset must not become an untracked mutation after hand-back.
  let prefix = source.slice(0, from);
  const detach = prefix.lastIndexOf("detachHidSocket(");
  if (detach >= 0)
    prefix = prefix.slice(0, detach) + "detachHidSocket(socket){this.hidSockets.delete(socket)}";
  // The keyboard queue also called native HID without awaiting its promise.
  let suffix = source.slice(to);
  const keyboard = /async setSoftwareKeyboardVisible\([\w$]+\)\{[\s\S]*?(?=recordTouchEvent\()/;
  suffix = suffix.replace(keyboard, (body) =>
    body.replaceAll(
      /(?<!await )this\.hid\.softwareKeyboard\(/g,
      "await this.hid.softwareKeyboard(",
    ),
  );
  return prefix + wrapper + method + suffix;
}

export const deviceHubControlNodeOptions =
  "--import=data:text/javascript;base64," +
  Buffer.from(`
import { registerHooks } from 'node:module';
const patch = ${patchDeviceHubControlSource.toString()};
registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (!url.endsWith('/vendor/serve-sim/dist/serve-sim.js') && !url.endsWith('/vendor/serve-sim/dist/middleware.js')) return result;
  return { ...result, source: patch(String(result.source)) };
}});
`).toString("base64");
