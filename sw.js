const CACHE_NAME = 'student-schedule-v8';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest?v=20261101',
  './apple-touch-icon.png?v=20261101',
  './icon-192-v2.png',
  './icon-512-v2.png',
  './icon-512-maskable-v2.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('student-schedule-') && key !== CACHE_NAME)
          .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async error => {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
        throw error;
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).catch(error => {
        if (request.mode === 'navigate') {
          return caches.match('./index.html').then(fallback => {
            if (fallback) return fallback;
            throw error;
          });
        }
        throw error;
      });
    })
  );
});
