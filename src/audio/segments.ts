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

/**
 * 無音区間の中央を分割点として検出する。
 * 10ms ごとの RMS を渡す方式にすることで、PCM の再走査を避ける。
 */
export function splitsFromRms(
  rms: Float32Array,
  hopSeconds: number,
  duration: number,
  options: SilenceOptions,
): number[] {
  if (rms.length < 2) return [];
  const hopMs = hopSeconds * 1000;
  const threshold = Math.pow(10, options.thresholdDb / 20);
  const minSilenceFrames = Math.max(1, Math.round(options.minSilenceMs / hopMs));

  const candidates: number[] = [];
  let runStart = -1;
  for (let f = 0; f <= rms.length; f++) {
    const silent = f < rms.length && rms[f] < threshold;
    if (silent && runStart < 0) runStart = f;
    if (!silent && runStart >= 0) {
      if (f - runStart >= minSilenceFrames) {
        candidates.push(((runStart + f) / 2) * hopSeconds);
      }
      runStart = -1;
    }
  }

  return filterSplits(candidates, duration, options.minSegmentMs);
}

function filterSplits(candidates: number[], duration: number, minSegmentMs: number): number[] {
  const minSegment = Math.max(0.05, minSegmentMs / 1000);
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

/**
 * 無音区間の中央を分割点として検出する。
 * 長い音源でもメインスレッドを塞がないよう、一定時間ごとにフレームを譲る。
 */
export async function detectSilenceSplits(
  buffer: AudioBuffer,
  options: SilenceOptions,
  onProgress?: (ratio: number) => void,
): Promise<number[]> {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  const rate = buffer.sampleRate;
  const duration = buffer.duration;
  const hop = Math.max(1, Math.round(rate * 0.01)); // 10ms
  const length = channels[0]?.length ?? 0;
  const frames = Math.floor(length / hop);
  if (frames < 2) return [];

  const rms = new Float32Array(frames);
  const BUDGET_MS = 8;
  let sliceStart = performance.now();
  for (let f = 0; f < frames; f++) {
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

    if (performance.now() - sliceStart >= BUDGET_MS) {
      onProgress?.((f + 1) / frames);
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }

  return splitsFromRms(rms, 0.01, duration, options);
}
