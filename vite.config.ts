import { defineConfig, type Plugin } from 'vite';

declare const process: { env: Record<string, string | undefined> };

const REPO = 'g0083-symple-audio-splitter';
const base = process.env.BASE_PATH ?? `/${REPO}/`;

function hash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function serviceWorkerSource(version: string, precache: string[], baseUrl: string): string {
  return `/* Symple Audio Splitter - generated service worker */
const VERSION = ${JSON.stringify(version)};
const CACHE = 'sas-' + VERSION;
const CDN_CACHE = 'sas-cdn-v1';
const BASE = ${JSON.stringify(baseUrl)};
const PRECACHE = ${JSON.stringify(precache)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (err) {
        /* ignore individual failures */
      }
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((key) => key !== CACHE && key !== CDN_CACHE).map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        await cache.put(BASE + 'index.html', fresh.clone());
        return fresh;
      } catch (err) {
        const cached = await caches.match(BASE + 'index.html');
        return cached || Response.error();
      }
    })());
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cached = await caches.match(request, { ignoreSearch: true });
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE);
        await cache.put(request, response.clone());
      }
      return response;
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(CDN_CACHE);
    const cached = await cache.match(request);
    const network = fetch(request)
      .then(async (response) => {
        if (response.ok) await cache.put(request, response.clone());
        return response;
      })
      .catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
`;
}

function serviceWorkerPlugin(): Plugin {
  return {
    name: 'symple-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const emitted = Object.keys(bundle).filter((file) => !file.endsWith('.map'));
      const precache = [
        `${base}index.html`,
        `${base}manifest.webmanifest`,
        `${base}icons/icon-192.png`,
        `${base}icons/icon-512.png`,
        `${base}icons/icon-maskable-512.png`,
        ...emitted.map((file) => base + file),
      ];
      const unique = [...new Set(precache)];
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: serviceWorkerSource(hash(unique.join('|')), unique, base),
      });
    },
  };
}

export default defineConfig({
  base,
  plugins: [serviceWorkerPlugin()],
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    cssMinify: true,
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
  },
});
