import type { Peaks } from './audio/peaks';
import type { Mp3FrameIndex } from './audio/mp3frames';

export type AudioSource = {
  file: File;
  /** 拡張子を除いたファイル名 */
  name: string;
  ext: string;
  bytes: Uint8Array;
  buffer: AudioBuffer;
  sampleRate: number;
  channels: number;
  duration: number;
  peaks: Peaks;
  mp3Index: Mp3FrameIndex | null;
};

export type OutputFormat = 'mp3' | 'm4a' | 'wav';
