/**
 * 波形表示の Worker プロトコル。
 *
 * - source: 解析対象の File を登録する。バイト列は Worker 側で読むため
 *   メインスレッドを塞がない
 * - range: 指定したサンプル範囲のピークを作る。範囲の先頭フレームへ
 *   シークするため、長い音源でも拡大時は一瞬で終わる
 * - rms: 全編の 10ms RMS を作る (無音検出用、バックグラウンド)
 */

import type { Mp3FrameIndex } from './mp3frames';
import type { Mp4SampleIndex } from './mp4frames';
import type { WavInfo } from './wav';

/** メインスレッドから渡す解析対象の記述子 */
export type SourceSpec = {
  /** Worker 側で読む。メインスレッドのバイト列は複製しない */
  file: File;
  sampleRate: number;
  channels: number;
  duration: number;
  codec: 'mp3' | 'mp4a.40.2' | null;
  mp3: Mp3FrameIndex | null;
  mp4: Mp4SampleIndex | null;
  wav: WavInfo | null;
  asc: Uint8Array | null;
};

export type SourceJob = {
  id: number;
  type: 'source';
  sourceId: number;
  spec: SourceSpec;
};

export type ReleaseJob = {
  id: number;
  type: 'release';
  sourceId: number;
};

export type RangeJob = {
  id: number;
  type: 'range';
  sourceId: number;
  /** ピーク 1 個あたりのサンプル数 */
  bucket: number;
  /** 絶対サンプル位置 */
  startSample: number;
  endSample: number;
};

export type RmsJob = {
  id: number;
  type: 'rms';
  sourceId: number;
  /** 10ms などのホップ (秒) */
  hopSeconds: number;
};

export type AnalysisJob = SourceJob | ReleaseJob | RangeJob | RmsJob;

export type AnalysisMessage =
  | {
      id: number;
      type: 'range-partial';
      /** 絶対サンプル位置 */
      startSample: number;
      bucket: number;
      /** startSample から数えた先頭ピークの位置 */
      offset: number;
      min: Float32Array;
      max: Float32Array;
    }
  | {
      id: number;
      type: 'range';
      startSample: number;
      bucket: number;
      min: Float32Array;
      max: Float32Array;
    }
  | { id: number; type: 'rms'; hopSeconds: number; rms: Float32Array }
  | { id: number; type: 'done' }
  | { id: number; type: 'unsupported'; reason: string }
  | { id: number; type: 'error'; message: string };
