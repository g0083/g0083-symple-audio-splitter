import type { AudioSource, OutputFormat } from '../types';
import type { Segment } from './segments';
import { encodeWav, sliceWav, type WavBits } from './wav';
import { encodeMp3 } from './mp3';
import { createAacEncoderSession, isAacSupported, type AacEncoderSession } from './aac';
import { encodeAacWithFFmpeg } from './ffmpeg';
import { sliceMp3 } from './mp3frames';
import { copyM4aSegment } from './m4acopy';
import { mp3BitrateFor, nearestMp3SampleRate, resampleChannels, sliceChannels } from './pcm';
import { blobPart, nextFrame } from './util';

export type ExportFile = {
  name: string;
  blob: Blob;
};

export type ExportOptions = {
  source: AudioSource;
  segments: Segment[];
  format: OutputFormat;
  /** 'original' の場合は元のビットレートを維持 (mp3/m4a はフレーム/サンプルコピー) */
  bitrate: number | 'original';
  /** WAV 出力のビット深度。'original' は元 WAV ならコピー、それ以外は 24bit */
  wavBits?: WavBits | 'original';
  onProgress?: (done: number, total: number, label: string) => void;
  onStatus?: (message: string) => void;
  isCancelled?: () => boolean;
};

export function buildFileName(base: string, index: number, total: number, ext: string): string {
  const pad = Math.max(2, String(total).length);
  return `${base}_${String(index + 1).padStart(pad, '0')}.${ext}`;
}

/** 形式ごとのビットレート範囲 (kbps) */
const MIN_BITRATE: Record<OutputFormat, number> = { mp3: 8, m4a: 16, wav: 0 };
const MAX_BITRATE: Record<OutputFormat, number> = { mp3: 320, m4a: 320, wav: 0 };

/**
 * '元のまま' を実際のビットレートに解決する。
 * 元ファイルのビットレートが分かる場合はそれに合わせ、形式の範囲に丸める。
 */
export function resolveOriginalBitrate(sourceBitrate: number, format: OutputFormat): number {
  const max = MAX_BITRATE[format];
  if (max <= 0) return sourceBitrate;
  const base = sourceBitrate > 0 ? sourceBitrate : 192;
  return Math.min(max, Math.max(MIN_BITRATE[format], base));
}

function resolveBitrate(bitrate: number | 'original', source: AudioSource, format: OutputFormat): number {
  return bitrate === 'original' ? resolveOriginalBitrate(source.bitrate, format) : bitrate;
}

/**
 * 実際にエンコーダへ渡すビットレート。
 * MP3 はサンプルレートごとに決まった階段しか選べないため、元の品質を下回らない値へ丸める。
 */
export function resolveEncodeBitrate(sourceBitrate: number, format: OutputFormat, sampleRate: number): number {
  const original = resolveOriginalBitrate(sourceBitrate, format);
  return format === 'mp3' ? mp3BitrateFor(original, nearestMp3SampleRate(sampleRate)) : original;
}

function resolveWavBits(wavBits: WavBits | 'original' | undefined): WavBits {
  return wavBits === undefined || wavBits === 'original' ? 24 : wavBits;
}

export async function exportSegments(options: ExportOptions): Promise<ExportFile[]> {
  const { source, segments, format, onProgress, onStatus, isCancelled } = options;
  const total = segments.length;
  const files: ExportFile[] = [];

  const canCopyMp3Frames =
    format === 'mp3' && source.ext === 'mp3' && source.mp3Index !== null && options.bitrate === 'original';

  const canCopyM4aSamples =
    format === 'm4a' && source.mp4Index !== null && options.bitrate === 'original';

  // WAV は元が WAV なら PCM をそのままコピーする（ビット深度も元のまま）
  const canCopyWav =
    format === 'wav' && source.wavInfo !== null && (options.wavBits ?? 'original') === 'original';

  const wavBits = resolveWavBits(options.wavBits);

  const bitrate = resolveBitrate(options.bitrate, source, format);
  const aacViaWebCodecs =
    format === 'm4a' && !canCopyM4aSamples
      ? await isAacSupported(source.sampleRate, Math.min(2, source.channels), bitrate)
      : false;

  if (format === 'm4a' && !aacViaWebCodecs && !canCopyM4aSamples) {
    onStatus?.('AAC エンコーダを読み込んでいます（初回のみ・数十MB）…');
  }

  // セグメントごとに AudioEncoder を作り直すと初期化コストが積み上がるため、
  // 同じ設定で書き出す間は 1 つのセッションを使い回す。
  const sessionRef: { current: AacEncoderSession | null } = { current: null };
  const getAacSession = async (): Promise<AacEncoderSession> => {
    if (!sessionRef.current) {
      sessionRef.current = await createAacEncoderSession(
        source.sampleRate,
        Math.min(2, source.channels),
        bitrate,
      );
    }
    return sessionRef.current;
  };

  try {
    for (const segment of segments) {
      if (isCancelled?.()) throw new DOMException('cancelled', 'AbortError');

      const name = buildFileName(source.name, segment.index, total, format);
      onProgress?.(segment.index, total, name);

      let blob: Blob;

      if (canCopyMp3Frames && source.mp3Index) {
        const bytes = sliceMp3(source.bytes, source.mp3Index, segment.start, segment.end);
        blob = new Blob([blobPart(bytes)], { type: 'audio/mpeg' });
      } else if (canCopyM4aSamples && source.mp4Index) {
        blob = await copyM4aSegment({
          bytes: source.bytes,
          index: source.mp4Index,
          startSec: segment.start,
          endSec: segment.end,
        });
      } else if (canCopyWav && source.wavInfo) {
        blob = sliceWav(source.bytes, source.wavInfo, segment.start, segment.end);
      } else {
        // PCM が必要になるのは再エンコード時だけ。元ファイルのデコードは初回のみ
        const buffer = await source.loadPcm();
        const startSample = Math.round(segment.start * source.sampleRate);
        const endSample = Math.round(segment.end * source.sampleRate);
        // WAV はチャンネル数を落とさず、そのまま書き出す
        let channels = sliceChannels(buffer, startSample, endSample, format === 'wav' ? source.channels : 2);

        if (format === 'wav') {
          blob = encodeWav(channels, source.sampleRate, wavBits);
        } else if (format === 'mp3') {
          const targetRate = nearestMp3SampleRate(source.sampleRate);
          if (targetRate !== source.sampleRate) {
            channels = await resampleChannels(channels, source.sampleRate, targetRate);
          }
          const targetBitrate = mp3BitrateFor(bitrate, targetRate);
          const data = await encodeMp3(channels, targetRate, targetBitrate);
          blob = new Blob([blobPart(data)], { type: 'audio/mpeg' });
        } else if (aacViaWebCodecs) {
          blob = await (await getAacSession()).encode(channels);
        } else {
          blob = await encodeAacWithFFmpeg(channels, source.sampleRate, bitrate, onStatus);
        }
      }

      files.push({ name, blob });
      onProgress?.(segment.index + 1, total, name);
      await nextFrame();
    }
  } finally {
    sessionRef.current?.close();
  }

  return files;
}
