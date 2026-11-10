/**
 * ベンチマーク用の音声フィクスチャを生成する。
 * ffmpeg が PATH にある前提。`node bench/make-fixtures.mjs` で実行。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'fixtures');
mkdirSync(out, { recursive: true });

const DURATION = 180;
const RATE = 44100;

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' });
}

/** 2ch のテスト音源 (440Hz / 660Hz) を生成する lavfi 入力 */
const input = [
  '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=${RATE}:duration=${DURATION}`,
  '-f', 'lavfi', '-i', `sine=frequency=660:sample_rate=${RATE}:duration=${DURATION}`,
  '-filter_complex', '[0:a][1:a]amerge=inputs=2[a]',
  '-map', '[a]',
];

ffmpeg([...input, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', join(out, 'tone180.m4a')]);
ffmpeg([...input, '-c:a', 'libmp3lame', '-b:a', '192k', join(out, 'tone180.mp3')]);

/**
 * 検証用: 18 秒ごとに違う周波数のトーンを並べた音源。
 * 分割位置が正しいかを周波数で一意に判定できる。
 */
const BLOCK = 18;
const BLOCKS = 10;
const freqs = Array.from({ length: BLOCKS }, (_, i) => 300 + i * 200);
const parts = freqs.map((f) => `sine=frequency=${f}:sample_rate=${RATE}:duration=${BLOCK}`);
const inputs = parts.flatMap((p) => ['-f', 'lavfi', '-i', p]);
const labels = freqs.map((_, i) => `[${i}:a]`).join('');
const steps = [
  ...inputs,
  '-filter_complex', `${labels}concat=n=${BLOCKS}:v=0:a=1[a]`,
  '-map', '[a]',
];
ffmpeg([...steps, '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', join(out, 'blocks180.m4a')]);
ffmpeg([...steps, '-c:a', 'libmp3lame', '-b:a', '192k', join(out, 'blocks180.mp3')]);
console.log(`block frequencies: ${freqs.join(', ')}`);

console.log(`fixtures written to ${out}`);
