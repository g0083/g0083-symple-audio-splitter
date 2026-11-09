import Mp3Worker from '../workers/mp3.worker?worker';

type Pending = {
  resolve: (data: Uint8Array) => void;
  reject: (error: Error) => void;
};

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, Pending>();

function getWorker(): Worker {
  if (worker) return worker;
  const instance = new Mp3Worker();
  instance.onmessage = (event: MessageEvent) => {
    const { id, ok, data, error } = event.data as {
      id: number;
      ok: boolean;
      data?: Uint8Array;
      error?: string;
    };
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    if (ok && data) entry.resolve(data);
    else entry.reject(new Error(error ?? 'MP3 エンコードに失敗しました'));
  };
  instance.onerror = (event) => {
    const message = event instanceof ErrorEvent ? event.message : 'MP3 ワーカーでエラーが発生しました';
    for (const entry of pending.values()) entry.reject(new Error(message));
    pending.clear();
    worker = null;
  };
  worker = instance;
  return instance;
}

/** MP3 エンコード (Web Worker 上で実行) */
export function encodeMp3(channels: Float32Array[], sampleRate: number, bitrate: number): Promise<Uint8Array> {
  const instance = getWorker();
  const id = ++sequence;
  return new Promise<Uint8Array>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const transfer = channels.map((channel) => channel.buffer as ArrayBuffer);
    instance.postMessage({ id, channels, sampleRate, bitrate }, transfer);
  });
}
