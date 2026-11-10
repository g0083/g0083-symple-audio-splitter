function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** 書き出す WAV のビット深度。32 は 32bit float */
export type WavBits = 16 | 24 | 32;

export type WavInfo = {
  /** 1 = PCM, 3 = IEEE float */
  formatTag: 1 | 3;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
  /** data チャンクの先頭オフセット */
  dataStart: number;
  dataSize: number;
};

function parseFmt(view: DataView, start: number, size: number): Omit<WavInfo, 'dataStart' | 'dataSize'> | null {
  if (size < 16) return null;
  let formatTag = view.getUint16(start, true);
  const channels = view.getUint16(start + 2, true);
  const sampleRate = view.getUint32(start + 4, true);
  const blockAlign = view.getUint16(start + 12, true);
  const bitsPerSample = view.getUint16(start + 14, true);
  // WAVE_FORMAT_EXTENSIBLE は SubFormat GUID の先頭 2 バイトが実際の形式
  if (formatTag === 0xfffe && size >= 40) formatTag = view.getUint16(start + 24, true);
  if (formatTag !== 1 && formatTag !== 3) return null;
  if (channels <= 0 || sampleRate <= 0 || bitsPerSample <= 0) return null;
  return { formatTag, channels, sampleRate, bitsPerSample, blockAlign };
}

/** WAV のヘッダを読み取る。WAV でなければ null */
export function readWavInfo(bytes: Uint8Array): WavInfo | null {
  if (bytes.length < 44) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    view.getUint8(0) !== 0x52 ||
    view.getUint8(1) !== 0x49 ||
    view.getUint8(2) !== 0x46 ||
    view.getUint8(3) !== 0x46
  ) {
    return null;
  }
  if (
    view.getUint8(8) !== 0x57 ||
    view.getUint8(9) !== 0x41 ||
    view.getUint8(10) !== 0x56 ||
    view.getUint8(11) !== 0x45
  ) {
    return null;
  }

  let fmt: Omit<WavInfo, 'dataStart' | 'dataSize'> | null = null;
  let pos = 12;
  while (pos + 8 <= bytes.length) {
    const id = String.fromCharCode(
      view.getUint8(pos),
      view.getUint8(pos + 1),
      view.getUint8(pos + 2),
      view.getUint8(pos + 3),
    );
    const size = view.getUint32(pos + 4, true);
    const bodyStart = pos + 8;
    const bodyEnd = Math.min(bytes.length, bodyStart + size);
    if (id === 'fmt ') fmt = parseFmt(view, bodyStart, size);
    else if (id === 'data') {
      if (!fmt) return null;
      return { ...fmt, dataStart: bodyStart, dataSize: bodyEnd - bodyStart };
    }
    pos = bodyStart + size + (size % 2);
  }
  return null;
}

function writeHeader(
  view: DataView,
  formatTag: 1 | 3,
  channels: number,
  sampleRate: number,
  bitsPerSample: number,
  dataSize: number,
): void {
  const blockAlign = channels * (bitsPerSample / 8);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, formatTag, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);
}

/** 16/24bit PCM または 32bit float の WAV を組み立てる */
export function encodeWav(channels: Float32Array[], sampleRate: number, bits: WavBits = 16): Blob {
  const numChannels = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytesPerSample = bits / 8;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const formatTag: 1 | 3 = bits === 32 ? 3 : 1;
  writeHeader(view, formatTag, numChannels, sampleRate, bits, dataSize);

  let offset = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < numChannels; c++) {
      let sample = channels[c][i];
      if (sample > 1) sample = 1;
      else if (sample < -1) sample = -1;
      if (bits === 16) {
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      } else if (bits === 24) {
        const value = Math.round(sample < 0 ? sample * 0x800000 : sample * 0x7fffff);
        view.setUint8(offset, value & 0xff);
        view.setUint8(offset + 1, (value >> 8) & 0xff);
        view.setUint8(offset + 2, (value >> 16) & 0xff);
      } else {
        view.setFloat32(offset, sample, true);
      }
      offset += bytesPerSample;
    }
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * 元の WAV から指定時間範囲をフレーム境界で切り出す。
 * PCM をそのままコピーするためビット精度は元と完全に一致する。
 */
export function sliceWav(bytes: Uint8Array, info: WavInfo, startSec: number, endSec: number): Blob {
  const blockAlign = Math.max(1, info.blockAlign);
  const totalFrames = Math.floor(info.dataSize / blockAlign);
  const toFrame = (time: number) => Math.max(0, Math.min(totalFrames, Math.round(time * info.sampleRate)));
  let from = toFrame(startSec);
  let to = toFrame(endSec);
  if (to <= from) to = Math.min(totalFrames, from + 1);
  if (from >= totalFrames) from = Math.max(0, totalFrames - 1);

  const start = info.dataStart + from * blockAlign;
  const end = info.dataStart + to * blockAlign;
  const dataSize = Math.max(0, end - start);
  const header = new ArrayBuffer(44);
  writeHeader(
    new DataView(header),
    info.formatTag,
    info.channels,
    info.sampleRate,
    info.bitsPerSample,
    dataSize,
  );
  return new Blob([header, bytes.subarray(start, end) as unknown as BlobPart], { type: 'audio/wav' });
}
