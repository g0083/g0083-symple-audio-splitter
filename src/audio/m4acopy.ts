/**
 * 既存 m4a の AAC サンプルを再エンコードせずに切り出して新しい m4a を組み立てる。
 * エンコード処理が無いため、分割数によらずほぼ I/O 時間だけで完了する。
 */

import { sampleRange, type Mp4SampleIndex } from './mp4frames';

export type M4aCopyOptions = {
  /** 元ファイルのバイト列 */
  bytes: Uint8Array;
  index: Mp4SampleIndex;
  startSec: number;
  endSec: number;
};

export async function copyM4aSegment(options: M4aCopyOptions): Promise<Blob> {
  const { bytes, index, startSec, endSec } = options;
  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');

  const { from, to } = sampleRange(index, startSec, endSec);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    audio: { codec: 'aac', numberOfChannels: index.channels, sampleRate: index.sampleRate },
    firstTimestampBehavior: 'offset',
  });

  const meta = {
    decoderConfig: {
      codec: 'mp4a.40.2',
      description: index.audioSpecificConfig,
      numberOfChannels: index.channels,
      sampleRate: index.sampleRate,
    },
  };

  let timestamp = 0;
  for (let i = from; i < to; i++) {
    const offset = index.offsets[i];
    const size = index.sizes[i];
    const duration = (index.durations[i] / index.timescale) * 1_000_000;
    muxer.addAudioChunkRaw(bytes.subarray(offset, offset + size), 'key', timestamp, duration, meta);
    timestamp += duration;
  }

  muxer.finalize();
  return new Blob([target.buffer], { type: 'audio/mp4' });
}
