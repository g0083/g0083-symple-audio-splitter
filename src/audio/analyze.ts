/**
 * 波形表示の進行管理。
 *
 * Worker を 2 つ使う:
 * - rangeWorker: 表示範囲のピーク (操作に追従する必要がある)
 * - rmsWorker: 全編の 10ms RMS (無音検出用のバックグラウンド処理)
 *
 * 同じ Worker に載せると、全編デコード中のズームが待たされてしまうため分ける。
 * 解析対象は File として渡し、バイト列の読み込みも Worker 側で行う。
 */

import PeaksWorker from '../workers/peaks.worker?worker';
import type { AnalysisMessage, RangeJob, RmsJob, SourceSpec } from './analysis';
import type { Peaks } from './peaks';
import type { AudioInfo } from './inspect';

/** ピーク 1 個あたりのサンプル数 */
export const PEAK_BUCKET = 256;

type Pending = { resolve: (message: AnalysisMessage | null) => void };

type Channel = {
  worker: Worker | null;
  pending: Map<number, Pending>;
  sourceIds: Map<number, number>;
};

let sequence = 0;

function createChannel(): Channel {
  return { worker: null, pending: new Map(), sourceIds: new Map() };
}

const rangeChannel = createChannel();
const rmsChannel = createChannel();

function getWorker(channel: Channel): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (channel.worker) return channel.worker;
  try {
    const instance = new PeaksWorker();
    instance.onmessage = (event: MessageEvent) => {
      const message = event.data as AnalysisMessage;
      const request = channel.pending.get(message.id);
      if (request) request.resolve(message);
    };
    instance.onerror = () => {
      for (const request of channel.pending.values()) request.resolve(null);
      channel.pending.clear();
      channel.worker = null;
    };
    channel.worker = instance;
    return instance;
  } catch {
    return null;
  }
}

function specOf(file: File, info: AudioInfo): SourceSpec {
  return {
    file,
    sampleRate: info.sampleRate,
    channels: info.channels,
    duration: info.duration,
    codec: info.codec,
    mp3: info.mp3Index,
    mp4: info.mp4Index,
    wav: info.wavInfo,
    asc: info.audioSpecificConfig,
  };
}

/**
 * 解析対象を波形用 Worker に登録する。
 * File を渡すだけで即座に戻り、実際の読み込みは Worker 側で行う。
 */
export function registerSource(file: File, info: AudioInfo): { sourceId: number; ready: Promise<void> } | null {
  const range = getWorker(rangeChannel);
  if (!range) return null;
  const sourceId = ++sequence;
  const jobId = ++sequence;
  rangeChannel.sourceIds.set(sourceId, sourceId);
  const ready = new Promise<void>((resolve) => {
    rangeChannel.pending.set(jobId, { resolve: () => resolve() });
    try {
      range.postMessage({ id: jobId, type: 'source', sourceId, spec: specOf(file, info) });
    } catch {
      rangeChannel.pending.delete(jobId);
      resolve();
    }
  });
  return { sourceId, ready };
}

/** 登録した解析対象を破棄する */
export function releaseSource(sourceId: number): void {
  for (const channel of [rangeChannel, rmsChannel]) {
    if (!channel.worker) continue;
    channel.worker.postMessage({ id: ++sequence, type: 'release', sourceId });
    channel.sourceIds.delete(sourceId);
  }
}

export function canAnalyze(): boolean {
  return getWorker(rangeChannel) !== null;
}

/**
 * 指定したサンプル範囲のピークを要求する。
 * onPartial には届いたぶんから順に、同じ Peaks オブジェクトを渡す。
 */
export function requestRange(
  sourceId: number,
  sampleRate: number,
  startSample: number,
  endSample: number,
  bucket: number,
  onPartial?: (peaks: Peaks) => void,
): Promise<Peaks | null> {
  const instance = getWorker(rangeChannel);
  if (!instance) return Promise.resolve(null);

  const step = Math.max(256, Math.floor(bucket / 256) * 256);
  const id = ++sequence;
  const base = Math.max(0, Math.floor(startSample / step) * step);
  const end = Math.max(base + step, Math.ceil(endSample / step) * step);
  const job: RangeJob = { id, type: 'range', sourceId, bucket: step, startSample: base, endSample: end };

  const count = Math.max(1, Math.ceil((end - base) / step));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const peaks: Peaks = { min, max, bucket: step, startSample: base, valid: 0, sampleRate };

  return new Promise<Peaks | null>((resolve) => {
    rangeChannel.pending.set(id, {
      resolve: (message) => {
        if (!message) {
          rangeChannel.pending.delete(id);
          resolve(peaks.valid > 0 ? peaks : null);
          return;
        }
        if (message.type === 'range-partial') {
          const to = Math.min(count, message.offset + message.min.length);
          min.set(message.min, message.offset);
          max.set(message.max, message.offset);
          peaks.valid = Math.max(peaks.valid, to);
          onPartial?.(peaks);
          return;
        }
        if (message.type === 'range') {
          rangeChannel.pending.delete(id);
          const to = Math.min(count, message.min.length);
          min.set(message.min, 0);
          max.set(message.max, 0);
          peaks.valid = to;
          onPartial?.(peaks);
          resolve(peaks);
          return;
        }
        if (message.type === 'done') return;
        rangeChannel.pending.delete(id);
        resolve(peaks.valid > 0 ? peaks : null);
      },
    });
    try {
      instance.postMessage(job);
    } catch {
      rangeChannel.pending.delete(id);
      resolve(null);
    }
  });
}

/**
 * 全編の RMS をバックグラウンドで作る。
 * 41MB のバイト列を複製しないよう、File をそのまま渡して Worker 側で読ませる。
 * 分割や書き出しが始まったら cancel() で止める。
 */
export function requestRms(
  file: File,
  info: AudioInfo,
  sourceId: number,
  hopSeconds = 0.01,
): { result: Promise<Float32Array | null>; cancel(): void } {
  const instance = getWorker(rmsChannel);
  if (!instance) return { result: Promise.resolve(null), cancel: () => {} };

  const id = ++sequence;
  // RMS Worker は自分でファイルを読む
  instance.postMessage({ id: ++sequence, type: 'source', sourceId, spec: specOf(file, info) });
  const job: RmsJob = { id, type: 'rms', sourceId, hopSeconds };

  const result = new Promise<Float32Array | null>((resolve) => {
    rmsChannel.pending.set(id, {
      resolve: (message) => {
        if (!message) {
          rmsChannel.pending.delete(id);
          resolve(null);
          return;
        }
        if (message.type === 'rms') {
          rmsChannel.pending.delete(id);
          resolve(message.rms);
          return;
        }
        if (message.type === 'done') return;
        rmsChannel.pending.delete(id);
        resolve(null);
      },
    });
    try {
      instance.postMessage(job);
    } catch {
      rmsChannel.pending.delete(id);
      resolve(null);
    }
  });

  return {
    result,
    cancel(): void {
      if (!rmsChannel.pending.has(id)) return;
      rmsChannel.pending.delete(id);
      // Worker は処理を中断できないため、終了して作り直す
      rmsChannel.worker?.terminate();
      rmsChannel.worker = null;
      rmsChannel.sourceIds.clear();
      for (const request of rmsChannel.pending.values()) request.resolve(null);
      rmsChannel.pending.clear();
    },
  };
}

/** PCM から 10ms RMS を作る (Worker が使えないときのフォールバック) */
export function computeRms(buffer: AudioBuffer): { rms: Float32Array; hopSeconds: number } {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
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
