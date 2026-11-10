import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** ベンチ専用の Vite 設定。リポジトリ直下をルートにして bench/ を配信する。 */
export default defineConfig({
  root: repoRoot,
  base: '/',
  server: { port: 5199, strictPort: true },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
