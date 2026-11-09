import { Mp3Encoder } from '@breezystack/lamejs';

type WorkerScope = {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent) => void) | null;
};

type Request = {
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  bitrate: number;
};

const scope = self as unknown as WorkerScope;

function toInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    let sample = input[i];
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

function encode(channels: Float32Array[], sampleRate: number, bitrate: number): Uint8Array {
  const numChannels = Math.min(2, channels.length);
  const encoder = new Mp3Encoder(numChannels, sampleRate, bitrate);
  const left = toInt16(channels[0]);
  const right = numChannels > 1 ? toInt16(channels[1]) : null;

  const blockSize = 1152;
  const parts: Uint8Array[] = [];
  let total = 0;

  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const chunk = right
      ? encoder.encodeBuffer(l, right.subarray(i, i + blockSize))
      : encoder.encodeBuffer(l);
    if (chunk.length > 0) {
      parts.push(new Uint8Array(chunk));
      total += chunk.length;
    }
  }

  const tail = encoder.flush();
  if (tail.length > 0) {
    parts.push(new Uint8Array(tail));
    total += tail.length;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

scope.onmessage = (event: MessageEvent) => {
  const { id, channels, sampleRate, bitrate } = event.data as Request;
  try {
    const data = encode(channels, sampleRate, bitrate);
    scope.postMessage({ id, ok: true, data }, [data.buffer]);
  } catch (error) {
    scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
