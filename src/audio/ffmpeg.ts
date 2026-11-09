import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import ffmpegWorkerUrl from '@ffmpeg/ffmpeg/worker?worker&url';
import { encodeWav } from './wav';
import { blobPart } from './util';

const CORE_VERSION = '0.12.10';
const CORE_BASES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];

let instance: Promise<FFmpeg> | null = null;

export type FFmpegStatus = (message: string) => void;

async function createFFmpeg(onStatus?: FFmpegStatus): Promise<FFmpeg> {
  let lastError: unknown = null;
  for (const base of CORE_BASES) {
    try {
      onStatus?.('エンコーダを準備しています…');
      const coreURL = await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript');
      const wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm');
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ classWorkerURL: ffmpegWorkerUrl, coreURL, wasmURL });
      return ffmpeg;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('ffmpeg.wasm を読み込めませんでした (ネットワークを確認してください)');
}

export function loadFFmpeg(onStatus?: FFmpegStatus): Promise<FFmpeg> {
  if (!instance) {
    instance = createFFmpeg(onStatus).catch((error) => {
      instance = null;
      throw error;
    });
  }
  return instance;
}

/** ffmpeg.wasm で AAC (m4a) にエンコードする */
export async function encodeAacWithFFmpeg(
  channels: Float32Array[],
  sampleRate: number,
  bitrate: number,
  onStatus?: FFmpegStatus,
): Promise<Blob> {
  const ffmpeg = await loadFFmpeg(onStatus);
  const wav = encodeWav(channels, sampleRate);
  const input = new Uint8Array(await wav.arrayBuffer());

  await ffmpeg.writeFile('in.wav', input);
  const code = await ffmpeg.exec([
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    'in.wav',
    '-c:a',
    'aac',
    '-b:a',
    `${bitrate}k`,
    '-f',
    'ipod',
    'out.m4a',
  ]);

  if (code !== 0) {
    await ffmpeg.deleteFile('in.wav').catch(() => undefined);
    throw new Error('ffmpeg でのエンコードに失敗しました');
  }

  const output = await ffmpeg.readFile('out.m4a');
  await ffmpeg.deleteFile('in.wav').catch(() => undefined);
  await ffmpeg.deleteFile('out.m4a').catch(() => undefined);

  if (typeof output === 'string') throw new Error('ffmpeg の出力を読み取れませんでした');
  return new Blob([blobPart(output)], { type: 'audio/mp4' });
}
