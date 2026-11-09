import './style.css';
import { zipSync } from 'fflate';
import { decodeAudioFile } from './audio/decode';
import { computePeaks } from './audio/peaks';
import {
  buildSegments,
  detectSilenceSplits,
  equalSplits,
  normalizeSplits,
  type Segment,
} from './audio/segments';
import { indexMp3 } from './audio/mp3frames';
import { buildFileName, exportSegments, type ExportFile } from './audio/export';
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
    const { bytes, decoded } = await decodeAudioFile(file);
    const peaks = await computePeaks(decoded.buffer);
    const ext = extOf(file.name);

    source = {
      file,
      name: baseNameOf(file.name),
      ext,
      bytes,
      buffer: decoded.buffer,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
      duration: decoded.duration,
      peaks,
      mp3Index: ext === 'mp3' ? indexMp3(bytes) : null,
    };

    splits = [];
    playhead = 0;
    activeSegment = null;
    cachedFiles = null;
    cachedKey = '';

    player.setBuffer(decoded.buffer);
    waveform.setPeaks(peaks, decoded.duration);
    waveform.setPlayhead(0);
    waveform.fit();

    fileName.textContent = file.name;
    const channelLabel =
      decoded.channels === 1 ? 'モノラル' : decoded.channels === 2 ? 'ステレオ' : `${decoded.channels}ch`;
    fileMeta.textContent = [
      formatTime(decoded.duration, false),
      `${(decoded.sampleRate / 1000).toFixed(1)} kHz`,
      channelLabel,
      formatBytes(file.size),
    ].join(' ・ ');

    durTime.textContent = formatTime(decoded.duration);
    curTime.textContent = formatTime(0);

    dropzone.hidden = true;
    workspace.hidden = false;
    results.innerHTML = '';
    clearResultUrls();
    progress.hidden = true;

    updateQualityOptions();
    refreshSegments();
    hideToast();
  } catch (error) {
    console.error(error);
    toast('このファイルを読み込めませんでした。mp3 / m4a をお試しください。');
  } finally {
    setLoading(null);
  }
}

function clearResultUrls(): void {
  for (const url of resultUrls) URL.revokeObjectURL(url);
  resultUrls = [];
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

function outputBitrate(format: OutputFormat): number | 'original' {
  const value = outQuality.value;
  if (value === 'original') return 'original';
  if (value === 'none' || value === '') return format === 'm4a' ? 192 : 192;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 192;
}

function updateQualityOptions(): void {
  const format = outputFormat();
  const previous = outQuality.value;
  outQuality.innerHTML = '';

  if (format === 'wav') {
    outQuality.add(new Option('PCM 16bit', 'none'));
    outQuality.disabled = true;
    return;
  }

  outQuality.disabled = false;
  const canCopyFrames = format === 'mp3' && source?.ext === 'mp3' && source.mp3Index !== null;
  if (canCopyFrames) outQuality.add(new Option('元のまま (高速)', 'original'));

  const rates = format === 'mp3' ? [128, 192, 256, 320] : [128, 192, 256];
  for (const rate of rates) outQuality.add(new Option(`${rate} kbps`, String(rate)));

  const values = Array.from(outQuality.options).map((option) => option.value);
  if (values.includes(previous)) outQuality.value = previous;
  else outQuality.value = canCopyFrames ? 'original' : '192';
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
  const bitrate = outputBitrate(format);
  const key = `${format}|${bitrate}|${overlapSec}|${splits.join(',')}`;

  if (cachedFiles && cachedKey === key) {
    await deliver(cachedFiles, mode);
    return;
  }

  exporting = true;
  cancelRequested = false;
  updateExportState();
  progress.hidden = false;
  setProgress(0, '準備しています…');

  try {
    const files = await exportSegments({
      source,
      segments,
      format,
      bitrate,
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
    splits = await detectSilenceSplits(source.buffer, {
      thresholdDb: Number(silThreshold.value) || -40,
      minSilenceMs: Math.max(50, Number(silMin.value) || 300),
      minSegmentMs: Math.max(100, Number(silMinSeg.value) || 1000),
    });
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
  overlapSec = Math.max(0, Number(overlapInput.value) || 0) / 1000;
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
