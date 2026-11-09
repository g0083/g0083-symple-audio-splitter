// PWA アイコン (PNG) を生成する。外部依存なし。
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'public', 'icons');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function createCanvas(size) {
  return { size, data: Buffer.alloc(size * size * 4) };
}

function blend(canvas, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size || a <= 0) return;
  const i = (y * canvas.size + x) * 4;
  const dst = canvas.data;
  const alpha = a / 255;
  const inv = 1 - alpha;
  dst[i] = Math.round(r * alpha + dst[i] * inv);
  dst[i + 1] = Math.round(g * alpha + dst[i + 1] * inv);
  dst[i + 2] = Math.round(b * alpha + dst[i + 2] * inv);
  dst[i + 3] = Math.min(255, Math.round(a + dst[i + 3] * inv));
}

function roundedRect(canvas, x0, y0, w, h, radius, colorAt) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const dx = Math.max(x0 + radius - x, 0, x - (x1 - radius - 1));
      const dy = Math.max(y0 + radius - y, 0, y - (y1 - radius - 1));
      const dist = Math.hypot(dx, dy);
      if (dist > radius) continue;
      const coverage = Math.min(1, Math.max(0, radius - dist + 0.5));
      const [r, g, b] = colorAt(x, y);
      blend(canvas, x, y, r, g, b, Math.round(255 * coverage));
    }
  }
}

function drawIcon(size, { maskable }) {
  const canvas = createCanvas(size);
  const gradient = (x, y) => {
    const t = y / size;
    const r = Math.round(99 + (67 - 99) * t);
    const g = Math.round(102 + (56 - 102) * t);
    const b = Math.round(241 + (202 - 241) * t);
    return [r, g, b];
  };

  if (maskable) {
    roundedRect(canvas, 0, 0, size, size, 0, gradient);
  } else {
    roundedRect(canvas, 0, 0, size, size, size * 0.22, gradient);
  }

  const scale = maskable ? 0.62 : 0.78;
  const centerX = size / 2;
  const centerY = size / 2;
  const barWidth = size * 0.062 * scale;
  const gap = size * 0.052 * scale;
  const heights = [0.34, 0.62, 0.92, 0.56, 0.3].map((value) => value * size * scale * 0.62);
  const totalWidth = heights.length * barWidth + (heights.length - 1) * gap;
  let x = centerX - totalWidth / 2;

  for (const height of heights) {
    const y = centerY - height / 2;
    roundedRect(canvas, x, y, barWidth, height, barWidth / 2, () => [255, 255, 255]);
    x += barWidth + gap;
  }

  return encodePng(size, size, canvas.data);
}

mkdirSync(outDir, { recursive: true });

const targets = [
  ['icon-192.png', 192, { maskable: false }],
  ['icon-512.png', 512, { maskable: false }],
  ['icon-maskable-512.png', 512, { maskable: true }],
  ['apple-touch-icon.png', 180, { maskable: true }],
];

for (const [name, size, options] of targets) {
  writeFileSync(join(outDir, name), drawIcon(size, options));
  console.log(`generated public/icons/${name}`);
}
