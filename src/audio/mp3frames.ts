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
  /** フレームヘッダから求めた平均ビットレート (kbps) */
  averageBitrate: number;
  /** チャンネル数 (1 or 2) */
  channels: number;
  /**
   * 先頭で捨てるべきサンプル数 (デコーダ遅延)。
   * Xing ヘッダフレーム + LAME タグの encoder delay + デコーダ固有の遅延。
   * WebCodecs でデコードした PCM と再生位置を揃えるために使う。
   */
  decoderDelay: number;
  /** 先頭の Xing/Info (タグ) フレーム数 */
  tagFrames: number;
};

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** MP3 デコーダ (Chrome / ffmpeg) 固有の遅延サンプル数 */
const DECODER_DELAY = 529;

/**
 * 最初のフレームが Xing/Info (VBR ヘッダ) かを判定し、
 * LAME タグの encoder delay を読む。
 * LAME タグは "LAME" の 21 バイト後に delay/padding が 3 バイトずつ入る。
 */
function readTagFrame(bytes: Uint8Array, frameOffset: number, frameLength: number): { tagFrame: boolean; delay: number } {
  const end = Math.min(bytes.length, frameOffset + frameLength);
  let tagStart = -1;
  for (let i = frameOffset; i + 4 <= end; i++) {
    if (bytes[i] === 0x58 && bytes[i + 1] === 0x69 && bytes[i + 2] === 0x6e && bytes[i + 3] === 0x67) {
      tagStart = i; // Xing
      break;
    }
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x6e && bytes[i + 2] === 0x66 && bytes[i + 3] === 0x6f) {
      tagStart = i; // Info
      break;
    }
  }
  if (tagStart < 0) return { tagFrame: false, delay: 0 };

  // Xing ヘッダ: 4(magic) + 4(flags) + 任意フィールド
  const flags =
    (bytes[tagStart + 4] << 24) | (bytes[tagStart + 5] << 16) | (bytes[tagStart + 6] << 8) | bytes[tagStart + 7];
  let pos = tagStart + 8;
  if (flags & 1) pos += 4; // frames
  if (flags & 2) pos += 4; // bytes
  if (flags & 4) pos += 100; // TOC
  if (flags & 8) pos += 4; // quality
  if (pos + 24 > end) return { tagFrame: true, delay: 0 };
  // LAME タグ: encoder string 9 バイトの後、21 バイト目から delay(12bit)+padding(12bit)
  const delayPos = pos + 21;
  if (delayPos + 3 > end) return { tagFrame: true, delay: 0 };
  return { tagFrame: true, delay: (bytes[delayPos] << 4) | (bytes[delayPos + 1] >> 4) };
}

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
  let channels = 2;
  let endOffset = bytes.length;
  let totalBits = 0;
  let tagFrames = 0;
  let encoderDelay = 0;

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
      // チャンネルモード: 0=stereo, 1=joint stereo, 2=dual, 3=mono
      const mode = (bytes[pos + 3] >> 6) & 3;
      channels = mode === 3 ? 1 : 2;
      const tag = readTagFrame(bytes, pos, frameLength);
      encoderDelay = tag.delay;
      if (tag.tagFrame) tagFrames++;
    }
    offsets.push(pos);
    totalBits += frameLength * 8;
    pos += frameLength;
    endOffset = pos;
  }

  if (offsets.length < 2 || !sampleRate) return null;

  const seconds = (offsets.length * samplesPerFrame) / sampleRate;
  const averageBitrate = seconds > 0 ? Math.round(totalBits / 1000 / seconds) : 0;

  // Xing ヘッダのフレーム自体は音声ではないので、デコード時の先頭スキップに含める
  const decoderDelay = tagFrames * samplesPerFrame + (encoderDelay > 0 ? encoderDelay + DECODER_DELAY : 0);

  return {
    offsets: Int32Array.from(offsets),
    endOffset,
    sampleRate,
    samplesPerFrame,
    frameCount: offsets.length,
    averageBitrate,
    channels,
    decoderDelay,
    tagFrames,
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
