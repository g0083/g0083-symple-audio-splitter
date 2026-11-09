/**
 * MP3 のフレームインデックス。
 * 同一形式 (mp3 → mp3) のときは再エンコードせずフレーム単位で切り出すことで高速化する。
 */

export type Mp3FrameIndex = {
  offsets: Int32Array;
  endOffset: number;
  sampleRate: number;
  samplesPerFrame: number;
  frameCount: number;
};

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export function indexMp3(bytes: Uint8Array): Mp3FrameIndex | null {
  let pos = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    pos = 10 + size;
  }

  const offsets: number[] = [];
  let sampleRate = 0;
  let samplesPerFrame = 0;
  let endOffset = bytes.length;

  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff || (bytes[pos + 1] & 0xe0) !== 0xe0) {
      pos++;
      continue;
    }
    const b1 = bytes[pos + 1];
    const b2 = bytes[pos + 2];
    const version = (b1 >> 3) & 3;
    const layer = (b1 >> 1) & 3;
    const bitrateIndex = (b2 >> 4) & 0xf;
    const rateIndex = (b2 >> 2) & 3;
    const padding = (b2 >> 1) & 1;

    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) {
      pos++;
      continue;
    }

    const rate = SAMPLE_RATES[version][rateIndex];
    const spf = version === 3 ? 1152 : 576;
    const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex];
    const frameLength = Math.floor((spf / 8) * ((bitrate * 1000) / rate)) + padding;

    if (frameLength < 4 || pos + frameLength > bytes.length) break;

    if (!sampleRate) {
      sampleRate = rate;
      samplesPerFrame = spf;
    }
    offsets.push(pos);
    pos += frameLength;
    endOffset = pos;
  }

  if (offsets.length < 2 || !sampleRate) return null;

  return {
    offsets: Int32Array.from(offsets),
    endOffset,
    sampleRate,
    samplesPerFrame,
    frameCount: offsets.length,
  };
}

/** 指定時間範囲をフレーム境界に丸めてバイト列で切り出す */
export function sliceMp3(bytes: Uint8Array, index: Mp3FrameIndex, startSec: number, endSec: number): Uint8Array {
  const { offsets, sampleRate, samplesPerFrame, frameCount, endOffset } = index;
  const toFrame = (time: number) =>
    Math.max(0, Math.min(frameCount, Math.round((time * sampleRate) / samplesPerFrame)));

  let from = toFrame(startSec);
  let to = toFrame(endSec);
  if (to <= from) to = Math.min(frameCount, from + 1);
  if (from >= frameCount) from = frameCount - 1;

  const startByte = offsets[from];
  const endByte = to < frameCount ? offsets[to] : endOffset;
  return bytes.subarray(startByte, endByte);
}
