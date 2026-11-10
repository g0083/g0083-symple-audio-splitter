/**
 * Chrome を DevTools Protocol で操作して bench.html を実行し、結果を JSON で出力する。
 *
 * 使い方:
 *   node bench/run.mjs --label baseline
 *   node bench/run.mjs --label step1 --format m4a --bitrate original
 *
 * 出力: bench/out/<label>.json
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

const CHROME_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `${process.env.LOCALAPPDATA ?? ''}/Google/Chrome/Application/chrome.exe`,
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function parseArgs(argv) {
  const args = { label: 'run', fixture: 'tone180.m4a', format: 'm4a', bitrate: 'original', splits: '9', repeat: '1', port: '9333' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in args)) throw new Error(`unknown flag: ${argv[i]}`);
    args[key] = argv[i + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const chromePath = CHROME_CANDIDATES.find((candidate) => candidate && existsSync(candidate));
if (!chromePath) throw new Error('Chrome が見つかりません');

const userDataDir = join(outDir, `profile-${args.port}`);

/** 既に起動済みの Chrome があれば再利用し、無ければ起動する */
async function ensureChrome() {
  try {
    const response = await fetch(`http://127.0.0.1:${args.port}/json/version`);
    if (response.ok) return { version: await response.json(), spawned: null };
  } catch {
    /* 起動する */
  }
  const child = spawn(
    chromePath,
    [
      '--headless=new',
      `--remote-debugging-port=${args.port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--autoplay-policy=no-user-gesture-required',
      'about:blank',
    ],
    { stdio: 'ignore', detached: false },
  );
  return { version: await waitForDevtools(args.port), spawned: child };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForDevtools(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      /* not ready */
    }
    await sleep(150);
  }
  throw new Error('DevTools に接続できません');
}

class Cdp {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  static async connect(url) {
    const cdp = new Cdp();
    cdp.#ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      cdp.#ws.addEventListener('open', resolve, { once: true });
      cdp.#ws.addEventListener('error', reject, { once: true });
    });
    cdp.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = cdp.#pending.get(message.id);
        if (!entry) return;
        cdp.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
        return;
      }
      const handlers = cdp.#listeners.get(message.method);
      if (handlers) for (const handler of handlers) handler(message.params);
    });
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.#id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.#ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
  }

  on(method, handler) {
    if (!this.#listeners.has(method)) this.#listeners.set(method, new Set());
    this.#listeners.get(method).add(handler);
  }

  close() {
    this.#ws.close();
  }
}

async function runOnce(cdp, baseUrl, query) {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });

  const consoleLines = [];
  cdp.on('Runtime.consoleAPICalled', (params) => {
    if (params.sessionId && params.sessionId !== sessionId) return;
    consoleLines.push(params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
  });
  cdp.on('Runtime.exceptionThrown', (params) => {
    if (params.sessionId && params.sessionId !== sessionId) return;
    consoleLines.push(`EXCEPTION: ${params.exceptionDetails.text} ${params.exceptionDetails.exception?.description ?? ''}`);
  });

  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.enable', {}, sessionId);
  const nav = await cdp.send('Page.navigate', { url: `${baseUrl}/bench/bench.html?${query}` }, sessionId);
  if (nav.errorText) throw new Error(`ページを開けません: ${nav.errorText} (${baseUrl})`);

  const deadline = Date.now() + 300000;
  let result = null;
  while (Date.now() < deadline) {
    const evaluated = await cdp.send(
      'Runtime.evaluate',
      { expression: 'window.__BENCH_RESULT ?? null', returnByValue: true, awaitPromise: false },
      sessionId,
    );
    const value = evaluated?.result?.value;
    if (value) {
      result = value;
      break;
    }
    await sleep(200);
  }

  await cdp.send('Target.closeTarget', { targetId });
  if (!result) throw new Error(`ベンチが完了しませんでした\n${consoleLines.join('\n')}`);
  return { result, consoleLines };
}

const { version, spawned } = await ensureChrome();
const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
const baseUrl = process.env.BENCH_BASE_URL ?? 'http://localhost:5199';

const query = new URLSearchParams({
  fixture: args.fixture,
  format: args.format,
  bitrate: args.bitrate,
  splits: args.splits,
}).toString();

const runs = [];
try {
  for (let i = 0; i < Number(args.repeat); i++) {
    const { result, consoleLines } = await runOnce(cdp, baseUrl, query);
    runs.push(result);
    if (!result.ok) {
      console.error(consoleLines.join('\n'));
      break;
    }
  }
} finally {
  cdp.close();
  if (spawned) {
    spawned.kill();
    try {
      execFileSync('taskkill', ['/PID', String(spawned.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
}

const ok = runs.filter((run) => run.ok);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const summary = {
  label: args.label,
  fixture: args.fixture,
  format: args.format,
  bitrate: args.bitrate,
  splits: Number(args.splits),
  path: ok[0]?.path ?? 'error',
  outputHash: ok[0]?.outputHash ?? '',
  runs,
  median: ok.length
    ? {
        decodeMs: median(ok.map((r) => r.decodeMs)),
        peaksMs: median(ok.map((r) => r.peaksMs)),
        exportMs: median(ok.map((r) => r.exportMs)),
        totalMs: median(ok.map((r) => r.totalMs)),
        outputBytes: median(ok.map((r) => r.outputBytes)),
        realtimeFactor: median(ok.map((r) => r.realtimeFactor)),
        peakHeapMb: median(ok.map((r) => r.peakHeapMb)),
        maxBlockMs: median(ok.map((r) => r.maxBlockMs)),
        maxBlockDecodeMs: median(ok.map((r) => r.maxBlockDecodeMs)),
      }
    : null,
};

const file = join(outDir, `${args.label}.json`);
writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
console.log(JSON.stringify(summary.median ?? summary.runs[0], null, 2));
console.log(`→ ${file}`);

// WebSocket と Chrome 子プロセスが event loop を掴むため明示的に終了する
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(ok.length === runs.length ? 0 : 1);
