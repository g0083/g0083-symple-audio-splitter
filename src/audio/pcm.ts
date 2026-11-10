/** PCM 操作 (切り出し・ダウンミックス・リサンプル) */

/** AudioBuffer から [startSample, endSample) を切り出してチャンネル配列を返す */
export function sliceChannels(
  buffer: AudioBuffer,
  startSample: number,
  endSample: number,
  maxChannels = 2,
): Float32Array[] {
  const from = Math.max(0, Math.min(buffer.length, Math.round(startSample)));
  const to = Math.max(from, Math.min(buffer.length, Math.round(endSample)));
  const length = to - from;
  const sourceChannels = buffer.numberOfChannels;

  if (sourceChannels <= maxChannels) {
    const out: Float32Array[] = [];
    for (let c = 0; c < sourceChannels; c++) {
      out.push(buffer.getChannelData(c).slice(from, to));
    }
    return out;
  }

  // 多チャンネルはステレオへダウンミックス
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (let c = 0; c < sourceChannels; c++) {
    const data = buffer.getChannelData(c);
    const target = c % 2 === 0 ? left : right;
    for (let i = 0; i < length; i++) target[i] += data[from + i];
  }
  const scale = 1 / Math.ceil(sourceChannels / 2);
  for (let i = 0; i < length; i++) {
    left[i] *= scale;
    right[i] *= scale;
  }
  return [left, right];
}

/** OfflineAudioContext を使ってリサンプルする */
export async function resampleChannels(
  channels: Float32Array[],
  fromRate: number,
  toRate: number,
): Promise<Float32Array[]> {
  if (fromRate === toRate) return channels;
  const length = channels[0].length;
  const targetLength = Math.max(1, Math.ceil((length * toRate) / fromRate));
  const context = new OfflineAudioContext(channels.length, targetLength, toRate);
  const buffer = context.createBuffer(channels.length, length, fromRate);
  for (let c = 0; c < channels.length; c++) buffer.copyToChannel(channels[c] as Float32Array<ArrayBuffer>, c);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  const out: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) out.push(rendered.getChannelData(c));
  return out;
}

/** lamejs が扱えるサンプルレート */
export const MP3_SAMPLE_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

export function nearestMp3SampleRate(rate: number): number {
  if (MP3_SAMPLE_RATES.includes(rate)) return rate;
  let best = 44100;
  let bestDiff = Infinity;
  for (const candidate of MP3_SAMPLE_RATES) {
    const diff = Math.abs(candidate - rate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best;
}

const MP3_BITRATES_MPEG1 = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_MPEG2 = [8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_BITRATES_MPEG25 = [8, 16, 24, 32, 40, 48, 56, 64];

/**
 * MP3 で実際に使えるビットレートに丸める。
 * 元の品質を下回らないよう、指定値以上で最も近いもの選ぶ (上限はそのレートの最大値)。
 */
export function mp3BitrateFor(bitrate: number, sampleRate: number): number {
  const ladder =
    sampleRate >= 32000 ? MP3_BITRATES_MPEG1 : sampleRate >= 16000 ? MP3_BITRATES_MPEG2 : MP3_BITRATES_MPEG25;
  for (const candidate of ladder) {
    if (candidate >= bitrate) return candidate;
  }
  return ladder[ladder.length - 1];
}
