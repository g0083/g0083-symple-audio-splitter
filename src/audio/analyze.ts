/**
 * 波形解析の進行管理。
 * Worker でピークと RMS を作り、逐次メインスレッドへ渡す。
 * Worker が使えない環境ではメインスレッドでチャンク実行する。
 */

import PeaksWorker from '../workers/peaks.worker?worker';
import type { AnalysisJob, AnalysisMessage, PeaksChunk } from './analysis';
import { channelsOf, computePeaks, type Peaks } from './peaks';
import type { AudioInfo } from './inspect';

export type AnalysisProgress = {
  /** 解析済みのピーク数 */
  done: number;
  total: number;
};

export type AnalysisHandle = {
  /** ピークが増えるたびに呼ばれる。部分的な Peaks を渡す */
  peaks: Peaks;
  /** 解析完了まで待つ */
  done: Promise<{ peaks: Peaks; rms: Float32Array | null; rmsHopSeconds: number }>;
  cancel(): void;
};

const SAMPLE_BUCKET = 256;

let worker: Worker | null = null;
let sequence = 0;
const active = new Map<number, (message: AnalysisMessage) => void>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (worker) return worker;
  try {
    const instance = new PeaksWorker();
    instance.onmessage = (event: MessageEvent) => {
      const message = event.data as AnalysisMessage;
      const handler = active.get(message.id);
      if (handler) handler(message);
    };
    instance.onerror = () => {
      for (const handler of active.values()) {
        handler({ id: -1, type: 'error', message: 'worker error' });
      }
      active.clear();
      worker = null;
    };
    worker = instance;
    return instance;
  } catch {
    return null;
  }
}

/**
 * Worker に解析を依頼する。解析結果は onPeaks で逐次届く。
 * Worker が使えない、またはコーデック非対応の場合は fallback を呼ぶ。
 */
export function analyzeAsync(
  bytes: Uint8Array,
  info: AudioInfo,
  options: {
    wantRms: boolean;
    /** 粗い波形を先に描くための間引き間隔。1 で無効 */
    coarseStep?: number;
    onPeaks: (peaks: Peaks, progress: AnalysisProgress) => void;
  },
): AnalysisHandle | null {
  const instance = getWorker();
  if (!instance) return null;

  const id = ++sequence;
  const total = Math.max(1, Math.ceil((info.duration * info.sampleRate) / SAMPLE_BUCKET) + 1);
  const min = new Float32Array(total);
  const max = new Float32Array(total);
  const peaks: Peaks = { min, max, bucket: SAMPLE_BUCKET, sampleRate: info.sampleRate };
  let filled = 0;
  let rms: Float32Array | null = null;
  let rmsHopSeconds = 0.01;
  let settled = false;
  let resolveDone: (value: { peaks: Peaks; rms: Float32Array | null; rmsHopSeconds: number }) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};

  const done = new Promise<{ peaks: Peaks; rms: Float32Array | null; rmsHopSeconds: number }>(
    (resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    },
  );

  const finish = (): void => {
    if (settled) return;
    settled = true;
    active.delete(id);
    resolveDone({ peaks, rms, rmsHopSeconds });
  };

  const cleanup = (): void => {
    active.delete(id);
  };

  active.set(id, (message) => {
    if (message.type === 'peaks') {
      const chunk = message as PeaksChunk;
      if (chunk.start < total) {
        min.set(chunk.min, chunk.start);
        max.set(chunk.max, chunk.start);
        filled = Math.max(filled, Math.min(total, chunk.start + chunk.min.length));
      }
      options.onPeaks(peaks, { done: filled, total });
      return;
    }
    if (message.type === 'rms') {
      rms = message.rms;
      rmsHopSeconds = message.hopSeconds;
      return;
    }
    if (message.type === 'done') {
      filled = Math.max(filled, Math.min(total, message.peakCount));
      options.onPeaks(peaks, { done: filled, total });
      finish();
      return;
    }
    if (message.type === 'unsupported') {
      settled = true;
      cleanup();
      rejectDone(new Error(`unsupported: ${message.reason}`));
      return;
    }
    if (message.type === 'error') {
      settled = true;
      cleanup();
      rejectDone(new Error(message.message));
    }
  });

  const job: AnalysisJob = {
    id,
    bytes,
    sampleRate: info.sampleRate,
    channels: info.channels,
    duration: info.duration,
    bucket: SAMPLE_BUCKET,
    wantRms: options.wantRms,
    codec: info.codec,
    mp3: info.mp3Index,
    mp4: info.mp4Index,
    wav: info.wavInfo,
    asc: info.audioSpecificConfig,
    coarseStep: Math.max(1, Math.floor(options.coarseStep ?? 1)),
  };

  try {
    // 元ファイルのバイト列は再エンコードでも使うため transfer せずコピーする
    instance.postMessage(job);
  } catch (error) {
    cleanup();
    return null;
  }

  return {
    peaks,
    done,
    cancel(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolveDone({ peaks, rms, rmsHopSeconds });
    },
  };
}

/**
 * 進行中の解析をすべて打ち切る。
 * Worker は処理中のジョブを中断できないため、終了して作り直す。
 */
export function cancelAllAnalysis(): void {
  if (active.size === 0 && !worker) return;
  for (const handler of Array.from(active.values())) {
    handler({ id: -1, type: 'error', message: 'cancelled' });
  }
  active.clear();
  if (worker) {
    worker.terminate();
    worker = null;
  }
}

/** Worker フォールバック: decodeAudioData + メインスレッドピーク計算 */
export async function analyzeWithDecode(
  buffer: AudioBuffer,
  onPeaks?: (peaks: Peaks, progress: AnalysisProgress) => void,
): Promise<{ peaks: Peaks; rms: Float32Array | null; rmsHopSeconds: number }> {
  let latest: Peaks | null = null;
  let total = 0;
  const peaks = await computePeaks(buffer, SAMPLE_BUCKET, (ratio) => {
    if (!latest) return;
    onPeaks?.(latest, { done: Math.round(ratio * total), total });
  }, (partial) => {
    latest = partial;
    total = partial.min.length;
    onPeaks?.(partial, { done: 0, total });
  });
  onPeaks?.(peaks, { done: peaks.min.length, total: peaks.min.length });
  return { peaks, rms: null, rmsHopSeconds: 0.01 };
}

/** PCM から 10ms RMS を作る (無音検出用) */
export function computeRms(buffer: AudioBuffer): { rms: Float32Array; hopSeconds: number } {
  const channels = channelsOf(buffer);
  const hop = Math.max(1, Math.round(buffer.sampleRate * 0.01));
  const length = channels[0]?.length ?? 0;
  const frames = Math.floor(length / hop);
  const rms = new Float32Array(Math.max(0, frames));
  for (let f = 0; f < frames; f++) {
    const from = f * hop;
    const to = from + hop;
    let sum = 0;
    for (const data of channels) {
      for (let i = from; i < to; i++) {
        const v = data[i];
        sum += v * v;
      }
    }
    rms[f] = Math.sqrt(sum / (hop * channels.length));
  }
  return { rms, hopSeconds: 0.01 };
}
