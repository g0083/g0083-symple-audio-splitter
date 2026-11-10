/**
 * 実際の UI を操作して m4a 分割が壊れていないか検証する。
 *   node bench/e2e.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });
const port = '9337';
const chromePath = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${join(outDir, `profile-${port}`)}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });

async function devtools() {
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) return await r.json(); } catch { /* wait */ }
    await sleep(150);
  }
  throw new Error('devtools not ready');
}

const version = await devtools();
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0;
const pending = new Map();
const logs = [];
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC ' + m.params.exceptionDetails.text + ' ' + (m.params.exceptionDetails.exception?.description ?? ''));
});
const send = (method, params = {}, sessionId) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params, sessionId })); });

const { result: t } = await send('Target.createTarget', { url: 'about:blank' });
const { result: a } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
const s = a.sessionId;
await send('Runtime.enable', {}, s);
await send('Page.enable', {}, s);
await send('Page.navigate', { url: 'http://localhost:5199/' }, s);
await sleep(2500);

const evaluate = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true }, s);
  if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
  return r.result?.result?.value;
};

// ファイルをセットして change を発火
const setup = await evaluate(`(async () => {
  const res = await fetch('/bench/fixtures/blocks180.m4a');
  const blob = await res.blob();
  const file = new File([blob], 'blocks180.m4a', { type: 'audio/mp4' });
  const input = document.getElementById('file-input');
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok';
})()`, true);
console.log('setup:', setup);

// 読み込み完了を待つ
for (let i = 0; i < 100; i++) {
  const ready = await evaluate(`!document.getElementById('workspace').hidden`);
  if (ready) break;
  await sleep(200);
}
console.log('workspace visible:', await evaluate(`!document.getElementById('workspace').hidden`));
console.log('file meta:', await evaluate(`document.getElementById('file-meta').textContent`));

// 出力形式 m4a / 品質「元のまま」を選ぶ
await evaluate(`(() => {
  const fmt = document.getElementById('out-format');
  fmt.value = 'm4a';
  fmt.dispatchEvent(new Event('change', { bubbles: true }));
  return fmt.value;
})()`);
await sleep(300);
const qualityOptions = await evaluate(`Array.from(document.getElementById('out-quality').options).map(o => o.value + ':' + o.textContent)`);
console.log('quality options:', qualityOptions);

await evaluate(`(() => {
  const q = document.getElementById('out-quality');
  q.value = 'original';
  q.dispatchEvent(new Event('change', { bubbles: true }));
  return q.value;
})()`);

// 4 分割
await evaluate(`(() => {
  document.getElementById('equal-count').value = '4';
  document.getElementById('apply-equal').click();
  return 'clicked';
})()`);
await sleep(500);
console.log('segments:', await evaluate(`document.getElementById('seg-count').textContent`));

// 書き出し
await evaluate(`document.getElementById('export-btn').click()`);
for (let i = 0; i < 200; i++) {
  const done = await evaluate(`document.querySelectorAll('#results a').length`);
  if (done > 0) break;
  await sleep(250);
}
const results = await evaluate(`Array.from(document.querySelectorAll('#results a')).map(a => a.download)`);
console.log('results:', results);
console.log('progress:', await evaluate(`document.getElementById('progress-text').textContent`));

// 生成物を取り出す
const files = await evaluate(`(async () => {
  const links = Array.from(document.querySelectorAll('#results a'));
  const out = [];
  for (const link of links) {
    const res = await fetch(link.href);
    const buf = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out.push({ name: link.download, b64: btoa(bin) });
  }
  return out;
})()`, true);

const dir = join(outDir, 'e2e');
mkdirSync(dir, { recursive: true });
for (const f of files) writeFileSync(join(dir, f.name), Buffer.from(f.b64, 'base64'));
console.log('wrote', files.length, 'files to', dir);
if (logs.length) console.log('console:', logs.slice(0, 10));

ws.close();
child.kill();
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(0);
