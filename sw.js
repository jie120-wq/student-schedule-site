const CACHE_NAME = 'student-schedule-v3';
const APP_SHELL = ['./', './index.html', './manifest.webmanifest', './app-icon.svg'];

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
