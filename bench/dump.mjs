/**
 * 生成された分割ファイルをディスクに書き出して ffprobe で検証できるようにする。
 *   node bench/dump.mjs --label step1 --format m4a --bitrate original
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const args = { label: 'dump', fixture: 'tone180.m4a', format: 'm4a', bitrate: 'original', splits: '9', port: '9336' };
for (let i = 0; i < process.argv.length - 2; i += 2) {
  const key = process.argv[i + 2].replace(/^--/, '');
  if (key in args) args[key] = process.argv[i + 3];
}

const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function devtools(port) {
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('devtools not ready');
}

const child = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${args.port}`, `--user-data-dir=${join(outDir, `profile-${args.port}`)}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
const version = await devtools(args.port);

const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
const s = a.sessionId;
await send('Runtime.enable', {}, s);
await send('Page.enable', {}, s);
const query = new URLSearchParams({ fixture: args.fixture, format: args.format, bitrate: args.bitrate, splits: args.splits, dump: '1' }).toString();
await send('Page.navigate', { url: `http://localhost:5199/bench/bench.html?${query}` }, s);

let result = null;
for (let i = 0; i < 600; i++) {
  const r = await send('Runtime.evaluate', { expression: 'window.__BENCH_RESULT ?? null', returnByValue: true }, s);
  if (r.result?.result?.value) { result = r.result.result.value; break; }
  await sleep(200);
}
if (!result) throw new Error('bench did not finish');
if (!result.ok) throw new Error(result.error);

const dir = join(outDir, args.label);
mkdirSync(dir, { recursive: true });
for (let i = 0; i < result.segments; i++) {
  const r = await send('Runtime.evaluate', { expression: `window.__BENCH_GET_FILE(${i})`, awaitPromise: true, returnByValue: true }, s);
  const base64 = r.result?.result?.value;
  if (!base64) throw new Error(`file ${i} not available`);
  const name = `${String(i + 1).padStart(2, '0')}.${args.format}`;
  writeFileSync(join(dir, name), Buffer.from(base64, 'base64'));
}
console.log(`wrote ${result.segments} files to ${dir}`);
console.log(`path=${result.path} exportMs=${result.exportMs.toFixed(1)}`);

ws.close();
child.kill();
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(0);
