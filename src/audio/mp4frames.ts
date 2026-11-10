/**
 * M4A (AAC in MP4) のサンプルインデックス。
 * 同一形式 (m4a → m4a) のときは再エンコードせずサンプル単位で切り出すことで高速化する。
 */

import { findBox, readBoxes } from './mp4boxes';

export type Mp4SampleIndex = {
  /** 各サンプルのファイル先頭からのバイトオフセット */
  offsets: Float64Array;
  /** 各サンプルのバイト長 */
  sizes: Uint32Array;
  /** 各サンプルの長さ (timescale 単位) */
  durations: Uint32Array;
  /** サンプル数 */
  count: number;
  /** mdhd の timescale */
  timescale: number;
  /** サンプルレート (Hz) */
  sampleRate: number;
  /** チャンネル数 */
  channels: number;
  /** AudioSpecificConfig (mp4-muxer に渡す decoderConfig.description) */
  audioSpecificConfig: Uint8Array;
  /**
   * 先頭で捨てるべきサンプル数 (AAC の priming)。
   * elst の media_time から求める。デコーダ出力と再生位置を揃えるために使う。
   */
  priming: number;
};

/** デスクリプタの可変長サイズを読む */
function readDescriptorSize(view: DataView, pos: number, end: number): { size: number; next: number } | null {
  let size = 0;
  let cursor = pos;
  for (let i = 0; i < 4; i++) {
    if (cursor >= end) return null;
    const byte = view.getUint8(cursor++);
    size = (size << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) return { size, next: cursor };
  }
  return null;
}

/** esds から AudioSpecificConfig (DecoderSpecificInfo) を取り出す */
function readAudioSpecificConfig(view: DataView, esdsStart: number, esdsEnd: number): Uint8Array | null {
  // full box の version/flags を飛ばす
  let pos = esdsStart + 4;
  while (pos + 2 <= esdsEnd) {
    const tag = view.getUint8(pos);
    const size = readDescriptorSize(view, pos + 1, esdsEnd);
    if (!size) return null;
    const bodyStart = size.next;
    const bodyEnd = bodyStart + size.size;
    if (bodyEnd > esdsEnd) return null;

    if (tag === 0x03) {
      // ES_Descriptor: ES_ID(2) + flags(1) の後に子デスクリプタ
      const flags = view.getUint8(bodyStart + 2);
      let child = bodyStart + 3;
      if (flags & 0x80) child += 2; // streamDependenceFlag
      if (flags & 0x40) {
        if (child >= bodyEnd) return null;
        child += 1 + view.getUint8(child); // URL_Flag
      }
      if (flags & 0x20) child += 2; // OCRstreamFlag
      pos = child;
      continue;
    }

    if (tag === 0x04) {
      // DecoderConfigDescriptor: objectTypeIndication(1) + streamType(1) + bufferSize(3) + maxBitrate(4) + avgBitrate(4)
      pos = bodyStart + 13;
      continue;
    }

    if (tag === 0x05) {
      return new Uint8Array(view.buffer, view.byteOffset + bodyStart, size.size).slice();
    }

    pos = bodyEnd;
  }
  return null;
}

/**
 * elst (edit list) の最初のエントリの media_time を読む。
 * AAC ではここがエンコーダ遅延 (priming) のサンプル数を表す。
 */
function readElstMediaTime(view: DataView, trakStart: number, trakEnd: number): number {
  const edts = findBox(view, trakStart, trakEnd, 'edts');
  if (!edts) return 0;
  const elst = findBox(view, edts.contentStart, edts.end, 'elst');
  if (!elst) return 0;
  const version = view.getUint8(elst.contentStart);
  const entries = view.getUint32(elst.contentStart + 4);
  if (entries === 0) return 0;
  const base = elst.contentStart + 8;
  if (version === 1) {
    if (base + 20 > elst.end) return 0;
    const mediaTime = view.getUint32(base + 8) * 4294967296 + view.getUint32(base + 12);
    return mediaTime > 0 ? mediaTime : 0;
  }
  if (base + 12 > elst.end) return 0;
  const mediaTime = view.getUint32(base + 4);
  return mediaTime > 0 ? mediaTime : 0;
}

/** stts を展開して各サンプルの長さを埋める */function readStts(view: DataView, start: number, end: number, count: number, durations: Uint32Array): boolean {
  const entries = view.getUint32(start + 4);
  let pos = start + 8;
  let sample = 0;
  for (let i = 0; i < entries; i++) {
    if (pos + 8 > end) return false;
    const sampleCount = view.getUint32(pos);
    const delta = view.getUint32(pos + 4);
    pos += 8;
    for (let n = 0; n < sampleCount && sample < count; n++) durations[sample++] = delta;
  }
  return sample === count;
}

/** stsz から各サンプルのバイト長を読む */
function readStsz(view: DataView, start: number, end: number, sizes: Uint32Array): number {
  const uniform = view.getUint32(start + 4);
  const count = view.getUint32(start + 8);
  if (uniform !== 0) {
    sizes.fill(uniform, 0, Math.min(count, sizes.length));
    return count;
  }
  let pos = start + 12;
  for (let i = 0; i < count && i < sizes.length; i++) {
    if (pos + 4 > end) return i;
    sizes[i] = view.getUint32(pos);
    pos += 4;
  }
  return count;
}

/** stsc + stco/co64 から各サンプルのバイトオフセットを求める */
function readSampleOffsets(
  view: DataView,
  stscStart: number,
  stscEnd: number,
  chunkOffsets: Float64Array,
  sizes: Uint32Array,
  offsets: Float64Array,
  count: number,
): boolean {
  const entries = view.getUint32(stscStart + 4);
  const firstChunk: number[] = [];
  const samplesPerChunk: number[] = [];
  let pos = stscStart + 8;
  for (let i = 0; i < entries; i++) {
    if (pos + 12 > stscEnd) return false;
    firstChunk.push(view.getUint32(pos));
    samplesPerChunk.push(view.getUint32(pos + 4));
    pos += 12;
  }
  if (entries === 0) return false;

  let sample = 0;
  for (let e = 0; e < entries; e++) {
    const from = firstChunk[e] - 1;
    const to = e + 1 < entries ? firstChunk[e + 1] - 1 : chunkOffsets.length;
    for (let chunk = from; chunk < to && sample < count; chunk++) {
      let offset = chunkOffsets[chunk];
      for (let n = 0; n < samplesPerChunk[e] && sample < count; n++) {
        offsets[sample] = offset;
        offset += sizes[sample];
        sample++;
      }
    }
  }
  return sample === count;
}

/** 音声トラックのサンプルインデックスを構築する。解析できなければ null */
export function indexMp4(bytes: Uint8Array): Mp4SampleIndex | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const moov = findBox(view, 0, bytes.byteLength, 'moov');
  if (!moov) return null;

  for (const trak of readBoxes(view, moov.contentStart, moov.end)) {
    if (trak.type !== 'trak') continue;

    const mdia = findBox(view, trak.contentStart, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = findBox(view, mdia.contentStart, mdia.end, 'hdlr');
    if (!hdlr) continue;
    const handler = String.fromCharCode(
      view.getUint8(hdlr.contentStart + 8),
      view.getUint8(hdlr.contentStart + 9),
      view.getUint8(hdlr.contentStart + 10),
      view.getUint8(hdlr.contentStart + 11),
    );
    if (handler !== 'soun') continue;

    const mdhd = findBox(view, mdia.contentStart, mdia.end, 'mdhd');
    if (!mdhd) continue;
    const mdhdVersion = view.getUint8(mdhd.contentStart);
    const timescale =
      mdhdVersion === 1 ? view.getUint32(mdhd.contentStart + 20) : view.getUint32(mdhd.contentStart + 12);
    if (timescale <= 0) continue;

    const minf = findBox(view, mdia.contentStart, mdia.end, 'minf');
    if (!minf) continue;
    const stbl = findBox(view, minf.contentStart, minf.end, 'stbl');
    if (!stbl) continue;

    // AAC の priming (エンコーダ遅延)。elst が無い場合は 0
    const priming = readElstMediaTime(view, trak.contentStart, trak.end);

    const stsd = findBox(view, stbl.contentStart, stbl.end, 'stsd');
    const stts = findBox(view, stbl.contentStart, stbl.end, 'stts');
    const stsz = findBox(view, stbl.contentStart, stbl.end, 'stsz');
    const stsc = findBox(view, stbl.contentStart, stbl.end, 'stsc');
    const stco = findBox(view, stbl.contentStart, stbl.end, 'stco');
    const co64 = stco ? null : findBox(view, stbl.contentStart, stbl.end, 'co64');
    if (!stsd || !stts || !stsz || !stsc || (!stco && !co64)) continue;

    // stsd: version/flags(4) + entry_count(4) + 最初のエントリ
    const entryCount = view.getUint32(stsd.contentStart + 4);
    if (entryCount === 0) continue;
    const entryStart = stsd.contentStart + 8;
    const entrySize = view.getUint32(entryStart);
    const entryEnd = Math.min(stsd.end, entryStart + entrySize);
    // AudioSampleEntry: 8(header) + 6(reserved) + 2(dataRefIndex) + 8(version/revision/vendor)
    //                   + 2(channelcount) + 2(samplesize) + 2(predefined) + 2(reserved)
    //                   + 4(samplerate 16.16)
    const channels = view.getUint16(entryStart + 8 + 6 + 2 + 8);
    const sampleRate = view.getUint32(entryStart + 8 + 6 + 2 + 8 + 2 + 2 + 2 + 2) >>> 16;
    const childStart = entryStart + 8 + 28;
    const esds = childStart < entryEnd ? findBox(view, childStart, entryEnd, 'esds') : null;
    if (!esds) continue;
    const asc = readAudioSpecificConfig(view, esds.contentStart, esds.end);
    if (!asc) continue;

    const count = view.getUint32(stsz.contentStart + 8);
    if (count === 0) continue;

    const sizes = new Uint32Array(count);
    const readCount = readStsz(view, stsz.contentStart, stsz.end, sizes);
    if (readCount !== count) continue;

    const durations = new Uint32Array(count);
    if (!readStts(view, stts.contentStart, stts.end, count, durations)) continue;

    const chunkCount = view.getUint32((stco ?? co64)!.contentStart + 4);
    const chunkOffsets = new Float64Array(chunkCount);
    if (stco) {
      let pos = stco.contentStart + 8;
      for (let i = 0; i < chunkCount; i++) {
        if (pos + 4 > stco.end) break;
        chunkOffsets[i] = view.getUint32(pos);
        pos += 4;
      }
    } else {
      let pos = co64!.contentStart + 8;
      for (let i = 0; i < chunkCount; i++) {
        if (pos + 8 > co64!.end) break;
        chunkOffsets[i] = view.getUint32(pos) * 4294967296 + view.getUint32(pos + 4);
        pos += 8;
      }
    }

    const offsets = new Float64Array(count);
    if (!readSampleOffsets(view, stsc.contentStart, stsc.end, chunkOffsets, sizes, offsets, count)) continue;

    return {
      offsets,
      sizes,
      durations,
      count,
      timescale,
      sampleRate: sampleRate || 44100,
      channels: channels || 2,
      audioSpecificConfig: asc,
      priming,
    };
  }
  return null;
}

/**
 * 音声トラックの平均ビットレート (kbps)。
 * サンプル長の合計から求めるため、コンテナのオーバーヘッドは含まない。
 */
export function mp4Bitrate(index: Mp4SampleIndex): number {
  let bytes = 0;
  let ticks = 0;
  for (let i = 0; i < index.count; i++) {
    bytes += index.sizes[i];
    ticks += index.durations[i];
  }
  const seconds = ticks / index.timescale;
  return seconds > 0 ? Math.round((bytes * 8) / 1000 / seconds) : 0;
}

/** 指定時刻に最も近いサンプル境界のインデックスを返す */
function frameAt(index: Mp4SampleIndex, timeSec: number): number {
  const target = Math.max(0, timeSec) * index.timescale;
  let elapsed = 0;
  for (let i = 0; i < index.count; i++) {
    const next = elapsed + index.durations[i];
    if (next >= target) {
      // サンプル i の内側。前後の境界のうち近い方を選ぶ
      return target - elapsed <= next - target ? i : i + 1;
    }
    elapsed = next;
  }
  return index.count;
}

/**
 * 指定時間範囲をサンプル境界に丸めて [from, to) のサンプル番号を返す。
 * 隣接する区間で同じ境界を共有するため、サンプルの重複や欠落は起きない。
 */
export function sampleRange(index: Mp4SampleIndex, startSec: number, endSec: number): { from: number; to: number } {
  const from = Math.min(index.count - 1, frameAt(index, startSec));
  const to = Math.max(from + 1, Math.min(index.count, frameAt(index, endSec)));
  return { from, to };
}
