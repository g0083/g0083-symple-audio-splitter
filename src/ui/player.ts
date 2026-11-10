/**
 * プレビュー再生。
 * AudioBuffer をデコードせずに済むよう、Blob URL を <audio> に渡して再生する。
 * 区間再生・ループは currentTime を rAF で監視して制御する。
 */

import { clamp } from '../audio/util';

export class Player {
  private audio: HTMLAudioElement;
  private raf = 0;
  private stopAt: number | null = null;
  private loop: { start: number; end: number } | null = null;
  private objectUrl: string | null = null;
  private pendingSeek: { from: number; to?: number } | null = null;

  onTime: (time: number) => void = () => {};
  onStateChange: (playing: boolean) => void = () => {};

  constructor() {
    const audio = new Audio();
    audio.preload = 'auto';
    this.audio = audio;
    audio.addEventListener('play', () => this.onStateChange(true));
    audio.addEventListener('pause', () => this.onStateChange(false));
    audio.addEventListener('timeupdate', () => {
      if (this.raf === 0) this.onTime(this.currentTime);
    });
    audio.addEventListener('ended', () => this.onStateChange(false));
  }

  get playing(): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  get currentTime(): number {
    return this.audio.currentTime || 0;
  }

  get duration(): number {
    return Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
  }

  /** 再生対象を差し替える。null で解放 */
  setSource(blob: Blob | null): void {
    this.stop();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    if (blob) {
      this.objectUrl = URL.createObjectURL(blob);
      this.audio.src = this.objectUrl;
      this.audio.load();
    } else {
      this.audio.removeAttribute('src');
      this.audio.load();
    }
  }

  setLoop(loop: { start: number; end: number } | null): void {
    this.loop = loop;
  }

  play(from: number, to?: number): void {
    const duration = this.duration;
    const start = clamp(from, 0, Math.max(0, duration - 0.01));
    this.stopAt = to !== undefined ? Math.min(to, duration) : null;
    this.pendingSeek = { from: start, to };

    // シーク完了を待ってから再生する (シーク直後の play はブラウザによって無視される)
    const begin = (): void => {
      this.pendingSeek = null;
      this.audio.currentTime = start;
      const promise = this.audio.play();
      if (promise) promise.catch(() => this.onStateChange(false));
      this.tick();
    };

    if (Math.abs(this.audio.currentTime - start) < 0.005 && this.audio.readyState >= 2) {
      begin();
      return;
    }
    const onSeeked = (): void => {
      this.audio.removeEventListener('seeked', onSeeked);
      if (this.pendingSeek) begin();
    };
    this.audio.addEventListener('seeked', onSeeked);
    this.audio.currentTime = start;
    // すでにシーク済みで seeked が来ない場合に備える
    window.setTimeout(() => {
      if (this.pendingSeek) {
        this.audio.removeEventListener('seeked', onSeeked);
        begin();
      }
    }, 250);
  }

  stop(): void {
    this.stopAt = null;
    this.pendingSeek = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (!this.audio.paused) this.audio.pause();
    this.onStateChange(false);
  }

  seek(time: number): void {
    const duration = this.duration;
    this.audio.currentTime = clamp(time, 0, Math.max(0, duration - 0.01));
    this.onTime(this.audio.currentTime);
  }

  private tick = (): void => {
    if (!this.playing) {
      this.raf = 0;
      return;
    }
    const time = this.audio.currentTime;
    this.onTime(time);

    if (this.stopAt !== null && time >= this.stopAt - 0.01) {
      this.audio.pause();
      const end = this.stopAt;
      this.stopAt = null;
      if (this.loop) {
        this.play(this.loop.start, this.loop.end);
      } else {
        this.onTime(end);
        this.onStateChange(false);
      }
      return;
    }

    if (this.loop && time >= this.loop.end - 0.01) {
      this.play(this.loop.start, this.loop.end);
      return;
    }

    this.raf = requestAnimationFrame(this.tick);
  };
}
