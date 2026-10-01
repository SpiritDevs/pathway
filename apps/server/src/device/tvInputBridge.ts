/** Installed next to serve-sim. One native connection per session, shared by viewer and MCP inputs. */
export const tvInputBridgeSource = String.raw`
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function createPathwayTvInput(udid) {
  let child, closed = false, sequence = 0;
  const pending = new Map();
  const fail = (error) => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  };
  const stop = (error) => {
    const current = child;
    child = undefined;
    fail(error);
    if (current) { current.stdin.end(); current.kill(); }
  };
  const start = () => {
    const current = spawn(fileURLToPath(new URL('./native/pathway-tv-input', import.meta.url)), [udid], { stdio: ['pipe', 'pipe', 'pipe'] });
    child = current;
    let output = '', diagnostic = '';
    current.stderr.on('data', (data) => { diagnostic = (diagnostic + data).slice(-4096); });
    current.stdin.on('error', (error) => { if (child === current) stop(error); });
    current.on('error', (error) => { if (child === current) stop(error); });
    current.on('exit', (code) => {
      if (child !== current) return;
      child = undefined;
      fail(Error('TV input helper exited (' + code + '): ' + diagnostic));
    });
    current.stdout.on('data', (data) => {
      if (child !== current) return;
      output += data;
      if (output.length > 65536) { stop(Error('Invalid TV input response')); return; }
      while (output.includes('\n')) {
        const end = output.indexOf('\n'), line = output.slice(0, end);
        output = output.slice(end + 1);
        let reply;
        try { reply = JSON.parse(line); } catch { stop(Error('Invalid TV input response')); return; }
        const request = pending.get(reply.id);
        if (!request) continue;
        pending.delete(reply.id); clearTimeout(request.timer);
        if (reply.ok === true) request.resolve(); else request.reject(Error(reply.error || 'TV input was rejected'));
      }
    });
  };
  return {
    send(button) {
      if (closed) return Promise.reject(Error('TV session is closed'));
      if (!['up','down','left','right','select','menu','back','playPause','home'].includes(button)) return Promise.reject(Error('Unsupported TV button'));
      if (pending.size >= 64) return Promise.reject(Error('TV input queue is full'));
      if (!child) start();
      return new Promise((resolve, reject) => {
        const id = String(++sequence);
        const timer = setTimeout(() => stop(Error('TV input acknowledgement timed out')), 8000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, button }) + '\n');
      });
    },
    close() { closed = true; stop(Error('TV session closed')); },
  };
}
`;
