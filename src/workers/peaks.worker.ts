/**
 * 波形ピークと無音検出用 RMS を Worker 内で作る。
 *
 * - M4A (AAC) / MP3 は WebCodecs の AudioDecoder でストリームデコード
 * - WAV は PCM をそのまま走査（デコード不要）
 * - 長い音源では間引いた粗いパスで全体の形を先に出し、続けて精密パスで上書きする
 * - WebCodecs 非対応環境では unsupported を返し、メインスレッドが decodeAudioData にフォールバック
 *
 * 結果は一定量ごとに分割して送るため、メインスレッドは逐次描画できる。
 */

import type { AnalysisJob, AnalysisMessage } from '../audio/analysis';

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

const scope = self as unknown as WorkerScope;

function post(message: AnalysisMessage, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

const MIN_CHUNK = 4096;
const POST_INTERVAL_MS = 100;
const RMS_HOP_SECONDS = 0.01;

/** bucket 単位の min/max を積み、一定量ごとにメインスレッドへ送る */
class PeakWriter {
  readonly count: number;
  private readonly min: Float32Array;
  private readonly max: Float32Array;
  private index = 0;
  private lo = 0;
  private hi = 0;
  private filled = 0;
  private postStart = 0;
  private lastPost = performance.now();

  constructor(
    private readonly id: number,
    samples: number,
    private readonly bucket: number,
  ) {
    this.count = Math.max(1, Math.ceil(samples / bucket) + 1);
    this.min = new Float32Array(this.count);
    this.max = new Float32Array(this.count);
  }

  /** 1 サンプルずつ積む */
  push(lo: number, hi: number): void {
    if (lo < this.lo) this.lo = lo;
    if (hi > this.hi) this.hi = hi;
    this.filled++;
    if (this.filled >= this.bucket) this.flushBucket();
  }

  /** 同じピークを n サンプル分まとめて積む (粗いパス用) */
  pushSpan(lo: number, hi: number, n: number): void {
    let remain = n;
    while (remain > 0) {
      const take = Math.min(remain, this.bucket - this.filled);
      if (lo < this.lo) this.lo = lo;
      if (hi > this.hi) this.hi = hi;
      this.filled += take;
      remain -= take;
      if (this.filled >= this.bucket) this.flushBucket();
    }
  }

  private flushBucket(): void {
    if (this.index < this.count) {
      this.min[this.index] = this.lo;
      this.max[this.index] = this.hi;
    }
    this.index++;
    this.filled = 0;
    this.lo = 0;
    this.hi = 0;
    this.maybePost(false);
  }

  private maybePost(force: boolean): void {
    const end = Math.min(this.count, this.index);
    if (end <= this.postStart) return;
    const now = performance.now();
    if (!force && end - this.postStart < MIN_CHUNK && now - this.lastPost < POST_INTERVAL_MS) return;
    const minOut = this.min.slice(this.postStart, end);
    const maxOut = this.max.slice(this.postStart, end);
    post(
      { id: this.id, type: 'peaks', start: this.postStart, min: minOut, max: maxOut },
      [minOut.buffer, maxOut.buffer],
    );
    this.postStart = end;
    this.lastPost = now;
  }

  finish(): void {
    if (this.filled > 0 && this.index < this.count) {
      this.min[this.index] = this.lo;
      this.max[this.index] = this.hi;
      this.index++;
    }
    this.maybePost(true);
  }

  get peakCount(): number {
    return Math.min(this.count, this.index);
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

  /** 1 サンプル分の二乗値を積む (端数はそのまま次のホップへ持ち越す) */
  pushSquare(square: number): void {
    this.sum += square;
    this.filled++;
    if (this.filled >= this.hopSamples) {
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

/** コーデックごとのデコーダ遅延 (先頭で捨てるサンプル数) */
function initialSkip(job: AnalysisJob): number {
  if (job.mp4) return Math.round((job.mp4.priming / job.mp4.timescale) * job.sampleRate);
  return job.mp3?.decoderDelay ?? 0;
}

/**
 * WebCodecs でデコードしてピークを積む。
 * step > 1 のときは step フレームに 1 個だけデコードし、そのピークを
 * 飛ばした区間へ引き伸ばして粗い波形にする。
 */
async function decodePass(
  job: AnalysisJob,
  peaks: PeakWriter,
  rms: RmsWriter | null,
  step: number,
): Promise<void> {
  const channels = Math.min(2, Math.max(1, job.channels));
  const config: AudioDecoderConfig = {
    codec: job.codec!,
    sampleRate: job.sampleRate,
    numberOfChannels: channels,
  };
  if (job.asc) config.description = job.asc as unknown as BufferSource;

  const support = await AudioDecoder.isConfigSupported(config).catch(() => null);
  if (!support?.supported) throw new Error('unsupported');

  let skip = initialSkip(job);
  const scratch = new Float32Array(16384);
  const scratchRight = new Float32Array(16384);
  let failure: Error | null = null;

  const decoder = new AudioDecoder({
    output: (data) => {
      try {
        let frames = data.numberOfFrames;
        const used = Math.min(channels, data.numberOfChannels);
        if (used <= 0) return;
        let offset = 0;
        if (skip > 0) {
          offset = Math.min(skip, frames);
          skip -= offset;
          frames -= offset;
        }
        if (frames <= 0) return;

        let lo = 0;
        let hi = 0;
        const rmsSink = rms;
        if (used === 1) {
          const plane = scratch.subarray(0, data.numberOfFrames);
          data.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
          for (let i = offset; i < offset + frames; i++) {
            const v = plane[i];
            if (v < lo) lo = v;
            else if (v > hi) hi = v;
            if (step === 1) peaks.push(v, v);
            rmsSink?.pushSquare(v * v);
          }
        } else {
          const full = data.numberOfFrames;
          const left = scratch.subarray(0, full);
          const right = scratchRight.subarray(0, full);
          data.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
          data.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
          for (let i = offset; i < offset + frames; i++) {
            const a = left[i];
            const b = right[i];
            const fl = a < b ? a : b;
            const fh = a > b ? a : b;
            if (fl < lo) lo = fl;
            if (fh > hi) hi = fh;
            if (step === 1) peaks.push(fl, fh);
            rmsSink?.pushSquare((a * a + b * b) * 0.5);
          }
        }

        if (step !== 1) {
          // 粗いパス: このフレームのピークを step フレーム分の長さに引き伸ばす
          peaks.pushSpan(lo, hi, frames * step);
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

  const mp4 = job.mp4;
  const mp3 = job.mp3;
  const frames = mp4 ? mp4.count : mp3 ? mp3.frameCount : 0;

  if (mp4) {
    let timestamp = 0;
    for (let i = 0; i < frames; i++) {
      if (failure) break;
      const duration = Math.round((mp4.durations[i] / mp4.timescale) * 1_000_000);
      if (i % step === 0) {
        await submit(
          new EncodedAudioChunk({
            type: 'key',
            timestamp,
            duration,
            data: job.bytes.subarray(mp4.offsets[i], mp4.offsets[i] + mp4.sizes[i]),
          }),
        );
      }
      timestamp += duration;
    }
  } else if (mp3) {
    const duration = Math.round((mp3.samplesPerFrame / mp3.sampleRate) * 1_000_000);
    for (let i = 0; i < frames; i++) {
      if (failure) break;
      if (i % step !== 0) continue;
      const offset = mp3.offsets[i];
      const end = i + 1 < frames ? mp3.offsets[i + 1] : mp3.endOffset;
      await submit(
        new EncodedAudioChunk({ type: 'key', timestamp: i * duration, duration, data: job.bytes.subarray(offset, end) }),
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
}

/** WAV の PCM を直接走査する */
function readWav(job: AnalysisJob, peaks: PeakWriter, rms: RmsWriter | null): void {
  const info = job.wav!;
  const channelCount = Math.max(1, info.channels);
  const blockAlign = Math.max(1, info.blockAlign);
  const frameCount = Math.floor(info.dataSize / blockAlign);

  const bytes = job.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bytesPerSample = Math.max(1, Math.round(info.bitsPerSample / 8));
  const isFloat = info.formatTag === 3;
  const dataEnd = Math.min(bytes.length, info.dataStart + info.dataSize);

  const read = (offset: number): number => {
    if (isFloat) return view.getFloat32(offset, true);
    if (bytesPerSample === 1) return (view.getUint8(offset) - 128) / 128;
    if (bytesPerSample === 2) return view.getInt16(offset, true) / 32768;
    if (bytesPerSample === 3) {
      const v = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getInt8(offset + 2) << 16);
      return v / 8388608;
    }
    return view.getInt32(offset, true) / 2147483648;
  };

  const scale = 1 / channelCount;
  let base = info.dataStart;
  for (let f = 0; f < frameCount; f++) {
    let lo = 0;
    let hi = 0;
    let square = 0;
    for (let c = 0; c < channelCount; c++) {
      const offset = base + c * bytesPerSample;
      if (offset + bytesPerSample > dataEnd) break;
      const v = read(offset);
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      square += v * v;
    }
    peaks.push(lo, hi);
    rms?.pushSquare(square * scale);
    base += blockAlign;
  }
}

async function runJob(job: AnalysisJob): Promise<void> {
  const peakSamples = Math.ceil(job.duration * job.sampleRate) + job.bucket;
  const hopSamples = Math.max(1, Math.round(RMS_HOP_SECONDS * job.sampleRate));
  const rmsHops = Math.ceil(job.duration / RMS_HOP_SECONDS) + 2;

  if (job.wav) {
    const peaks = new PeakWriter(job.id, peakSamples, job.bucket);
    const rms = job.wantRms ? new RmsWriter(rmsHops, hopSamples) : null;
    readWav(job, peaks, rms);
    peaks.finish();
    if (rms) {
      const out = rms.finish();
      post({ id: job.id, type: 'rms', hopSeconds: RMS_HOP_SECONDS, rms: out }, [out.buffer]);
    }
    post({ id: job.id, type: 'done', peakCount: peaks.peakCount });
    return;
  }

  if (!job.codec) {
    post({ id: job.id, type: 'unsupported', reason: 'no codec' });
    return;
  }
  if (typeof AudioDecoder === 'undefined') {
    post({ id: job.id, type: 'unsupported', reason: 'no AudioDecoder' });
    return;
  }

  const rms = job.wantRms ? new RmsWriter(rmsHops, hopSamples) : null;
  const totalFrames = job.mp4?.count ?? job.mp3?.frameCount ?? 0;
  const useCoarse = job.coarseStep > 1 && totalFrames > job.coarseStep * 8;

  // 粗いパス: 全体の形を素早く出す。RMS は精度が要るのでここでは作らない
  if (useCoarse) {
    const coarse = new PeakWriter(job.id, peakSamples, job.bucket);
    try {
      await decodePass(job, coarse, null, job.coarseStep);
      coarse.finish();
    } catch (error) {
      if (error instanceof Error && error.message === 'unsupported') {
        post({ id: job.id, type: 'unsupported', reason: 'isConfigSupported=false' });
        return;
      }
      throw error;
    }
  }

  // 精密パス: ピークと RMS を同時に作る
  const peaks = new PeakWriter(job.id, peakSamples, job.bucket);
  await decodePass(job, peaks, rms, 1);
  peaks.finish();
  if (rms) {
    const out = rms.finish();
    post({ id: job.id, type: 'rms', hopSeconds: RMS_HOP_SECONDS, rms: out }, [out.buffer]);
  }
  post({ id: job.id, type: 'done', peakCount: peaks.peakCount });
}

scope.onmessage = (event: MessageEvent) => {
  const job = event.data as AnalysisJob;
  void runJob(job).catch((error) => {
    post({ id: job.id, type: 'error', message: error instanceof Error ? error.message : String(error) });
  });
};
