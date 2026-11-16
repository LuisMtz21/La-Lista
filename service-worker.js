const CACHE_NAME = 'la-lista-v6';
const APP_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/supabase.js',
  './js/listas.js',
  './js/elementos.js',
  './js/sincronizacion.js',
  './js/offline.js',
  './assets/icons/icon.svg',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
  './assets/icons/apple-touch-icon.png'
];
const EXTERNAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_ASSETS);
    await Promise.all(EXTERNAL_ASSETS.map(async (asset) => {
      try {
        const response = await fetch(asset, { mode: 'cors' });
        if (response.ok) await cache.put(asset, response);
      } catch (error) {
        console.warn('No se pudo precargar un recurso externo:', error);
      }
    }));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key.startsWith('la-lista-') && key !== CACHE_NAME)
        .map((key) => caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const localRequest = url.origin === self.location.origin;
  const cacheableExternal = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname);
  if (!localRequest && !cacheableExternal) return;
  event.respondWith(
    caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (response.ok || response.type === 'opaque') {
        const copy = response.clone();
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch((error) => {
          console.warn('No se pudo guardar el recurso en caché:', error);
        });
      }
      return response;
    }).catch(() => {
      if (localRequest && request.mode === 'navigate') return caches.match('./index.html');
      throw new Error('Recurso no disponible sin conexión.');
    }))
  );
});
