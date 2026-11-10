/**
 * コンテナ解析だけで音声の基本情報を求める。
 * PCM デコードを行わないため、読み込み直後に UI を出せる。
 */

import { readBoxes } from './mp4boxes';
import { indexMp3, type Mp3FrameIndex } from './mp3frames';
import { indexMp4, type Mp4SampleIndex } from './mp4frames';
import { readWavInfo, type WavInfo } from './wav';

export type AudioInfo = {
  duration: number;
  sampleRate: number;
  channels: number;
  bitrate: number;
  mp3Index: Mp3FrameIndex | null;
  mp4Index: Mp4SampleIndex | null;
  wavInfo: WavInfo | null;
  /** m4a のサンプルを WebCodecs でデコードするための AudioSpecificConfig */
  audioSpecificConfig: Uint8Array | null;
  /** WebCodecs のコーデック文字列 */
  codec: 'mp3' | 'mp4a.40.2' | null;
};

/** m4a のサンプル長合計から時間を求める */
function mp4Duration(index: Mp4SampleIndex): number {
  let ticks = 0;
  for (let i = 0; i < index.count; i++) ticks += index.durations[i];
  return index.timescale > 0 ? ticks / index.timescale : 0;
}

function mp4BitrateOf(index: Mp4SampleIndex): number {
  let bytes = 0;
  let ticks = 0;
  for (let i = 0; i < index.count; i++) {
    bytes += index.sizes[i];
    ticks += index.durations[i];
  }
  const seconds = ticks / index.timescale;
  return seconds > 0 ? Math.round((bytes * 8) / 1000 / seconds) : 0;
}

function wavBitrateOf(info: WavInfo): number {
  const seconds = info.channels > 0 ? info.dataSize / (info.blockAlign || 1) / info.sampleRate : 0;
  return seconds > 0 ? Math.round((info.dataSize * 8) / 1000 / seconds) : 0;
}

function parseMp4(bytes: Uint8Array): AudioInfo | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(view, 0, bytes.byteLength);
  const moov = top.find((box) => box.type === 'moov');
  if (!moov) return null;

  let foundDuration = 0;
  let foundRate = 0;
  let foundChannels = 0;

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
    const durationTicks =
      version === 1
        ? view.getUint32(mdhd.contentStart + 24) * 4294967296 + view.getUint32(mdhd.contentStart + 28)
        : view.getUint32(mdhd.contentStart + 16);
    if (timescale > 0) {
      foundRate = timescale;
      foundDuration = durationTicks / timescale;
    }
    const stsd = readBoxes(view, mdia.contentStart, mdia.end);
    const minf = stsd.find((box) => box.type === 'minf');
    if (minf) {
      const stbl = readBoxes(view, minf.contentStart, minf.end).find((box) => box.type === 'stbl');
      const table = stbl ? readBoxes(view, stbl.contentStart, stbl.end).find((box) => box.type === 'stsd') : null;
      if (table) {
        const entryStart = table.contentStart + 8;
        foundChannels = view.getUint16(entryStart + 8 + 6 + 2 + 8);
      }
    }
    break;
  }

  const mp4Index = indexMp4(bytes);
  if (!mp4Index) return null;

  return {
    duration: mp4Index.count > 0 ? mp4Duration(mp4Index) : foundDuration,
    sampleRate: mp4Index.sampleRate || foundRate,
    channels: mp4Index.channels || foundChannels || 1,
    bitrate: mp4BitrateOf(mp4Index),
    mp3Index: null,
    mp4Index,
    wavInfo: null,
    audioSpecificConfig: mp4Index.audioSpecificConfig,
    codec: 'mp4a.40.2',
  };
}

/** ファイルのバイト列から音声情報を解析する。対応外の拡張子では null */
export function inspectAudio(bytes: Uint8Array, ext: string): AudioInfo | null {
  try {
    if (ext === 'mp3') {
      const mp3Index = indexMp3(bytes);
      if (!mp3Index) return null;
      const seconds = (mp3Index.frameCount * mp3Index.samplesPerFrame) / mp3Index.sampleRate;
      return {
        duration: seconds,
        sampleRate: mp3Index.sampleRate,
        channels: mp3Index.channels,
        bitrate: mp3Index.averageBitrate,
        mp3Index,
        mp4Index: null,
        wavInfo: null,
        audioSpecificConfig: null,
        codec: 'mp3',
      };
    }
    if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') return parseMp4(bytes);
    if (ext === 'wav') {
      const wavInfo = readWavInfo(bytes);
      if (!wavInfo) return null;
      const frames = Math.floor(wavInfo.dataSize / (wavInfo.blockAlign || 1));
      return {
        duration: frames / wavInfo.sampleRate,
        sampleRate: wavInfo.sampleRate,
        channels: wavInfo.channels,
        bitrate: wavBitrateOf(wavInfo),
        mp3Index: null,
        mp4Index: null,
        wavInfo,
        audioSpecificConfig: null,
        codec: null,
      };
    }
  } catch {
    /* 解析できなければフォールバックへ */
  }
  return null;
}
