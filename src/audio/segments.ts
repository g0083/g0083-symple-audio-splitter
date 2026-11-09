import { nextFrame } from './util';

export type Segment = {
  index: number;
  start: number;
  end: number;
};

export type SilenceOptions = {
  thresholdDb: number;
  minSilenceMs: number;
  minSegmentMs: number;
};

const EPS = 0.001;

/** 分割線を昇順・重複なし・範囲内に正規化する */
export function normalizeSplits(splits: number[], duration: number): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const raw of splits) {
    if (!Number.isFinite(raw)) continue;
    if (raw <= EPS || raw >= duration - EPS) continue;
    const value = Math.round(raw * 1000) / 1000;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out.sort((a, b) => a - b);
}

/** 分割線とオーバーラップから各区間を組み立てる */
export function buildSegments(splits: number[], duration: number, overlapSec: number): Segment[] {
  const bounds = [0, ...normalizeSplits(splits, duration), duration];
  const half = Math.max(0, overlapSec) / 2;
  const segments: Segment[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const start = Math.max(0, bounds[i] - half);
    const end = Math.min(duration, bounds[i + 1] + half);
    if (end - start <= 0.0005) continue;
    segments.push({ index: segments.length, start, end });
  }
  return segments;
}

/** 均等分割の分割線を作る */
export function equalSplits(duration: number, count: number): number[] {
  const n = Math.max(2, Math.min(200, Math.floor(count)));
  const splits: number[] = [];
  for (let i = 1; i < n; i++) splits.push((duration * i) / n);
  return normalizeSplits(splits, duration);
}

/** 無音区間の中央を分割点として検出する */
export async function detectSilenceSplits(
  buffer: AudioBuffer,
  options: SilenceOptions,
  onProgress?: (ratio: number) => void,
): Promise<number[]> {
  const rate = buffer.sampleRate;
  const hop = Math.max(1, Math.round(rate * 0.01)); // 10ms
  const frames = Math.floor(buffer.length / hop);
  if (frames < 2) return [];

  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const rms = new Float32Array(frames);
  const chunk = 2000;
  for (let start = 0; start < frames; start += chunk) {
    const stop = Math.min(frames, start + chunk);
    for (let f = start; f < stop; f++) {
      const from = f * hop;
      const to = from + hop;
      let sum = 0;
      for (let c = 0; c < channels.length; c++) {
        const data = channels[c];
        for (let i = from; i < to; i++) {
          const v = data[i];
          sum += v * v;
        }
      }
      rms[f] = Math.sqrt(sum / (hop * channels.length));
    }
    onProgress?.(stop / frames);
    await nextFrame();
  }

  const threshold = Math.pow(10, options.thresholdDb / 20);
  const minSilenceFrames = Math.max(1, Math.round(options.minSilenceMs / 10));

  const candidates: number[] = [];
  let runStart = -1;
  for (let f = 0; f <= frames; f++) {
    const silent = f < frames && rms[f] < threshold;
    if (silent && runStart < 0) runStart = f;
    if (!silent && runStart >= 0) {
      if (f - runStart >= minSilenceFrames) {
        candidates.push((((runStart + f) / 2) * hop) / rate);
      }
      runStart = -1;
    }
  }

  const minSegment = Math.max(0.05, options.minSegmentMs / 1000);
  const duration = buffer.duration;
  const accepted: number[] = [];
  let last = 0;
  for (const point of candidates) {
    if (point - last < minSegment) continue;
    if (duration - point < minSegment) continue;
    accepted.push(point);
    last = point;
  }
  return normalizeSplits(accepted, duration);
}
