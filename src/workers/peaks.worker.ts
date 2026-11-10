/**
 * 波形ピークと無音検出用 RMS を Worker 内で作る。
 *
 * - 解析対象のバイト列は最初に一度だけ登録し、以降は sourceId で参照する
 * - ピークは表示範囲ぶんだけ作る。範囲の先頭フレームへシークしてデコードするため、
 *   長い音源でも拡大時は一瞬で終わる
 * - 進捗は 100ms ごとに分割して返すので、波形は左から順に埋まる
 * - RMS は全編が必要なので別ジョブでバックグラウンド実行する
 * - WebCodecs 非対応環境では unsupported を返し、メインスレッドが decodeAudioData にフォールバック
 */

import type {
  AnalysisJob,
  AnalysisMessage,
  RangeJob,
  RmsJob,
  SourceSpec,
} from '../audio/analysis';

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const scope = self as unknown as WorkerScope;

function post(message: AnalysisMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

/** 登録済みの解析対象 (バイト列は必須) */
type Loaded = SourceSpec & { bytes: Uint8Array };

const sources = new Map<number, Loaded>();
/** 読み込み中の解析対象。range/rms はこれが終わるまで待つ */
const loading = new Map<number, Promise<Loaded | null>>();

async function getSource(sourceId: number): Promise<Loaded> {
  const ready = sources.get(sourceId);
  if (ready) return ready;
  const pending = loading.get(sourceId);
  if (pending) {
    const loaded = await pending;
    if (loaded) return loaded;
  }
  throw new Error('no source');
}

/** コーデックごとのデコーダ遅延 (先頭で捨てるサンプル数) */
function initialSkip(source: Loaded): number {
  if (source.mp4) return Math.round((source.mp4.priming / source.mp4.timescale) * source.sampleRate);
  return source.mp3?.decoderDelay ?? 0;
}

/** 音声時間 (サンプル) から、その位置を含むフレーム番号を返す */
function frameAt(source: Loaded, sample: number): number {
  const mp4 = source.mp4;
  if (mp4) {
    let elapsed = 0;
    for (let i = 0; i < mp4.count; i++) {
      elapsed += mp4.durations[i];
      if ((elapsed / mp4.timescale) * source.sampleRate > sample) return i;
    }
    return mp4.count - 1;
  }
  const mp3 = source.mp3;
  if (mp3) return Math.max(0, Math.min(mp3.frameCount - 1, Math.floor(sample / mp3.samplesPerFrame)));
  return 0;
}

/** 指定フレームが始まる音声時間 (サンプル) */
function sampleAtFrame(source: Loaded, frame: number): number {
  const mp4 = source.mp4;
  if (mp4) {
    let ticks = 0;
    for (let i = 0; i < frame; i++) ticks += mp4.durations[i];
    return Math.round((ticks / mp4.timescale) * source.sampleRate);
  }
  const mp3 = source.mp3;
  return mp3 ? frame * mp3.samplesPerFrame : 0;
}

type RmsSink = { push(square: number): void };

type DecodeOptions = {
  /** 対象範囲 (絶対サンプル位置) */
  startSample: number;
  endSample: number;
  /** 範囲を bucket サンプルごとにまとめて通知する */
  bucket: number;
  onBucket: (lo: number, hi: number) => void;
  /** 途中経過を返す間隔 (ms) */
  onProgress?: () => void;
  rms?: RmsSink;
};

/**
 * 指定範囲をデコードして bucket ごとの min/max を返す。
 *
 * 範囲の先頭フレームまでシークし、そこから範囲の終端までデコードする。
 * 範囲より前のサンプルは捨てる。
 */
async function decodeRange(source: Loaded, options: DecodeOptions): Promise<void> {
  const channels = Math.min(2, Math.max(1, source.channels));
  const config: AudioDecoderConfig = {
    codec: source.codec!,
    sampleRate: source.sampleRate,
    numberOfChannels: channels,
  };
  if (source.asc) config.description = source.asc as unknown as BufferSource;

  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new Error('unsupported');

  const bucket = Math.max(1, Math.floor(options.bucket));
  const startSample = Math.max(0, Math.floor(options.startSample));
  const endSample = Math.max(startSample + 1, Math.ceil(options.endSample));

  const skipTotal = initialSkip(source);
  const mp4 = source.mp4;
  const mp3 = source.mp3;
  const total = mp4 ? mp4.count : mp3 ? mp3.frameCount : 0;
  if (total === 0) throw new Error('empty');

  // 先頭付近から数フレーム戻ってデコードを始める (前フレームの影響を避ける)
  const WARMUP = 4;
  const firstFrame = Math.max(0, frameAt(source, startSample) - WARMUP);
  const firstSample = sampleAtFrame(source, firstFrame);

  // デコーダ出力のうち、この位置より前は捨てる
  let discard = skipTotal + Math.max(0, startSample - firstSample);
  let position = 0; // デコード済みの音声サンプル数 (遅延込み)
  let emitPos = -1;

  // 1 ピークが複数フレームにまたがる場合はフレームを間引く。
  // 表示に必要な粒度しか要らないため、全体表示では大幅にコストが下がる。
  const frameSamples = mp4
    ? Math.round((mp4.durations[Math.min(firstFrame, total - 1)] / mp4.timescale) * source.sampleRate)
    : mp3
      ? mp3.samplesPerFrame
      : Math.max(1, Math.round(bucket));
  const step = Math.max(1, Math.floor(bucket / Math.max(1, frameSamples)));
  // 間引き時に 1 フレームのピークを引き伸ばす長さ
  const spanSamples = step > 1 ? step * frameSamples : 0;

  let bucketLo = 0;
  let bucketHi = 0;
  let lastProgress = performance.now();

  /** 指定バケットへ min/max を積む */
  const addToBucket = (lo: number, hi: number, bodyPos: number): void => {
    if (bodyPos < startSample || bodyPos >= endSample) return;
    const index = Math.floor((bodyPos - startSample) / bucket);
    if (index !== emitPos) {
      if (emitPos >= 0) options.onBucket(bucketLo, bucketHi);
      emitPos = index;
      bucketLo = 0;
      bucketHi = 0;
    }
    if (lo < bucketLo) bucketLo = lo;
    if (hi > bucketHi) bucketHi = hi;
  };

  /** 間引き時: 1 フレームのピークを step フレーム分の区間へ流し込む */
  const pushSpan = (lo: number, hi: number): void => {
    let remaining = spanSamples;
    while (remaining > 0) {
      if (discard > 0) {
        const take = Math.min(discard, remaining);
        discard -= take;
        position += take;
        remaining -= take;
        continue;
      }
      const bodyPos = position - skipTotal;
      if (bodyPos >= endSample) break;
      addToBucket(lo, hi, bodyPos);
      const bucketEnd = startSample + (Math.floor((bodyPos - startSample) / bucket) + 1) * bucket;
      const take = Math.max(1, Math.min(remaining, bucketEnd - bodyPos));
      position += take;
      remaining -= take;
    }
  };

  const scratch = new Float32Array(16384);
  const scratchRight = new Float32Array(16384);
  let failure: Error | null = null;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        const used = Math.min(channels, data.numberOfChannels);
        if (used <= 0) return;
        const full = data.numberOfFrames;
        const left = scratch.subarray(0, full);
        data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
        const right = used > 1 ? scratchRight.subarray(0, full) : null;
        if (right) data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });

        if (step > 1) {
          // 間引き時は 1 フレームのピークを step フレーム分の区間へ引き伸ばす
          let lo = 0;
          let hi = 0;
          for (let k = 0; k < full; k++) {
            const a = left[k];
            const b = right ? right[k] : a;
            if (a < lo) lo = a;
            if (a > hi) hi = a;
            if (b < lo) lo = b;
            else if (b > hi) hi = b;
          }
          pushSpan(lo, hi);
        } else {
          for (let i = 0; i < full; i++) {
            if (discard > 0) {
              discard--;
              position++;
              continue;
            }
            const bodyPos = position - skipTotal;
            position++;
            if (bodyPos >= endSample) continue;
            const a = left[i];
            const b = right ? right[i] : a;
            addToBucket(a < b ? a : b, a > b ? a : b, bodyPos);
            options.rms?.push(right ? (a * a + b * b) * 0.5 : a * a);
          }
        }

        if (options.onProgress) {
          const now = performance.now();
          if (now - lastProgress >= 100) {
            lastProgress = now;
            if (emitPos >= 0) {
              options.onBucket(bucketLo, bucketHi);
              bucketLo = 0;
              bucketHi = 0;
            }
            options.onProgress();
          }
        }
      } finally {
        data.close();
      }
    },
    error: (error) => {
      failure = error instanceof Error ? error : new Error(String(error));
    },
  });
  decoder.configure(config);

  const queueLimit = 256;
  const submit = async (chunk: EncodedAudioChunk): Promise<void> => {
    decoder.decode(chunk);
    if (decoder.decodeQueueSize > queueLimit) {
      await new Promise<void>((resolve) => {
        const onDequeue = (): void => {
          if (decoder.decodeQueueSize <= queueLimit >> 2) {
            decoder.removeEventListener('dequeue', onDequeue);
            resolve();
          }
        };
        decoder.addEventListener('dequeue', onDequeue);
      });
    }
  };

  if (mp4) {
    let timestamp = 0;
    for (let i = 0; i < total; i += step) {
      if (failure) break;
      if (i >= firstFrame && position - skipTotal >= endSample) break;
      if (i < firstFrame) {
        timestamp += Math.round((mp4.durations[i] / mp4.timescale) * 1_000_000);
        continue;
      }
      const duration = Math.round((mp4.durations[i] / mp4.timescale) * 1_000_000);
      await submit(
        new EncodedAudioChunk({
          type: 'key',
          timestamp,
          duration: duration * step,
          data: source.bytes.subarray(mp4.offsets[i], mp4.offsets[i] + mp4.sizes[i]),
        }),
      );
      timestamp += duration * step;
    }
  } else if (mp3) {
    const duration = Math.round((mp3.samplesPerFrame / mp3.sampleRate) * 1_000_000);
    for (let i = firstFrame; i < total; i += step) {
      if (failure || position - skipTotal >= endSample) break;
      const offset = mp3.offsets[i];
      const end = i + 1 < total ? mp3.offsets[i + 1] : mp3.endOffset;
      await submit(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: i * duration,
          duration: duration * step,
          data: source.bytes.subarray(offset, end),
        }),
      );
    }
  }

  if (!failure) {
    try {
      await decoder.flush();
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
  }
  try {
    decoder.close();
  } catch {
    /* already closed */
  }
  if (failure) throw failure as Error;
  if (emitPos >= 0) options.onBucket(bucketLo, bucketHi);
}

/** WAV の PCM から指定範囲のピークと RMS を読む */
function readWavRange(
  source: Loaded,
  startSample: number,
  endSample: number,
  bucket: number,
  rms: RmsSink | null,
  onBucket: (lo: number, hi: number) => void,
  onProgress?: () => void,
): void {
  const info = source.wav!;
  const channelCount = Math.max(1, info.channels);
  const blockAlign = Math.max(1, info.blockAlign);
  const totalFrames = Math.floor(info.dataSize / blockAlign);

  const bytes = source.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = Math.max(1, Math.round(info.bitsPerSample / 8));
  const isFloat = info.formatTag === 3;
  const dataEnd = Math.min(bytes.length, info.dataStart + info.dataSize);

  const readValue = (offset: number): number => {
    if (isFloat) return view.getFloat32(offset, true);
    if (bytesPerSample === 1) return (view.getUint8(offset) - 128) / 128;
    if (bytesPerSample === 2) return view.getInt16(offset, true) / 32768;
    if (bytesPerSample === 3) {
      const v = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16);
      return v / 8388608;
    }
    return view.getInt32(offset, true) / 2147483648;
  };

  const from = Math.max(0, Math.min(totalFrames, Math.floor(startSample)));
  const to = Math.max(from, Math.min(totalFrames, Math.ceil(endSample)));
  const count = Math.max(0, Math.ceil((to - from) / bucket));
  const scale = 1 / channelCount;
  let lastProgress = performance.now();

  for (let b = 0; b < count; b++) {
    const first = from + b * bucket;
    const last = Math.min(to, first + bucket);
    let lo = 0;
    let hi = 0;
    let base = info.dataStart + first * blockAlign;
    for (let f = first; f < last; f++) {
      let square = 0;
      for (let c = 0; c < channelCount; c++) {
        const offset = base + c * bytesPerSample;
        if (offset + bytesPerSample > dataEnd) break;
        const v = readValue(offset);
        if (v < lo) lo = v;
        if (v > hi) hi = v;
        square += v * v;
      }
      rms?.push(square * scale);
      base += blockAlign;
    }
    onBucket(lo, hi);

    if (onProgress && b % 128 === 0) {
      const now = performance.now();
      if (now - lastProgress >= 100) {
        lastProgress = now;
        onProgress();
      }
    }
  }
}

class RmsWriter {
  private readonly values: Float32Array;
  private index = 0;
  private sum = 0;
  private filled = 0;

  constructor(
    hops: number,
    private readonly hopSamples: number,
  ) {
    this.values = new Float32Array(Math.max(1, hops + 2));
  }

  push(square: number): void {
    this.sum += square;
    if (++this.filled >= this.hopSamples) {
      if (this.index < this.values.length) {
        this.values[this.index] = Math.sqrt(this.sum / this.hopSamples);
      }
      this.index++;
      this.sum = 0;
      this.filled = 0;
    }
  }

  finish(): Float32Array {
    if (this.filled > 0 && this.index < this.values.length) {
      this.values[this.index] = Math.sqrt(this.sum / this.filled);
      this.index++;
    }
    return this.values.slice(0, Math.min(this.index, this.values.length));
  }
}

/** 表示範囲のピークを作る */
async function runRange(job: RangeJob): Promise<void> {
  const source = await getSource(job.sourceId);

  const bucket = Math.max(1, Math.floor(job.bucket));
  const start = Math.max(0, Math.floor(job.startSample / bucket) * bucket);
  const end = Math.max(start + bucket, Math.ceil(job.endSample / bucket) * bucket);
  const count = Math.max(1, Math.ceil((end - start) / bucket));

  const min = new Float32Array(count);
  const max = new Float32Array(count);
  let produced = 0; // flush 済みのバケット数
  let current = 0; // 次に書くバケット番号
  let lastPost = performance.now();

  const flush = (): void => {
    if (current <= produced) return;
    const from = produced;
    const to = Math.min(current, count);
    produced = to;
    lastPost = performance.now();
    const minPart = min.slice(from, to);
    const maxPart = max.slice(from, to);
    post(
      {
        id: job.id,
        type: 'range-partial',
        startSample: start,
        bucket,
        offset: from,
        min: minPart,
        max: maxPart,
      },
      [minPart.buffer, maxPart.buffer],
    );
  };

  const onBucket = (lo: number, hi: number): void => {
    if (current < count) {
      min[current] = lo;
      max[current] = hi;
    }
    current++;
    if (performance.now() - lastPost >= 100) flush();
  };

  if (source.wav) {
    readWavRange(source, start, end, bucket, null, onBucket, flush);
  } else {
    if (!source.codec) throw new Error('unsupported');
    if (typeof AudioDecoder === 'undefined') throw new Error('unsupported');
    await decodeRange(source, {
      startSample: start,
      endSample: start + count * bucket,
      bucket,
      onBucket,
      onProgress: flush,
    });
  }

  flush();
  const valid = Math.min(current, count);
  const minOut = min.slice(0, valid);
  const maxOut = max.slice(0, valid);
  post(
    { id: job.id, type: 'range', startSample: start, bucket, min: minOut, max: maxOut },
    [minOut.buffer, maxOut.buffer],
  );
  post({ id: job.id, type: 'done' });
}

/** 全編の RMS を作る (無音検出用) */
async function runRms(job: RmsJob): Promise<void> {
  const source = await getSource(job.sourceId);

  const hopSamples = Math.max(1, Math.round(job.hopSeconds * source.sampleRate));
  const hops = Math.ceil(source.duration / job.hopSeconds) + 2;
  const writer = new RmsWriter(hops, hopSamples);
  const totalSamples = Math.ceil(source.duration * source.sampleRate);

  if (source.wav) {
    readWavRange(source, 0, totalSamples, Math.max(1, Math.ceil(totalSamples / 8192)), writer, () => {});
  } else {
    if (!source.codec) throw new Error('unsupported');
    if (typeof AudioDecoder === 'undefined') throw new Error('unsupported');
    await decodeRange(source, {
      startSample: 0,
      endSample: totalSamples,
      bucket: Math.max(1, Math.ceil(totalSamples / 8192)),
      onBucket: () => {},
      rms: writer,
    });
  }

  const out = writer.finish();
  post({ id: job.id, type: 'rms', hopSeconds: job.hopSeconds, rms: out }, [out.buffer]);
  post({ id: job.id, type: 'done' });
}

scope.onmessage = (event: MessageEvent) => {
  const job = event.data as AnalysisJob;
  void (async () => {
    if (job.type === 'source') {
      // バイト列は Worker 側で読む (41MB の複製とメインスレッドのブロックを避ける)
      const task = (async (): Promise<Loaded | null> => {
        try {
          const bytes = new Uint8Array(await job.spec.file.arrayBuffer());
          const loaded = { ...job.spec, bytes };
          sources.set(job.sourceId, loaded);
          return loaded;
        } catch {
          return null;
        } finally {
          loading.delete(job.sourceId);
        }
      })();
      loading.set(job.sourceId, task);
      await task;
      post({ id: job.id, type: 'done' });
      return;
    }
    if (job.type === 'release') {
      sources.delete(job.sourceId);
      post({ id: job.id, type: 'done' });
      return;
    }
    await (job.type === 'rms' ? runRms(job) : runRange(job));
  })().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'unsupported') post({ id: job.id, type: 'unsupported', reason: 'no decoder' });
    else post({ id: job.id, type: 'error', message });
  });
};






