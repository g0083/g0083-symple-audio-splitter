/**
 * AAC (m4a) エンコード。
 * 1) WebCodecs の AudioEncoder + mp4-muxer (高速・対応ブラウザのみ)
 * 2) ffmpeg.wasm (未対応ブラウザ向けフォールバック)
 */

type WebCodecsAudioEncoder = {
  isConfigSupported(config: unknown): Promise<{ supported?: boolean }>;
  new (init: { output: (chunk: unknown, meta: unknown) => void; error: (error: Error) => void }): {
    configure(config: unknown): void;
    encode(data: unknown): void;
    flush(): Promise<void>;
    close(): void;
  };
};

type WebCodecsAudioData = new (init: {
  format: string;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  data: Float32Array;
}) => { close(): void };

function getAudioEncoder(): WebCodecsAudioEncoder | null {
  const ctor = (globalThis as Record<string, unknown>).AudioEncoder as WebCodecsAudioEncoder | undefined;
  return ctor ?? null;
}

function getAudioData(): WebCodecsAudioData | null {
  const ctor = (globalThis as Record<string, unknown>).AudioData as WebCodecsAudioData | undefined;
  return ctor ?? null;
}

export function hasWebCodecsAac(): boolean {
  return getAudioEncoder() !== null && getAudioData() !== null;
}

export async function isAacSupported(
  sampleRate: number,
  numberOfChannels: number,
  bitrateKbps: number,
): Promise<boolean> {
  const encoder = getAudioEncoder();
  if (!encoder) return false;
  try {
    const result = await encoder.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate,
      numberOfChannels,
      bitrate: bitrateKbps * 1000,
    });
    return result?.supported === true;
  } catch {
    return false;
  }
}

export async function encodeAac(
  channels: Float32Array[],
  sampleRate: number,
  bitrateKbps: number,
): Promise<Blob> {
  const AudioEncoderCtor = getAudioEncoder();
  const AudioDataCtor = getAudioData();
  if (!AudioEncoderCtor || !AudioDataCtor) throw new Error('WebCodecs が利用できません');

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const numChannels = Math.min(2, channels.length);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({
    target,
    fastStart: 'in-memory',
    audio: { codec: 'aac', numberOfChannels: numChannels, sampleRate },
    firstTimestampBehavior: 'offset',
  });

  let failure: Error | null = null;
  const encoder = new AudioEncoderCtor({
    output: (chunk, meta) => {
      muxer.addAudioChunk(chunk as EncodedAudioChunk, meta as EncodedAudioChunkMetadata);
    },
    error: (error) => {
      failure = error;
    },
  });

  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: numChannels,
    bitrate: bitrateKbps * 1000,
  });

  const total = channels[0].length;
  const frameSize = 8192;
  for (let offset = 0; offset < total; offset += frameSize) {
    const frames = Math.min(frameSize, total - offset);
    const planar = new Float32Array(frames * numChannels);
    for (let c = 0; c < numChannels; c++) {
      planar.set(channels[c].subarray(offset, offset + frames), c * frames);
    }
    const audioData = new AudioDataCtor({
      format: 'f32-planar',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels: numChannels,
      timestamp: Math.round((offset / sampleRate) * 1_000_000),
      data: planar,
    });
    encoder.encode(audioData);
    audioData.close();
    if (failure) throw failure;
  }

  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  muxer.finalize();
  return new Blob([target.buffer], { type: 'audio/mp4' });
}
