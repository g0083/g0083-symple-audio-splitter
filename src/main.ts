import './style.css';
import { zipSync } from 'fflate';
import { inspectAudio, type AudioInfo } from './audio/inspect';
import { decodeBytes } from './audio/decode';
import {
  canAnalyze,
  computeRms,
  registerSource,
  releaseSource,
  requestRange,
  requestRms,
} from './audio/analyze';
import { computePeaks, type Peaks } from './audio/peaks';
import type { WavBits } from './audio/wav';
import {
  buildSegments,
  equalSplits,
  normalizeSplits,
  splitsFromRms,
  type Segment,
} from './audio/segments';
import { buildFileName, exportSegments, resolveEncodeBitrate, type ExportFile } from './audio/export';
import { Waveform } from './ui/waveform';
import { Player } from './ui/player';
import { setupInstallButton } from './ui/install';
import { baseNameOf, downloadBlob, extOf, formatBytes, formatTime } from './audio/util';
import type { AudioSource, OutputFormat } from './types';

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`要素 #${id} が見つかりません`);
  return node as T;
}

const dropzone = el<HTMLElement>('dropzone');
const dzTitle = dropzone.querySelector<HTMLElement>('.dz-title')!;
const fileInput = el<HTMLInputElement>('file-input');
const pickBtn = el<HTMLButtonElement>('pick-btn');
const workspace = el<HTMLElement>('workspace');
const fileName = el<HTMLElement>('file-name');
const fileMeta = el<HTMLElement>('file-meta');
const changeFile = el<HTMLButtonElement>('change-file');

const playBtn = el<HTMLButtonElement>('play-btn');
const iconPlay = playBtn.querySelector<SVGElement>('.icon-play')!;
const iconStop = playBtn.querySelector<SVGElement>('.icon-stop')!;
const curTime = el<HTMLElement>('cur-time');
const durTime = el<HTMLElement>('dur-time');
const zoomIn = el<HTMLButtonElement>('zoom-in');
const zoomOut = el<HTMLButtonElement>('zoom-out');
const zoomFit = el<HTMLButtonElement>('zoom-fit');
const pan = el<HTMLInputElement>('pan');
const waveStatus = el<HTMLElement>('wave-status');
const waveStatusText = el<HTMLElement>('wave-status-text');

const addSplitBtn = el<HTMLButtonElement>('add-split');
const clearSplitsBtn = el<HTMLButtonElement>('clear-splits');
const splitCount = el<HTMLElement>('split-count');
const equalCount = el<HTMLInputElement>('equal-count');
const applyEqual = el<HTMLButtonElement>('apply-equal');
const silThreshold = el<HTMLInputElement>('sil-threshold');
const silMin = el<HTMLInputElement>('sil-min');
const silMinSeg = el<HTMLInputElement>('sil-minseg');
const applySilence = el<HTMLButtonElement>('apply-silence');
const overlapInput = el<HTMLInputElement>('overlap');

const segList = el<HTMLElement>('seg-list');
const segCount = el<HTMLElement>('seg-count');
const loopSeg = el<HTMLInputElement>('loop-seg');

const outFormat = el<HTMLSelectElement>('out-format');
const outQuality = el<HTMLSelectElement>('out-quality');
const exportBtn = el<HTMLButtonElement>('export-btn');
const zipBtn = el<HTMLButtonElement>('zip-btn');
const progress = el<HTMLElement>('progress');
const progressFill = el<HTMLElement>('progress-fill');
const progressText = el<HTMLElement>('progress-text');
const cancelBtn = el<HTMLButtonElement>('cancel-btn');
const results = el<HTMLElement>('results');
const installBtn = el<HTMLButtonElement>('install-btn');
const toastEl = el<HTMLElement>('toast');

let source: AudioSource | null = null;
let splits: number[] = [];
let segments: Segment[] = [];
let overlapSec = 0;
let playhead = 0;
let activeSegment: number | null = null;
let exporting = false;
let cancelRequested = false;
let cachedFiles: ExportFile[] | null = null;
let cachedKey = '';
let resultUrls: string[] = [];
let seekTimer = 0;
let renderScheduled = false;
let analysisSourceId: number | null = null;
let rmsTask: { cancel(): void } | null = null;
let loadedRange: { start: number; end: number; bucket: number } | null = null;
let rangeRequest = 0;
let fallbackPeaks: Peaks | null = null;

/* ------------------------------------------------------------------ toast */

let toastTimer = 0;

function toast(message: string, sticky = false): void {
  toastEl.textContent = message;
  toastEl.hidden = false;
  window.clearTimeout(toastTimer);
  if (!sticky) {
    toastTimer = window.setTimeout(() => {
      toastEl.hidden = true;
    }, 3800);
  }
}

function hideToast(): void {
  window.clearTimeout(toastTimer);
  toastEl.hidden = true;
}

/* --------------------------------------------------------------- waveform */

const waveform = new Waveform(el<HTMLCanvasElement>('wave'), {
  onSeek: (time) => handleSeek(time),
  onAddSplit: (time) => addSplitAt(time),
  onMoveSplit: (index, time) => moveSplit(index, time),
  onDeleteSplit: (index) => deleteSplit(index),
  onViewChange: (start, end) => {
    const span = end - start;
    const maxStart = Math.max(0, (source?.duration ?? 0) - span);
    pan.hidden = maxStart <= 0.001;
    pan.value = maxStart > 0 ? String(Math.round((start / maxStart) * 1000)) : '0';
  },
  onRangeChange: (start, end) => {
    void loadRange(start, end);
  },
});

const player = new Player();

player.onTime = (time) => {
  playhead = time;
  waveform.setPlayhead(time);
  curTime.textContent = formatTime(time);
};

player.onStateChange = (playing) => {
  iconPlay.toggleAttribute('hidden', playing);
  iconStop.toggleAttribute('hidden', !playing);
  playBtn.setAttribute('aria-label', playing ? '停止' : '再生');
  updateSegmentHighlight();
};

/* ------------------------------------------------------------ file loading */

function setLoading(message: string | null): void {
  if (message) {
    dzTitle.textContent = message;
    pickBtn.disabled = true;
  } else {
    dzTitle.textContent = '音声ファイルをドロップ';
    pickBtn.disabled = false;
  }
}

async function loadFile(file: File): Promise<void> {
  if (exporting) return;
  setLoading('読み込み中…');
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ext = extOf(file.name);
    const info = inspectAudio(bytes, ext);

    // 前のファイルの解析が残っていれば打ち切る (Worker の CPU を奪わない)
    cancelBackgroundWork();
    waveform.setPeaks(null, 0);
    setWaveProgress(null);

    // コンテナ解析だけで UI を出せる場合は PCM デコードを待たない
    const duration = info?.duration ?? 0;
    const sampleRate = info?.sampleRate ?? 48000;
    const channels = info?.channels ?? 2;

    let pcmPromise: Promise<AudioBuffer> | null = null;
    const loadPcm = (): Promise<AudioBuffer> => {
      if (!pcmPromise) {
        pcmPromise = decodePcm(bytes, ext).catch((error) => {
          pcmPromise = null;
          throw error;
        });
      }
      return pcmPromise;
    };

    const sourceRef: AudioSource = {
      file,
      name: baseNameOf(file.name),
      ext,
      bytes,
      blob: file,
      sampleRate,
      channels,
      duration,
      bitrate:
        info?.bitrate ||
        (duration > 0 ? Math.round((file.size * 8) / 1000 / duration) : 0),
      mp3Index: info?.mp3Index ?? null,
      mp4Index: info?.mp4Index ?? null,
      wavInfo: info?.wavInfo ?? null,
      rms: null,
      rmsHopSeconds: 0.01,
      peaksReady: false,
      loadPcm,
    };

    source = sourceRef;
    if (analysisSourceId !== null) {
      releaseSource(analysisSourceId);
      analysisSourceId = null;
    }
    if (info) {
      const registered = registerSource(file, info);
      analysisSourceId = registered?.sourceId ?? null;
    }
    loadedRange = null;
    fallbackPeaks = null;
    rangeRequest = 0;
    splits = [];
    playhead = 0;
    activeSegment = null;
    cachedFiles = null;
    cachedKey = '';

    player.setSource(file);
    waveform.setPeaks(null, duration);
    waveform.setPlayhead(0);
    waveform.fit();

    fileName.textContent = file.name;
    const channelLabel = channels === 1 ? 'モノラル' : channels === 2 ? 'ステレオ' : `${channels}ch`;
    fileMeta.textContent = [
      formatTime(duration, false),
      `${(sampleRate / 1000).toFixed(1)} kHz`,
      channelLabel,
      formatBytes(file.size),
    ].join(' ・ ');

    durTime.textContent = formatTime(duration);
    curTime.textContent = formatTime(0);

    dropzone.hidden = true;
    workspace.hidden = false;
    results.innerHTML = '';
    clearResultUrls();
    progress.hidden = true;
    updateQualityOptions();
    refreshSegments();
    hideToast();
    setLoading(null);

    // 表示範囲の波形は waveform 側から要求される。RMS は全編が必要なので裏で進める
    if (info) startBackgroundRms(sourceRef, info);
  } catch (error) {
    console.error(error);
    toast('このファイルを読み込めませんでした。mp3 / m4a をお試しください。');
  } finally {
    setLoading(null);
  }
}

/** PCM デコード (必要になったときだけ) */
async function decodePcm(bytes: Uint8Array, ext: string): Promise<AudioBuffer> {
  const { decoded } = await decodeBytes(bytes, ext);
  return decoded.buffer;
}

/**
 * 表示範囲の波形を読み込む。
 * 表示範囲が変わるたびに呼ばれ、前の要求は破棄して最新だけ反映する。
 */
async function loadRange(startSec: number, endSec: number): Promise<void> {
  const src = source;
  const sourceId = analysisSourceId;
  if (!src) return;

  // 表示解像度に合わせてピーク間隔を決める (全体表示では大きく間引く)
  const bucket = waveform.bucketFor(src.sampleRate);

  // 同じ範囲を同じ解像度で要求済みなら何もしない
  if (
    loadedRange &&
    startSec >= loadedRange.start &&
    endSec <= loadedRange.end &&
    loadedRange.bucket <= bucket
  ) {
    return;
  }

  const startSample = Math.max(0, Math.floor(startSec * src.sampleRate));
  const endSample = Math.max(startSample + 1, Math.ceil(endSec * src.sampleRate));
  const request = ++rangeRequest;
  if (!src.peaksReady) setWaveProgress(0);

  if (sourceId !== null) {
    const peaks = await requestRange(sourceId, src.sampleRate, startSample, endSample, bucket, (partial) => {
      if (request !== rangeRequest || source !== src) return;
      src.peaksReady = true;
      waveform.updatePeaks(partial);
      setWaveProgress(null);
    });
    if (request !== rangeRequest || source !== src) return;
    if (peaks) {
      loadedRange = { start: startSec, end: endSec, bucket: peaks.bucket };
      src.peaksReady = true;
      waveform.updatePeaks(peaks);
      setWaveProgress(null);
      return;
    }
    // Worker が使えない/非対応コーデック: PCM デコードにフォールバック
  }

  await loadRangeWithDecode(startSec, endSec, request);
}

/** Worker が使えないときのフォールバック。全体を一度だけデコードしてピークを作る */
async function loadRangeWithDecode(startSec: number, endSec: number, request: number): Promise<void> {
  const src = source;
  if (!src) return;
  try {
    if (!fallbackPeaks) {
      setWaveProgress(0);
      const buffer = await src.loadPcm();
      if (source !== src) return;
      fallbackPeaks = await computePeaks(buffer);
      if (source !== src) return;
      if (!src.rms) {
        const rms = computeRms(buffer);
        src.rms = rms.rms;
        src.rmsHopSeconds = rms.hopSeconds;
      }
    }
    if (request !== rangeRequest || source !== src) return;
    loadedRange = { start: 0, end: src.duration, bucket: fallbackPeaks.bucket };
    src.peaksReady = true;
    waveform.updatePeaks(fallbackPeaks);
    setWaveProgress(null);
    void startSec;
    void endSec;
  } catch (error) {
    console.warn('波形を作成できませんでした', error);
    setWaveProgress(null);
  }
}

/** 無音検出用の RMS をバックグラウンドで作る */
function startBackgroundRms(src: AudioSource, info: AudioInfo): void {
  const sourceId = analysisSourceId;
  if (sourceId === null || !canAnalyze()) return;

  const task = requestRms(src.file, info, sourceId, 0.01);
  rmsTask = task;
  void task.result.then((rms) => {
    if (rmsTask === task) rmsTask = null;
    if (source !== src || !rms) return;
    src.rms = rms;
    src.rmsHopSeconds = 0.01;
  });
}

/** バックグラウンド処理 (RMS) を打ち切る */
function cancelBackgroundWork(): void {
  rmsTask?.cancel();
  rmsTask = null;
  loadedRange = null;
  fallbackPeaks = null;
  rangeRequest++;
}

function clearResultUrls(): void {
  for (const url of resultUrls) URL.revokeObjectURL(url);
  resultUrls = [];
}

/** 波形解析の進捗表示。null で非表示 */
function setWaveProgress(ratio: number | null): void {
  if (ratio === null) {
    waveStatus.hidden = true;
    return;
  }
  waveStatus.hidden = false;
  const percent = Math.round(ratio * 100);
  waveStatusText.textContent = percent >= 100 ? '波形を解析中…' : `波形を解析中… ${percent}%`;
}

/* --------------------------------------------------------------- segments */

function outputFormat(): OutputFormat {
  const value = outFormat.value;
  if (value !== 'same') return value as OutputFormat;
  const ext = source?.ext ?? 'mp3';
  if (ext === 'mp3') return 'mp3';
  if (ext === 'm4a' || ext === 'mp4' || ext === 'm4b' || ext === 'aac') return 'm4a';
  if (ext === 'wav') return 'wav';
  return 'mp3';
}

function outputBitrate(): number | 'original' {
  const value = outQuality.value;
  if (value === 'original') return 'original';
  if (value === 'none' || value === '') return 192;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 192;
}

/** 再エンコード時に元の品質を維持できるビットレート (kbps) */
function originalBitrateFor(format: OutputFormat): number {
  return resolveEncodeBitrate(source?.bitrate ?? 0, format, source?.sampleRate ?? 44100);
}

/** WAV 出力のビット深度。'original' は元 WAV の PCM をそのままコピーする */
function outputWavBits(): WavBits | 'original' {
  const value = outQuality.value;
  if (value === 'original') return 'original';
  const parsed = Number(value);
  return parsed === 16 || parsed === 32 ? parsed : 24;
}

function updateQualityOptions(): void {
  const format = outputFormat();
  const previous = outQuality.value;
  outQuality.innerHTML = '';

  if (format === 'wav') {
    outQuality.disabled = false;
    const canCopy = source?.wavInfo != null;
    if (canCopy) outQuality.add(new Option('元のまま (PCM コピー)', 'original'));
    outQuality.add(new Option('24bit PCM', '24'));
    outQuality.add(new Option('16bit PCM', '16'));
    outQuality.add(new Option('32bit float', '32'));
    const values = Array.from(outQuality.options).map((option) => option.value);
    outQuality.value = values.includes(previous) ? previous : canCopy ? 'original' : '24';
    return;
  }

  outQuality.disabled = false;
  const canCopyFrames =
    (format === 'mp3' && source?.ext === 'mp3' && source.mp3Index != null) ||
    (format === 'm4a' && source?.mp4Index != null);
  const originalLabel = canCopyFrames
    ? '元のまま (高速)'
    : source?.bitrate
      ? `元のまま (${originalBitrateFor(format)} kbps)`
      : '元のまま';
  outQuality.add(new Option(originalLabel, 'original'));

  const rates = format === 'mp3' ? [128, 192, 256, 320] : [128, 192, 256];
  for (const rate of rates) outQuality.add(new Option(`${rate} kbps`, String(rate)));

  const values = Array.from(outQuality.options).map((option) => option.value);
  outQuality.value = values.includes(previous) ? previous : 'original';
}

function refreshSegments(): void {
  if (!source) return;
  segments = buildSegments(splits, source.duration, overlapSec);
  splitCount.textContent = String(splits.length);
  segCount.textContent = String(segments.length);
  waveform.setSplits(splits);
  cachedFiles = null;
  cachedKey = '';
  renderSegments();
  updateExportState();
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    renderSegments();
  });
}

function renderSegments(): void {
  segList.innerHTML = '';
  if (!source || segments.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'seg-empty';
    empty.textContent = '分割線を追加すると、ここに各区間が表示されます。';
    segList.append(empty);
    return;
  }

  const format = outputFormat();
  const total = segments.length;

  for (const segment of segments) {
    const row = document.createElement('div');
    row.className = 'seg';
    if (player.playing && activeSegment === segment.index) row.classList.add('is-playing');

    const index = document.createElement('span');
    index.className = 'seg-idx';
    index.textContent = String(segment.index + 1).padStart(2, '0');

    const main = document.createElement('div');
    main.className = 'seg-main';
    const name = document.createElement('div');
    name.className = 'seg-name';
    name.textContent = buildFileName(source.name, segment.index, total, format);
    const time = document.createElement('div');
    time.className = 'seg-time';
    time.textContent = `${formatTime(segment.start)} – ${formatTime(segment.end)}  (${formatTime(
      segment.end - segment.start,
    )})`;
    main.append(name, time);

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'seg-play';
    play.title = 'この区間を再生';
    play.setAttribute('aria-label', 'この区間を再生');
    play.innerHTML =
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
    play.addEventListener('click', () => playSegment(segment.index));

    row.append(index, main, play);
    segList.append(row);
  }
}

function updateSegmentHighlight(): void {
  const rows = segList.querySelectorAll<HTMLElement>('.seg');
  rows.forEach((row, index) => {
    row.classList.toggle('is-playing', player.playing && activeSegment === index);
  });
}

function playSegment(index: number): void {
  const segment = segments[index];
  if (!segment) return;
  if (activeSegment === index && player.playing) {
    player.stop();
    activeSegment = null;
    updateSegmentHighlight();
    return;
  }
  activeSegment = index;
  player.setLoop(loopSeg.checked ? { start: segment.start, end: segment.end } : null);
  player.play(segment.start, segment.end);
  updateSegmentHighlight();
}

function handleSeek(time: number): void {
  playhead = time;
  activeSegment = null;
  waveform.setPlayhead(time);
  curTime.textContent = formatTime(time);
  if (player.playing) {
    window.clearTimeout(seekTimer);
    seekTimer = window.setTimeout(() => {
      if (player.playing) {
        player.setLoop(null);
        player.play(playhead);
      }
    }, 160);
  }
}

function addSplitAt(time: number): void {
  if (!source) return;
  splits = normalizeSplits([...splits, time], source.duration);
  refreshSegments();
}

function moveSplit(index: number, time: number): void {
  if (!source) return;
  if (index < 0 || index >= splits.length) return;
  const next = [...splits];
  next[index] = time;
  splits = normalizeSplits(next, source.duration);
  segments = buildSegments(splits, source.duration, overlapSec);
  splitCount.textContent = String(splits.length);
  segCount.textContent = String(segments.length);
  waveform.setSplits(splits);
  cachedFiles = null;
  cachedKey = '';
  scheduleRender();
  updateExportState();
}

function deleteSplit(index: number): void {
  if (!source) return;
  splits = splits.filter((_, i) => i !== index);
  refreshSegments();
}

/* ---------------------------------------------------------------- export */

function updateExportState(): void {
  const disabled = !source || segments.length === 0 || exporting;
  exportBtn.disabled = disabled;
  zipBtn.disabled = disabled;
}

function setProgress(ratio: number, text: string): void {
  progressFill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
  progressText.textContent = text;
}

function renderResults(files: ExportFile[]): void {
  clearResultUrls();
  results.innerHTML = '';
  for (const file of files) {
    const row = document.createElement('div');
    row.className = 'result';

    const name = document.createElement('span');
    name.className = 'result-name';
    name.textContent = file.name;

    const size = document.createElement('span');
    size.className = 'result-size';
    size.textContent = formatBytes(file.blob.size);

    const url = URL.createObjectURL(file.blob);
    resultUrls.push(url);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.textContent = '保存';

    row.append(name, size, link);
    results.append(row);
  }
}

async function makeZip(files: ExportFile[]): Promise<Blob> {
  const entries: Record<string, Uint8Array> = {};
  for (const file of files) {
    entries[file.name] = new Uint8Array(await file.blob.arrayBuffer());
  }
  const data = zipSync(entries, { level: 0 });
  return new Blob([data], { type: 'application/zip' });
}

async function runExport(mode: 'files' | 'zip'): Promise<void> {
  if (!source || segments.length === 0 || exporting) return;

  const format = outputFormat();
  const bitrate = outputBitrate();
  const wavBits = format === 'wav' ? outputWavBits() : undefined;
  const key = `${format}|${bitrate}|${wavBits ?? ''}|${overlapSec}|${splits.join(',')}`;

  if (cachedFiles && cachedKey === key) {
    await deliver(cachedFiles, mode);
    return;
  }

  exporting = true;
  cancelRequested = false;
  // 分割中はバックグラウンドの RMS 作成を止めて、CPU を書き出しに回す
  rmsTask?.cancel();
  rmsTask = null;
  updateExportState();
  progress.hidden = false;
  setProgress(0, '準備しています…');

  try {
    const files = await exportSegments({
      source,
      segments,
      format,
      bitrate,
      wavBits,
      onProgress: (done, total, label) => {
        setProgress(total > 0 ? done / total : 0, `${done} / ${total}  ${label}`);
      },
      onStatus: (message) => {
        progressText.textContent = message;
      },
      isCancelled: () => cancelRequested,
    });

    cachedFiles = files;
    cachedKey = key;
    renderResults(files);
    setProgress(1, `${files.length} 個のファイルを作成しました`);
    await deliver(files, mode);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      toast('書き出しを中止しました');
    } else {
      console.error(error);
      toast(`書き出しに失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    exporting = false;
    updateExportState();
    window.setTimeout(() => {
      if (!exporting) progress.hidden = true;
    }, 2500);
  }
}

async function deliver(files: ExportFile[], mode: 'files' | 'zip'): Promise<void> {
  if (!source) return;
  if (mode === 'zip') {
    toast('ZIP を作成しています…', true);
    try {
      const blob = await makeZip(files);
      downloadBlob(blob, `${source.name}_split.zip`);
      hideToast();
    } catch (error) {
      console.error(error);
      toast('ZIP の作成に失敗しました');
    }
    return;
  }

  for (let i = 0; i < files.length; i++) {
    downloadBlob(files[i].blob, files[i].name);
    if (i < files.length - 1) await new Promise((resolve) => setTimeout(resolve, 180));
  }
}

/* ------------------------------------------------------------------ wiring */

pickBtn.addEventListener('click', () => fileInput.click());
changeFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  fileInput.value = '';
  if (file) void loadFile(file);
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  dropzone.classList.add('is-over');
});
window.addEventListener('dragover', (event) => {
  if (!event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropzone.classList.remove('is-over');
});
window.addEventListener('drop', (event) => {
  if (!event.dataTransfer?.files.length) return;
  event.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove('is-over');
  const file = event.dataTransfer.files[0];
  if (file) void loadFile(file);
});

playBtn.addEventListener('click', () => {
  if (!source) return;
  if (player.playing) {
    player.stop();
    return;
  }
  activeSegment = null;
  player.setLoop(null);
  player.play(playhead >= source.duration - 0.05 ? 0 : playhead);
});

zoomIn.addEventListener('click', () => waveform.zoom(1.6));
zoomOut.addEventListener('click', () => waveform.zoom(1 / 1.6));
zoomFit.addEventListener('click', () => waveform.fit());

pan.addEventListener('input', () => {
  const { start, end } = waveform.getView();
  const span = end - start;
  const maxStart = Math.max(0, (source?.duration ?? 0) - span);
  const next = (Number(pan.value) / 1000) * maxStart;
  waveform.setView(next, next + span);
});

addSplitBtn.addEventListener('click', () => addSplitAt(playhead));
clearSplitsBtn.addEventListener('click', () => {
  splits = [];
  refreshSegments();
});

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll<HTMLButtonElement>('.tab').forEach((item) => {
      item.classList.toggle('is-active', item === tab);
    });
    document.querySelectorAll<HTMLElement>('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab;
    });
  });
});

applyEqual.addEventListener('click', () => {
  if (!source) return;
  splits = equalSplits(source.duration, Number(equalCount.value));
  refreshSegments();
});

applySilence.addEventListener('click', async () => {
  if (!source) return;
  applySilence.disabled = true;
  toast('無音区間を解析しています…', true);
  try {
    const options = {
      thresholdDb: Number(silThreshold.value) || -40,
      minSilenceMs: Math.max(50, Number(silMin.value) || 300),
      minSegmentMs: Math.max(100, Number(silMinSeg.value) || 1000),
    };

    // 波形解析で作った 10ms RMS があれば PCM を再走査しない
    let rms = source.rms;
    let hopSeconds = source.rmsHopSeconds;
    if (!rms) {
      const buffer = await source.loadPcm();
      const computed = computeRms(buffer);
      rms = computed.rms;
      hopSeconds = computed.hopSeconds;
      source.rms = rms;
      source.rmsHopSeconds = hopSeconds;
    }

    splits = splitsFromRms(rms, hopSeconds, source.duration, options);
    refreshSegments();
    toast(splits.length > 0 ? `${splits.length} 箇所で分割します` : '無音区間が見つかりませんでした');
  } catch (error) {
    console.error(error);
    toast('無音検出に失敗しました');
  } finally {
    applySilence.disabled = false;
  }
});

overlapInput.addEventListener('input', () => {
  overlapSec = Math.max(0, Number(overlapInput.value) || 0);
  refreshSegments();
});

outFormat.addEventListener('change', () => {
  updateQualityOptions();
  renderSegments();
  cachedFiles = null;
  cachedKey = '';
});

outQuality.addEventListener('change', () => {
  cachedFiles = null;
  cachedKey = '';
});

exportBtn.addEventListener('click', () => void runExport('files'));
zipBtn.addEventListener('click', () => void runExport('zip'));
cancelBtn.addEventListener('click', () => {
  cancelRequested = true;
  progressText.textContent = '中止しています…';
});

loopSeg.addEventListener('change', () => {
  if (!loopSeg.checked) player.setLoop(null);
});

window.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement | null;
  if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;
  if (!source) return;
  if (event.code === 'Space') {
    event.preventDefault();
    playBtn.click();
  } else if (event.key === 's' || event.key === 'S') {
    event.preventDefault();
    addSplitAt(playhead);
  }
});

setupInstallButton(installBtn, (message) => toast(message));

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL }).catch(
      (error) => console.warn('Service Worker の登録に失敗しました', error),
    );
  });
}

updateQualityOptions();
updateExportState();

