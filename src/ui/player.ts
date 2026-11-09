import { clamp } from '../audio/util';

export class Player {
  private context: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private offset = 0;
  private stopAt: number | null = null;
  private raf = 0;
  private loop: { start: number; end: number } | null = null;

  onTime: (time: number) => void = () => {};
  onStateChange: (playing: boolean) => void = () => {};

  get playing(): boolean {
    return this.source !== null;
  }

  get currentTime(): number {
    if (!this.source || !this.context) return this.offset;
    return this.offset + (this.context.currentTime - this.startedAt);
  }

  setBuffer(buffer: AudioBuffer | null): void {
    this.stop();
    this.buffer = buffer;
    this.offset = 0;
  }

  setLoop(loop: { start: number; end: number } | null): void {
    this.loop = loop;
  }

  private ensureContext(): AudioContext {
    if (!this.context) this.context = new AudioContext();
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  play(from: number, to?: number): void {
    if (!this.buffer) return;
    this.stop();
    const context = this.ensureContext();
    const source = context.createBufferSource();
    source.buffer = this.buffer;
    source.connect(context.destination);

    const start = clamp(from, 0, Math.max(0, this.buffer.duration - 0.001));
    const duration =
      to !== undefined ? Math.max(0.01, Math.min(to, this.buffer.duration) - start) : undefined;

    source.start(0, start, duration);
    this.source = source;
    this.startedAt = context.currentTime;
    this.offset = start;
    this.stopAt = duration !== undefined ? start + duration : null;

    source.onended = () => {
      if (this.source !== source) return;
      this.source = null;
      cancelAnimationFrame(this.raf);
      this.onStateChange(false);
      if (this.loop) {
        this.play(this.loop.start, this.loop.end);
      } else {
        this.onTime(this.stopAt ?? this.buffer?.duration ?? 0);
      }
    };

    this.onStateChange(true);
    this.tick();
  }

  stop(): void {
    const source = this.source;
    this.source = null;
    cancelAnimationFrame(this.raf);
    if (source) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* すでに停止している */
      }
      source.disconnect();
    }
    this.onStateChange(false);
  }

  toggle(from: number, to?: number): void {
    if (this.playing) this.stop();
    else this.play(from, to);
  }

  private tick = (): void => {
    if (!this.source) return;
    const time = this.currentTime;
    this.onTime(this.stopAt !== null ? Math.min(time, this.stopAt) : time);
    this.raf = requestAnimationFrame(this.tick);
  };
}
