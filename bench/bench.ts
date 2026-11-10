/**
 * ブラウザ内ベンチマーク。CDP から開いて window.__BENCH_RESULT を読む。
 *
 * クエリパラメータ:
 *   fixture  fixtures 配下のファイル名 (既定 tone180.m4a)
 *   format   出力形式 mp3 | m4a | wav (既定 m4a)
 *   bitrate  original | 128 | 192 | 256 (既定 original)
 *   splits   分割線の本数 (既定 9 → 10 セグメント)
 *   skip     decode,peaks,export のうち省略する工程
 */
import { decodeAudioFile } from '../src/audio/decode';
import { computePeaks } from '../src/audio/peaks';
import { buildSegments, equalSplits } from '../src/audio/segments';
import { exportSegments, resolveOriginalBitrate } from '../src/audio/export';
import { extOf } from '../src/audio/util';
import { indexMp3 } from '../src/audio/mp3frames';
import { indexMp4, mp4Bitrate } from '../src/audio/mp4frames';
import { readWavInfo } from '../src/audio/wav';

import { isAacSupported } from '../src/audio/aac';
import type { AudioSource, OutputFormat } from '../src/types';

type BenchResult = {
  ok: boolean;
  error?: string;
  fixture: string;
  format: string;
  bitrate: string;
  segments: number;
  decodeMs: number;
  peaksMs: number;
  exportMs: number;
  totalMs: number;
  outputBytes: number;
  sampleRate: number;
  channels: number;
  duration: number;
  /** 出力の先頭バイト列のハッシュ (内容が変わっていないことの確認用) */
  outputHash: string;
  /** 実際に使われた書き出し経路 */
  path: string;
  /** 出力 1 秒あたりの処理時間 (小さいほど速い) */
  realtimeFactor: number;
  /** 書き出し中の JS ヒープ最大値 (MB)。performance.memory が無い環境では 0 */
  peakHeapMb: number;
  /** 解析中にメインスレッドが連続してブロックされた最長時間 (ms) */
  maxBlockMs: number;
  /** デコード中にメインスレッドが連続してブロックされた最長時間 (ms) */
  maxBlockDecodeMs: number;
};

type MemoryInfo = { usedJSHeapSize: number };

/** 書き出し中のヒープ使用量を監視する */
function startHeapSampler(): { stop: () => number } {
  const memory = (performance as unknown as { memory?: MemoryInfo }).memory;
  if (!memory) return { stop: () => 0 };
  let peak = memory.usedJSHeapSize;
  const timer = setInterval(() => {
    peak = Math.max(peak, memory.usedJSHeapSize);
  }, 20);
  return {
    stop: () => {
      clearInterval(timer);
      return peak / (1024 * 1024);
    },
  };
}

/**
 * メインスレッドが連続して塞がれた最長時間を測る。
 * setTimeout(0) を連鎖させ、前回のコールバックからの遅延を「ブロック時間」とみなす。
 * 同期処理中はコールバックが一切走らないため、その間の遅延がそのまま観測される。
 */
function startBlockMonitor(): { stop: () => number } {
  let maxBlock = 0;
  let last = performance.now();
  let running = true;
  const tick = (): void => {
    if (!running) return;
    const now = performance.now();
    maxBlock = Math.max(maxBlock, now - last);
    last = now;
    setTimeout(tick, 0);
  };
  setTimeout(tick, 0);
  return {
    stop: () => {
      running = false;
      // 直前に終わった同期処理の分もブロック時間として数える
      return Math.max(maxBlock, performance.now() - last);
    },
  };
}

declare global {
  interface Window {
    __BENCH_RESULT?: BenchResult;
    /** dump=1 のとき、生成した Blob を base64 で取り出せるようにする */
    __BENCH_FILES?: { name: string; blob: Blob }[];
    __BENCH_GET_FILE?: (index: number) => Promise<string>;
  }
}

const params = new URLSearchParams(location.search);
const fixture = params.get('fixture') ?? 'tone180.m4a';
const format = (params.get('format') ?? 'm4a') as OutputFormat;
const bitrateParam = params.get('bitrate') ?? 'original';
const bitrate = bitrateParam === 'original' ? ('original' as const) : Number(bitrateParam);
const splitCount = Number(params.get('splits') ?? '9');
const skip = new Set((params.get('skip') ?? '').split(',').filter(Boolean));

const log = document.getElementById('log') as HTMLPreElement;
function note(message: string): void {
  log.textContent += `\n${message}`;
}

/** 出力バイト列の簡易ハッシュ (FNV-1a) */
function hashBytes(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16)}:${bytes.length}`;
}

async function run(): Promise<BenchResult> {
  const response = await fetch(`./fixtures/${fixture}`);
  if (!response.ok) throw new Error(`fixture を取得できません: ${fixture}`);
  const blob = await response.blob();
  const file = new File([blob], fixture, { type: blob.type });

  const t0 = performance.now();
  const decodeBlock = startBlockMonitor();
  const { bytes, decoded } = await decodeAudioFile(file);
  const decodeMs = performance.now() - t0;
  const maxBlockDecodeMs = decodeBlock.stop();

  const blockMonitor = startBlockMonitor();
  const t1 = performance.now();
  const peaks = skip.has('peaks')
    ? { min: new Float32Array(0), max: new Float32Array(0), bucket: 256, sampleRate: decoded.sampleRate }
    : await computePeaks(decoded.buffer);
  const peaksMs = performance.now() - t1;
  const maxBlockMs = blockMonitor.stop();

  const ext = extOf(file.name);
  const mp3Index = ext === 'mp3' ? indexMp3(bytes) : null;
  const mp4Index = ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac' ? indexMp4(bytes) : null;
  const wavInfo = ext === 'wav' ? readWavInfo(bytes) : null;
  const bitrateKbps =
    mp3Index?.averageBitrate ||
    (mp4Index ? mp4Bitrate(mp4Index) : 0) ||
    (decoded.duration > 0 ? Math.round((file.size * 8) / 1000 / decoded.duration) : 0);
  const source: AudioSource = {
    file,
    name: fixture.replace(/\.[^.]+$/, ''),
    ext,
    bytes,
    blob: file,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    duration: decoded.duration,
    bitrate: bitrateKbps,
    peaks,
    mp3Index,
    mp4Index,
    wavInfo,
    rms: null,
    rmsHopSeconds: 0.01,
    loadPcm: async () => decoded.buffer,
  };

  const splits = equalSplits(decoded.duration, splitCount + 1);
  const segments = buildSegments(splits, decoded.duration, 0);

  const aacSupported = format === 'm4a'
    ? await isAacSupported(
        source.sampleRate,
        Math.min(2, source.channels),
        typeof bitrate === 'number' ? bitrate : resolveOriginalBitrate(bitrateKbps, 'm4a'),
      )
    : false;
  const path =
    format === 'm4a'
      ? source.mp4Index !== null && bitrate === 'original'
        ? 'm4a-sample-copy'
        : aacSupported
          ? 'webcodecs-aac'
          : 'ffmpeg-wasm'
      : format === 'mp3'
        ? source.ext === 'mp3' && source.mp3Index !== null && bitrate === 'original'
          ? 'mp3-frame-copy'
          : 'lamejs'
        : source.wavInfo !== null
          ? 'wav-pcm-copy'
          : 'wav-encode';

  const sampler = startHeapSampler();
  const t2 = performance.now();
  const files = skip.has('export')
    ? []
    : await exportSegments({ source, segments, format, bitrate });
  const exportMs = performance.now() - t2;
  const peakHeapMb = sampler.stop();

  if (params.get('dump') === '1') {
    window.__BENCH_FILES = files;
    window.__BENCH_GET_FILE = async (index: number) => {
      const entry = files[index];
      if (!entry) throw new Error(`no file at ${index}`);
      const buffer = new Uint8Array(await entry.blob.arrayBuffer());
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < buffer.length; i += chunk) {
        binary += String.fromCharCode(...buffer.subarray(i, i + chunk));
      }
      return btoa(binary);
    };
  }

  let outputBytes = 0;
  const hashes: string[] = [];
  for (const entry of files) {
    const buffer = new Uint8Array(await entry.blob.arrayBuffer());
    outputBytes += buffer.length;
    hashes.push(hashBytes(buffer));
  }

  return {
    ok: true,
    fixture,
    format,
    bitrate: bitrateParam,
    segments: segments.length,
    decodeMs,
    peaksMs,
    exportMs,
    totalMs: decodeMs + peaksMs + exportMs,
    outputBytes,
    sampleRate: decoded.sampleRate,
    channels: decoded.channels,
    duration: decoded.duration,
    outputHash: hashes.join(','),
    path,
    realtimeFactor: exportMs / 1000 / decoded.duration,
    peakHeapMb,
    maxBlockMs,
    maxBlockDecodeMs,
  };
}

run()
  .then((result) => {
    window.__BENCH_RESULT = result;
    note(JSON.stringify(result, null, 2));
  })
  .catch((error: unknown) => {
    const result: BenchResult = {
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      fixture,
      format,
      bitrate: bitrateParam,
      segments: 0,
      decodeMs: 0,
      peaksMs: 0,
      exportMs: 0,
      totalMs: 0,
      outputBytes: 0,
      sampleRate: 0,
      channels: 0,
      duration: 0,
      outputHash: '',
      path: 'error',
      realtimeFactor: 0,
      peakHeapMb: 0,
      maxBlockMs: 0,
      maxBlockDecodeMs: 0,
    };
    window.__BENCH_RESULT = result;
    note(JSON.stringify(result, null, 2));
  });
