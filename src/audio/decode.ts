import { extOf } from './util';

export type DecodedAudio = {
  buffer: AudioBuffer;
  sampleRate: number;
  channels: number;
  duration: number;
};

const MP3_SAMPLE_RATES = [44100, 48000, 32000];

/** MP3 の最初のフレームヘッダからサンプルレートを読む */
function probeMp3Rate(bytes: Uint8Array): number | null {
  let pos = 0;
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size =
      ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    pos = 10 + size;
  }
  const limit = Math.min(bytes.length - 4, pos + 200_000);
  for (let i = pos; i < limit; i++) {
    if (bytes[i] !== 0xff || (bytes[i + 1] & 0xe0) !== 0xe0) continue;
    const version = (bytes[i + 1] >> 3) & 3;
    const layer = (bytes[i + 1] >> 1) & 3;
    const rateIndex = (bytes[i + 2] >> 2) & 3;
    if (layer !== 1 || rateIndex === 3 || version === 1) continue;
    const base = MP3_SAMPLE_RATES[rateIndex];
    if (version === 3) return base;
    if (version === 2) return base / 2;
    return base / 4;
  }
  return null;
}

type Box = { type: string; contentStart: number; end: number };

function readBoxes(view: DataView, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos);
    const type = String.fromCharCode(
      view.getUint8(pos + 4),
      view.getUint8(pos + 5),
      view.getUint8(pos + 6),
      view.getUint8(pos + 7),
    );
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = view.getUint32(pos + 8) * 4294967296 + view.getUint32(pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    boxes.push({ type, contentStart: pos + header, end: pos + size });
    pos += size;
  }
  return boxes;
}

/** MP4/M4A の mdhd からサンプルレートを読む */
function probeMp4Rate(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(view, 0, bytes.byteLength);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) return null;
  for (const trak of readBoxes(view, moov.contentStart, moov.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = readBoxes(view, trak.contentStart, trak.end).find((box) => box.type === 'mdia');
    if (!mdia) continue;
    const children = readBoxes(view, mdia.contentStart, mdia.end);
    const hdlr = children.find((box) => box.type === 'hdlr');
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      view.getUint8(hdlr.contentStart + 8),
      view.getUint8(hdlr.contentStart + 9),
      view.getUint8(hdlr.contentStart + 10),
      view.getUint8(hdlr.contentStart + 11),
    );
    if (handler !== 'soun') continue;
    const mdhd = children.find((box) => box.type === 'mdhd');
    if (!mdhd) continue;
    const version = view.getUint8(mdhd.contentStart);
    const timescale =
      version === 1 ? view.getUint32(mdhd.contentStart + 20) : view.getUint32(mdhd.contentStart + 12);
    if (timescale > 0) return timescale;
  }
  return null;
}

export function probeSampleRate(bytes: Uint8Array, ext: string): number | null {
  try {
    if (ext === 'mp3') return probeMp3Rate(bytes);
    if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') return probeMp4Rate(bytes);
  } catch {
    /* 解析できなければ既定値を使う */
  }
  return null;
}

/**
 * 音声ファイルを PCM にデコードする。
 * 元のサンプルレートを維持するため、判明したレートで OfflineAudioContext を作る。
 */
export async function decodeAudioFile(file: File): Promise<{ bytes: Uint8Array; decoded: DecodedAudio }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const ext = extOf(file.name);
  const probed = probeSampleRate(bytes, ext);
  const rate = probed && probed >= 8000 && probed <= 96000 ? probed : 48000;

  const context = new OfflineAudioContext(1, 1, rate);
  // decodeAudioData は ArrayBuffer を detach するためコピーを渡す
  const copy = bytes.slice().buffer;
  const buffer = await context.decodeAudioData(copy);

  return {
    bytes,
    decoded: {
      buffer,
      sampleRate: buffer.sampleRate,
      channels: buffer.numberOfChannels,
      duration: buffer.duration,
    },
  };
}
