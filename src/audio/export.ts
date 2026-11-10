import type { AudioSource, OutputFormat } from '../types';
import type { Segment } from './segments';
import { encodeWav } from './wav';
import { encodeMp3 } from './mp3';
import { createAacEncoderSession, isAacSupported, type AacEncoderSession } from './aac';
import { encodeAacWithFFmpeg } from './ffmpeg';
import { sliceMp3 } from './mp3frames';
import { copyM4aSegment } from './m4acopy';
import { nearestMp3SampleRate, resampleChannels, sliceChannels } from './pcm';
import { blobPart, nextFrame } from './util';

export type ExportFile = {
  name: string;
  blob: Blob;
};

export type ExportOptions = {
  source: AudioSource;
  segments: Segment[];
  format: OutputFormat;
  /** 'original' の場合は元のビットレートを維持 (mp3 はフレームコピー) */
  bitrate: number | 'original';
  onProgress?: (done: number, total: number, label: string) => void;
  onStatus?: (message: string) => void;
  isCancelled?: () => boolean;
};

export function buildFileName(base: string, index: number, total: number, ext: string): string {
  const pad = Math.max(2, String(total).length);
  return `${base}_${String(index + 1).padStart(pad, '0')}.${ext}`;
}

function resolveBitrate(bitrate: number | 'original'): number {
  return bitrate === 'original' ? 192 : bitrate;
}

export async function exportSegments(options: ExportOptions): Promise<ExportFile[]> {
  const { source, segments, format, onProgress, onStatus, isCancelled } = options;
  const total = segments.length;
  const files: ExportFile[] = [];

  const canCopyMp3Frames =
    format === 'mp3' && source.ext === 'mp3' && source.mp3Index !== null && options.bitrate === 'original';

  const canCopyM4aSamples =
    format === 'm4a' && source.mp4Index !== null && options.bitrate === 'original';

  const bitrate = resolveBitrate(options.bitrate);
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
      } else {
        const startSample = Math.round(segment.start * source.sampleRate);
        const endSample = Math.round(segment.end * source.sampleRate);
        let channels = sliceChannels(source.buffer, startSample, endSample, 2);

        if (format === 'wav') {
          blob = encodeWav(channels, source.sampleRate);
        } else if (format === 'mp3') {
          const targetRate = nearestMp3SampleRate(source.sampleRate);
          if (targetRate !== source.sampleRate) {
            channels = await resampleChannels(channels, source.sampleRate, targetRate);
          }
          const data = await encodeMp3(channels, targetRate, bitrate);
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
