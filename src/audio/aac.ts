/**
 * AAC (m4a) エンコード。
 * 1) WebCodecs の AudioEncoder + mp4-muxer (高速・対応ブラウザのみ)
 * 2) ffmpeg.wasm (未対応ブラウザ向けフォールバック)
 *
 * AudioEncoder の生成にはコーデックの初期化コストがかかるため、
 * 同じ設定で複数セグメントを書き出すときは 1 つのインスタンスを使い回す。
 */

type WebCodecsAudioEncoder = {
  isConfigSupported(config: unknown): Promise<{ supported?: boolean }>;
  new (init: { output: (chunk: unknown, meta: unknown) => void; error: (error: Error) => void }): {
    configure(config: unknown): void;
    encode(data: unknown): void;
    flush(): Promise<void>;
    close(): void;
    readonly encodeQueueSize: number;
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

/** 同じ設定で連続して書き出すためのエンコーダ保持 */
export type AacEncoderSession = {
  encode(channels: Float32Array[]): Promise<Blob>;
  close(): void;
};

/**
 * 指定設定の AAC エンコーダセッションを作る。
 * セッション内では AudioEncoder を使い回すため、セグメント数が多いほど効果が出る。
 */
export async function createAacEncoderSession(
  sampleRate: number,
  numberOfChannels: number,
  bitrateKbps: number,
): Promise<AacEncoderSession> {
  const AudioEncoderCtor = getAudioEncoder();
  const AudioDataCtor = getAudioData();
  if (!AudioEncoderCtor || !AudioDataCtor) throw new Error('WebCodecs が利用できません');

  const { Muxer, ArrayBufferTarget } = await import('mp4-muxer');
  const numChannels = Math.min(2, numberOfChannels);

  let muxer: InstanceType<typeof Muxer> | null = null;
  let target: InstanceType<typeof ArrayBufferTarget> | null = null;
  let failure: Error | null = null;
  const waiters: (() => void)[] = [];
  const wake = (): void => {
    while (waiters.length > 0) waiters.pop()!();
  };

  const encoder = new AudioEncoderCtor({
    output: (chunk, meta) => {
      muxer?.addAudioChunk(chunk as EncodedAudioChunk, meta as EncodedAudioChunkMetadata);
      wake();
    },
    error: (error) => {
      failure = error;
      wake();
    },
  });

  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels: numChannels,
    bitrate: bitrateKbps * 1000,
  });

  const maxQueue = 8;
  const waitForQueue = async (): Promise<void> => {
    while (encoder.encodeQueueSize > maxQueue) {
      if (failure) throw failure;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };

  return {
    async encode(channels: Float32Array[]): Promise<Blob> {
      if (failure) throw failure;
      target = new ArrayBufferTarget();
      muxer = new Muxer({
        target,
        fastStart: 'in-memory',
        audio: { codec: 'aac', numberOfChannels: numChannels, sampleRate },
        firstTimestampBehavior: 'offset',
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
        await waitForQueue();
      }

      await encoder.flush();
      if (failure) throw failure;

      muxer.finalize();
      const buffer = target.buffer;
      muxer = null;
      target = null;
      return new Blob([buffer], { type: 'audio/mp4' });
    },

    close(): void {
      try {
        encoder.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/** 単発の AAC エンコード */
export async function encodeAac(
  channels: Float32Array[],
  sampleRate: number,
  bitrateKbps: number,
): Promise<Blob> {
  const session = await createAacEncoderSession(sampleRate, channels.length, bitrateKbps);
  try {
    return await session.encode(channels);
  } finally {
    session.close();
  }
}
