/**
 * 波形解析の Worker プロトコル。
 *
 * コンテナ解析 (inspect) は数 ms で終わるためメインスレッドで行い、
 * 重いデコードと走査だけを Worker に渡す。PCM は Worker 内で完結する。
 */

import type { Mp3FrameIndex } from './mp3frames';
import type { Mp4SampleIndex } from './mp4frames';
import type { WavInfo } from './wav';

export type AnalysisJob = {
  id: number;
  bytes: Uint8Array;
  sampleRate: number;
  channels: number;
  duration: number;
  /** 波形 1 ピークあたりのサンプル数 */
  bucket: number;
  /** 無音検出用の 10ms RMS も作る */
  wantRms: boolean;
  codec: 'mp3' | 'mp4a.40.2' | null;
  mp3: Mp3FrameIndex | null;
  mp4: Mp4SampleIndex | null;
  wav: WavInfo | null;
  asc: Uint8Array | null;
  /** 粗い波形を先に出すための間引き間隔 (1 = 粗いパスなし) */
  coarseStep: number;
};

export type PeaksChunk = {
  id: number;
  type: 'peaks';
  /** このチャンクが始まるピーク番号 */
  start: number;
  min: Float32Array;
  max: Float32Array;
};

export type AnalysisMessage =
  | PeaksChunk
  | { id: number; type: 'rms'; hopSeconds: number; rms: Float32Array }
  | { id: number; type: 'done'; peakCount: number }
  | { id: number; type: 'unsupported'; reason: string }
  | { id: number; type: 'error'; message: string };

export type AnalysisChunkHandler = (message: AnalysisMessage) => void;

export type AnalysisResult = {
  /** ピーク配列 (先頭から埋まっている) */
  min: Float32Array;
  max: Float32Array;
  /** 埋まったピーク数 */
  peakCount: number;
  bucket: number;
  sampleRate: number;
  rms: Float32Array | null;
  rmsHopSeconds: number;
};
