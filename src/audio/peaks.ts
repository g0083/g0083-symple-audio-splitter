export type Peaks = {
  min: Float32Array;
  max: Float32Array;
  /** 1 ピークあたりのサンプル数 */
  bucket: number;
  sampleRate: number;
};

/** AudioBuffer からチャンネル配列を取り出す */
export function channelsOf(buffer: AudioBuffer): Float32Array[] {
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return channels;
}

/**
 * 波形表示用のピーク (min/max) を計算する。
 * 1 ピーク = bucket サンプル。
 *
 * 長い音源では全サンプルを走査するため、一定時間ごとにフレームを譲って
 * メインスレッドを塞がないようにする。Worker に渡すにはチャンネル全体の
 * コピーが必要で、30 分の音源では数百 MB の複製になり逆に遅くなるため
 * ここではメインスレッドで分割実行する。
 */
export async function computePeaks(
  buffer: AudioBuffer,
  bucket = 256,
  onProgress?: (ratio: number) => void,
): Promise<Peaks> {
  const channels = channelsOf(buffer);
  const length = channels[0]?.length ?? 0;
  const count = Math.max(1, Math.ceil(length / bucket));
  const min = new Float32Array(count);
  const max = new Float32Array(count);

  const BUDGET_MS = 8;
  let sliceStart = performance.now();
  for (let b = 0; b < count; b++) {
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

    if (performance.now() - sliceStart >= BUDGET_MS) {
      onProgress?.((b + 1) / count);
      await new Promise((resolve) => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }

  return { min, max, bucket, sampleRate: buffer.sampleRate };
}
