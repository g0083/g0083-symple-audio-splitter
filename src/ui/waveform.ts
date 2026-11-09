import type { Peaks } from '../audio/peaks';
import { clamp } from '../audio/util';

export type WaveformHandlers = {
  onSeek: (time: number) => void;
  onAddSplit: (time: number) => void;
  onMoveSplit: (index: number, time: number) => void;
  onDeleteSplit: (index: number) => void;
  onViewChange: (start: number, end: number) => void;
};

const RULER_HEIGHT = 18;
const HANDLE_RADIUS = 7;
const MIN_SPAN = 0.05;

type Colors = {
  wave: string;
  waveSoft: string;
  playhead: string;
  text: string;
  muted: string;
  line: string;
  card: string;
};

function niceInterval(span: number, width: number): number {
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  const minPixels = 64;
  for (const step of steps) {
    if ((step / span) * width >= minPixels) return step;
  }
  return steps[steps.length - 1];
}

function tickLabel(seconds: number): string {
  const total = Math.round(seconds * 100) / 100;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  if (m === 0) return `${s.toFixed(s % 1 === 0 ? 0 : 1)}s`;
  return `${m}:${s.toFixed(s % 1 === 0 ? 0 : 1).padStart(s % 1 === 0 ? 2 : 4, '0')}`;
}

export class Waveform {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private body: HTMLCanvasElement;
  private bodyCtx: CanvasRenderingContext2D;
  private handlers: WaveformHandlers;
  private resizeObserver: ResizeObserver;

  private peaks: Peaks | null = null;
  private duration = 0;
  private splits: number[] = [];
  private playhead: number | null = null;
  private viewStart = 0;
  private viewEnd = 1;

  private width = 0;
  private height = 0;
  private dpr = 1;
  private bodyDirty = true;
  private raf = 0;

  private drag: { kind: 'split' | 'seek'; index: number } | null = null;
  private dragValue = 0;
  private hoverSplit: number | null = null;
  private colors: Colors = {
    wave: '#4f46e5',
    waveSoft: '#c7cbf7',
    playhead: '#ef4444',
    text: '#16181d',
    muted: '#6b7280',
    line: '#e6e8ec',
    card: '#ffffff',
  };

  constructor(canvas: HTMLCanvasElement, handlers: WaveformHandlers) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context を取得できません');
    this.ctx = ctx;
    this.body = document.createElement('canvas');
    const bodyCtx = this.body.getContext('2d');
    if (!bodyCtx) throw new Error('canvas 2d context を取得できません');
    this.bodyCtx = bodyCtx;
    this.handlers = handlers;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.resize();

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', this.onPointerLeave);
    canvas.addEventListener('dblclick', this.onDoubleClick);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy(): void {
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.raf);
  }

  setPeaks(peaks: Peaks | null, duration: number): void {
    this.peaks = peaks;
    this.duration = duration;
    this.viewStart = 0;
    this.viewEnd = Math.max(duration, MIN_SPAN);
    this.bodyDirty = true;
    this.schedule();
  }

  setSplits(splits: number[]): void {
    this.splits = splits;
    if (this.drag && this.drag.kind === 'split') {
      let best = -1;
      let bestDiff = Infinity;
      splits.forEach((value, index) => {
        const diff = Math.abs(value - this.dragValue);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = index;
        }
      });
      this.drag.index = best;
    }
    this.schedule();
  }

  setPlayhead(time: number | null): void {
    this.playhead = time;
    this.schedule();
  }

  getView(): { start: number; end: number } {
    return { start: this.viewStart, end: this.viewEnd };
  }

  setView(start: number, end: number): void {
    const span = clamp(end - start, MIN_SPAN, Math.max(this.duration, MIN_SPAN));
    const from = clamp(start, 0, Math.max(0, this.duration - span));
    this.viewStart = from;
    this.viewEnd = from + span;
    this.bodyDirty = true;
    this.schedule();
    this.handlers.onViewChange(this.viewStart, this.viewEnd);
  }

  zoom(factor: number, anchorTime?: number): void {
    const span = this.viewEnd - this.viewStart;
    const anchor = anchorTime ?? (this.viewStart + this.viewEnd) / 2;
    const ratio = span > 0 ? (anchor - this.viewStart) / span : 0.5;
    const nextSpan = clamp(span / factor, MIN_SPAN, Math.max(this.duration, MIN_SPAN));
    const nextStart = anchor - nextSpan * ratio;
    this.setView(nextStart, nextStart + nextSpan);
  }

  fit(): void {
    this.setView(0, Math.max(this.duration, MIN_SPAN));
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    if (width === this.width && height === this.height && dpr === this.dpr) return;

    this.width = width;
    this.height = height;
    this.dpr = dpr;

    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.body.width = Math.round(width * dpr);
    this.body.height = Math.round(height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.bodyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const styles = getComputedStyle(document.documentElement);
    const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
    this.colors = {
      wave: read('--wave', '#4f46e5'),
      waveSoft: read('--wave-soft', '#c7cbf7'),
      playhead: read('--playhead', '#ef4444'),
      text: read('--text', '#16181d'),
      muted: read('--muted', '#6b7280'),
      line: read('--line', '#e6e8ec'),
      card: read('--card', '#ffffff'),
    };

    this.bodyDirty = true;
    this.schedule();
  }

  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  private timeToX(time: number): number {
    const span = this.viewEnd - this.viewStart;
    if (span <= 0) return 0;
    return ((time - this.viewStart) / span) * this.width;
  }

  private xToTime(x: number): number {
    const span = this.viewEnd - this.viewStart;
    return clamp(this.viewStart + (x / this.width) * span, 0, this.duration);
  }

  private renderBody(): void {
    const ctx = this.bodyCtx;
    const { width, height, colors } = this;
    ctx.clearRect(0, 0, width, height);

    const top = RULER_HEIGHT;
    const mid = top + (height - top) / 2;
    const amp = (height - top) / 2 - 6;

    ctx.strokeStyle = colors.line;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, mid + 0.5);
    ctx.lineTo(width, mid + 0.5);
    ctx.stroke();

    const peaks = this.peaks;
    if (!peaks || peaks.min.length === 0) return;

    const span = this.viewEnd - this.viewStart;
    const samplesPerPixel = (span * peaks.sampleRate) / width;
    const baseSample = this.viewStart * peaks.sampleRate;
    ctx.fillStyle = colors.wave;

    for (let x = 0; x < width; x++) {
      const b0 = Math.floor((baseSample + x * samplesPerPixel) / peaks.bucket);
      const b1 = Math.max(b0 + 1, Math.ceil((baseSample + (x + 1) * samplesPerPixel) / peaks.bucket));
      const count = b1 - b0;
      const stride = count > 64 ? Math.floor(count / 64) : 1;
      let lo = 0;
      let hi = 0;
      for (let b = Math.max(0, b0); b < b1 && b < peaks.min.length; b += stride) {
        if (peaks.min[b] < lo) lo = peaks.min[b];
        if (peaks.max[b] > hi) hi = peaks.max[b];
      }
      const y0 = mid - hi * amp;
      const y1 = mid - lo * amp;
      ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  private draw(): void {
    const { ctx, width, height, colors } = this;
    if (this.bodyDirty) {
      this.renderBody();
      this.bodyDirty = false;
    }

    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.body, 0, 0, width, height);

    // ルーラー
    ctx.fillStyle = colors.card;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(0, 0, width, RULER_HEIGHT);
    ctx.globalAlpha = 1;

    const span = this.viewEnd - this.viewStart;
    const interval = niceInterval(span, width);
    ctx.strokeStyle = colors.line;
    ctx.fillStyle = colors.muted;
    ctx.font = '10px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 1;

    const first = Math.ceil(this.viewStart / interval) * interval;
    for (let t = first; t <= this.viewEnd; t += interval) {
      const x = Math.round(this.timeToX(t)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT - 5);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.stroke();
      ctx.fillText(tickLabel(t), x + 3, RULER_HEIGHT / 2);
    }

    // 分割線
    this.splits.forEach((time, index) => {
      const x = this.timeToX(time);
      if (x < -10 || x > width + 10) return;
      const active = this.hoverSplit === index || (this.drag?.kind === 'split' && this.drag.index === index);
      ctx.strokeStyle = colors.wave;
      ctx.lineWidth = active ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo(x, RULER_HEIGHT);
      ctx.lineTo(x, height);
      ctx.stroke();

      const cy = RULER_HEIGHT + HANDLE_RADIUS + 2;
      ctx.beginPath();
      ctx.arc(x, cy, HANDLE_RADIUS, 0, Math.PI * 2);
      ctx.fillStyle = colors.wave;
      ctx.fill();
      ctx.strokeStyle = colors.card;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x - 3, cy - 3);
      ctx.lineTo(x + 3, cy + 3);
      ctx.moveTo(x + 3, cy - 3);
      ctx.lineTo(x - 3, cy + 3);
      ctx.stroke();
    });

    // 再生ヘッド
    if (this.playhead !== null) {
      const x = this.timeToX(this.playhead);
      if (x >= -2 && x <= width + 2) {
        ctx.strokeStyle = colors.playhead;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, RULER_HEIGHT);
        ctx.lineTo(x, height);
        ctx.stroke();
        ctx.fillStyle = colors.playhead;
        ctx.beginPath();
        ctx.moveTo(x - 4, RULER_HEIGHT);
        ctx.lineTo(x + 4, RULER_HEIGHT);
        ctx.lineTo(x, RULER_HEIGHT + 6);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private localPoint(event: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private splitAt(x: number, y: number): number | null {
    const handleY = RULER_HEIGHT + HANDLE_RADIUS + 2;
    for (let i = 0; i < this.splits.length; i++) {
      const sx = this.timeToX(this.splits[i]);
      if (Math.abs(sx - x) <= HANDLE_RADIUS + 2 && Math.abs(handleY - y) <= HANDLE_RADIUS + 2) return i;
    }
    return null;
  }

  private lineAt(x: number): number | null {
    for (let i = 0; i < this.splits.length; i++) {
      if (Math.abs(this.timeToX(this.splits[i]) - x) <= 5) return i;
    }
    return null;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const { x, y } = this.localPoint(event);

    const handle = this.splitAt(x, y);
    if (handle !== null) {
      this.handlers.onDeleteSplit(handle);
      return;
    }

    const line = this.lineAt(x);
    this.canvas.setPointerCapture(event.pointerId);
    if (line !== null) {
      this.drag = { kind: 'split', index: line };
      this.dragValue = this.splits[line];
    } else {
      this.drag = { kind: 'seek', index: -1 };
      this.handlers.onSeek(this.xToTime(x));
    }
    this.schedule();
  };

  private onPointerMove = (event: PointerEvent): void => {
    const { x, y } = this.localPoint(event);

    if (this.drag) {
      const time = this.xToTime(x);
      if (this.drag.kind === 'split') {
        this.dragValue = time;
        this.handlers.onMoveSplit(this.drag.index, time);
      } else {
        this.handlers.onSeek(time);
      }
      return;
    }

    const hover = this.splitAt(x, y) ?? this.lineAt(x);
    if (hover !== this.hoverSplit) {
      this.hoverSplit = hover;
      this.canvas.style.cursor = hover !== null ? 'ew-resize' : 'crosshair';
      this.schedule();
    }
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(event.pointerId)) {
      this.canvas.releasePointerCapture(event.pointerId);
    }
    this.drag = null;
    this.schedule();
  };

  private onPointerLeave = (): void => {
    if (this.hoverSplit !== null) {
      this.hoverSplit = null;
      this.schedule();
    }
  };

  private onDoubleClick = (event: MouseEvent): void => {
    const { x, y } = this.localPoint(event);
    if (y < RULER_HEIGHT) return;
    if (this.lineAt(x) !== null) return;
    this.handlers.onAddSplit(this.xToTime(x));
  };

  private onWheel = (event: WheelEvent): void => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const { x } = this.localPoint(event);
    const anchor = this.xToTime(x);
    this.zoom(event.deltaY < 0 ? 1.25 : 0.8, anchor);
  };
}
