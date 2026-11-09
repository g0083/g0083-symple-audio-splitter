import { nextFrame } from './util';

export type Peaks = {
  min: Float32Array;
  max: Float32Array;
  /** 1 ピークあたりのサンプル数 */
  bucket: number;
  sampleRate: number;
};

/**
 * 波形表示用のピーク (min/max) を計算する。
 * 1 ピーク = bucket サンプル。UI を止めないよう定期的に yield する。
 */
export async function computePeaks(
  buffer: AudioBuffer,
  bucket = 256,
  onProgress?: (ratio: number) => void,
): Promise<Peaks> {
  const length = buffer.length;
  const count = Math.max(1, Math.ceil(length / bucket));
  const min = new Float32Array(count);
  const max = new Float32Array(count);
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  const chunkBuckets = 8192;
  for (let start = 0; start < count; start += chunkBuckets) {
    const stop = Math.min(count, start + chunkBuckets);
    for (let b = start; b < stop; b++) {
      const from = b * bucket;
      const to = Math.min(length, from + bucket);
      let lo = 0;
      let hi = 0;
      for (let c = 0; c < channels.length; c++) {
        const data = channels[c];
        for (let i = from; i < to; i++) {
          const v = data[i];
          if (v < lo) lo = v;
          else if (v > hi) hi = v;
        }
      }
      min[b] = lo;
      max[b] = hi;
    }
    onProgress?.(stop / count);
    await nextFrame();
  }

  return { min, max, bucket, sampleRate: buffer.sampleRate };
}
