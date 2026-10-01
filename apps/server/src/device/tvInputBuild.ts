/** Build only when TV input is requested. Shared hub setup never needs an Apple compiler. */
export const tvInputBuildSource = String.raw`
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
let building;
const run = (command, args) => new Promise((resolve,reject) => execFile(command,args,{ timeout:120000, maxBuffer:1024*1024 },(error,stdout) => error ? reject(error) : resolve(stdout.trim())));
export function ensurePathwayTvInput() {
  building ??= (async () => {
    const binary = fileURLToPath(new URL('./native/pathway-tv-input',import.meta.url));
    const source = binary + '.m', record = binary + '.json';
    try { await fs.access(binary); return; } catch {}
    const temporary = binary + '.' + process.pid;
    try {
      const sourceSha256 = createHash('sha256').update(await fs.readFile(source)).digest('hex');
      const compiler = await run('xcrun',['clang','--version']);
      const developerDir = process.env.DEVELOPER_DIR || await run('xcode-select',['-p']);
      const args = ['clang','-fobjc-arc','-fblocks','-framework','Foundation',source,'-o',temporary];
      await run('xcrun',args);
      const binarySha256 = createHash('sha256').update(await fs.readFile(temporary)).digest('hex');
      await fs.rename(temporary,binary);
      await fs.writeFile(record,JSON.stringify({ status:'ready', sourceSha256, binarySha256, compiler, developerDir, arch:process.arch, args }));
    } catch (error) {
      const reason = 'TV input requires a working Xcode compiler: ' + String(error);
      await fs.writeFile(record,JSON.stringify({ status:'unavailable', reason })).catch(() => {});
      throw Error(reason);
    } finally { await fs.rm(temporary,{force:true}).catch(() => {}); }
  })().finally(() => { building = undefined; });
  return building;
}
`;
