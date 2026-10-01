/** Runs inside the pinned helper, including when clients use its socket directly. */
export const simulatorInputBoundarySource = String.raw`
import { execFile } from 'node:child_process';
import { ensurePathwayTvInput } from './pathway-tv-build.mjs';
import { createPathwayTvInput } from './pathway-tv-input.mjs';
export async function readSimulatorFamily(udid) {
  const data = await new Promise((resolve, reject) => execFile('xcrun', ['simctl', 'list', 'devices', '--json'], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
  const devices = JSON.parse(data).devices;
  for (const [runtime, entries] of Object.entries(devices)) {
    const device = entries.find((entry) => entry.udid === udid && entry.isAvailable);
    if (!device) continue;
    if (runtime.includes('.tvOS-')) return 'tv';
    if (runtime.includes('.watchOS-')) return 'watch';
    if (runtime.includes('.iOS-')) return /\.iPad-/.test(device.deviceTypeIdentifier || '') ? 'pad' : 'phone';
  }
  throw Error('Simulator family is unavailable');
}
export function createPathwaySimulatorInput(session) {
  let family, tail = Promise.resolve(), pending = 0, closed = false;
  const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
  const integer = (value, min, max) => Number.isInteger(value) && finite(value, min, max);
  const oneOf = (value, values) => values.includes(value);
  const validate = (kind, tag, p, envelope) => {
    const touch = oneOf(p.type, ['begin','move','end']);
    let valid = false;
    if (kind === 'tv') {
      if (tag !== 19 || !envelope) throw Error('TV accepts only semantic remote buttons');
      valid = oneOf(p.button, ['up','down','left','right','select','menu','back','playPause','home']);
    } else {
      if (kind === 'watch' && ![3,4,10].includes(tag)) throw Error('Input is unavailable on Watch');
      switch (tag) {
        case 3: valid = touch && finite(p.x,0,1) && finite(p.y,0,1) && (p.edge === undefined || integer(p.edge,0,15)); break;
        case 4:
          valid = p.page === undefined && p.usage === undefined
            ? kind !== 'watch' && oneOf(p.button, ['home','swipe_home','app_switcher','lock','siri','side_button'])
            : integer(p.page,0,65535) && integer(p.usage,0,65535);
          if (kind === 'watch') valid = p.page === 12 && oneOf(p.usage,[64,149]);
          valid = valid && (p.phase === undefined || (envelope || kind === 'watch' ? p.phase === 'press' : oneOf(p.phase,['press','down','up']))); break;
        case 5: valid = touch && [p.x1,p.y1,p.x2,p.y2].every((v) => finite(v,0,1)); break;
        case 6: valid = integer(p.usage,0,65535) && (envelope || oneOf(p.type,['down','up'])); break;
        case 7: valid = oneOf(p.orientation,['portrait','landscape_left','portrait_upside_down','landscape_right']); break;
        case 8: valid = typeof p.option === 'string' && p.option.length < 128 && typeof p.enabled === 'boolean'; break;
        case 9: case 12: valid = true; break;
        case 10: valid = kind === 'watch' && finite(p.delta,-200,200); break;
        case 11: valid = finite(p.dx,-1,1) && finite(p.dy,-1,1) && (p.x === undefined || finite(p.x,0,1)) && (p.y === undefined || finite(p.y,0,1)); break;
        case 13: valid = typeof p.visible === 'boolean'; break;
        case 14: valid = typeof p.enabled === 'boolean'; break;
        // These controls retain the pinned helper's own strict validators.
        case 15: case 16: case 17: valid = !envelope; break;
      }
      if (envelope && ![3,4,6,10].includes(tag)) valid = false;
    }
    if (!valid) throw Error('Invalid or unsupported simulator input');
  };
  return {
    async handle(data, socket, legacy) {
      let request, envelope = data[0] === 18;
      const reply = (ok, error) => {
        if (socket.readyState !== 1) return;
        if (envelope || !ok) socket.send(Buffer.concat([Buffer.from([18]),Buffer.from(JSON.stringify({ id: request?.id ?? null, ok, ...(error ? { error: String(error) } : {}) }))]));
      };
      try {
        if (data.length < 1 || data.length > 4096) throw Error('Invalid simulator input size');
        const decoded = data.length === 1 ? {} : JSON.parse(data.subarray(1).toString('utf8'));
        request = envelope ? decoded : { tag: data[0], payload: decoded };
        if (!request || !Number.isInteger(request.tag) || !request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload)) throw Error('Invalid simulator input');
        if (envelope && (typeof request.id !== 'string' || request.id.length > 128)) throw Error('Invalid simulator input id');
        if (pending >= 64) throw Error('Simulator input queue is full');
        pending++;
        const connected = () => {
          if (closed || session.phase !== 'running' || socket.readyState !== 1) throw Error('Simulator input connection closed');
        };
        const operation = tail.then(async () => {
          connected();
          await session.waitForCapture(); connected();
          family ??= readSimulatorFamily(session.udid);
          const kind = await family; connected();
          const { tag, payload: p } = request;
          validate(kind, tag, p, envelope);
          const h = session.hid.handle;
          if (tag === 3) session.recordTouchEvent?.(p);
          else if ([4,5,6,10,11].includes(tag)) session.recordHidEvent?.(tag,p);
          switch (tag) {
            case 3: await h.touch(p.type,p.x,p.y,session.width,session.height,p.edge ?? 0); break;
            case 4:
              if (p.page === undefined) await h.button(p.button);
              else await h.buttonHid(p.page,p.usage,p.phase ?? 'press');
              break;
            case 5: await h.multiTouch(p.type,p.x1,p.y1,p.x2,p.y2,session.width,session.height); break;
            case 6:
              if (envelope) { try { await h.key('down',p.usage); } finally { await h.key('up',p.usage); } }
              else await h.key(p.type,p.usage);
              break;
            case 10: await h.digitalCrown(p.delta); break;
            case 11: await h.scroll(p.dx*session.width,p.dy*session.height,p.x ?? NaN,p.y ?? NaN,session.width,session.height); break;
            case 19:
              await ensurePathwayTvInput(); connected();
              session.pathwayTvInput ??= createPathwayTvInput(session.udid);
              await session.pathwayTvInput.send(p.button); break;
            default: await legacy(data,socket);
          }
        });
        tail = operation.catch(() => {});
        try { await operation; reply(true); } finally { pending--; }
      } catch (error) { reply(false,error); }
    },
    close() { closed = true; },
  };
}
`;
