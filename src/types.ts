import type { Peaks } from './audio/peaks';
import type { Mp3FrameIndex } from './audio/mp3frames';
import type { Mp4SampleIndex } from './audio/mp4frames';
import type { WavInfo } from './audio/wav';

export type AudioSource = {
  file: File;
  /** 拡張子を除いたファイル名 */
  name: string;
  ext: string;
  bytes: Uint8Array;
  /** 元ファイルの再生用。デコードを待たずに再生できる */
  blob: Blob;
  sampleRate: number;
  channels: number;
  duration: number;
  /** 元ファイルの音声ビットレート (kbps)。不明なら 0 */
  bitrate: number;
  peaks: Peaks | null;
  mp3Index: Mp3FrameIndex | null;
  /** m4a のサンプルインデックス (再エンコードせずに切り出すため) */
  mp4Index: Mp4SampleIndex | null;
  /** wav のヘッダ情報 (再エンコードせずに切り出すため) */
  wavInfo: WavInfo | null;
  /** 無音検出用の 10ms RMS。解析前は null */
  rms: Float32Array | null;
  rmsHopSeconds: number;
  /** PCM がまだデコードされていない場合に取得する */
  loadPcm: () => Promise<AudioBuffer>;
};

export type OutputFormat = 'mp3' | 'm4a' | 'wav';
