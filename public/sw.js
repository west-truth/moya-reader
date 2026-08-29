const CACHE_NAME = 'moya-app-shell-v4';
const APP_SHELL = ['/', '/manifest.webmanifest', '/icons/moya-32.png', '/icons/moya-192.png', '/icons/moya-512.png'];
const IS_TAURI_SHELL = self.location.hostname === 'tauri.localhost' || self.location.protocol === 'tauri:';

if (IS_TAURI_SHELL) {
  self.addEventListener('install', (event) => {
    event.waitUntil(self.skipWaiting());
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
        .then(() => self.registration.unregister())
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((clients) => Promise.all(clients.map((client) => client.navigate(client.url)))),
    );
  });
} else {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.addAll(APP_SHELL))
        .then(() => self.skipWaiting()),
    );
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
        .then(() => self.clients.claim()),
    );
  });

  function shouldBypass(request, url) {
    return (
      request.method !== 'GET' ||
      url.origin !== self.location.origin ||
      url.pathname === '/runtime-config.js' ||
      url.pathname.startsWith('/api/') ||
      request.headers.has('authorization') ||
      request.headers.has('range')
    );
  }

  async function networkFirst(request, fallbackUrl) {
    try {
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put(request, response.clone());
      }
      return response;
    } catch (error) {
      const cached = await caches.match(request);
      if (cached) return cached;
      if (fallbackUrl) {
        const fallback = await caches.match(fallbackUrl);
        if (fallback) return fallback;
      }
      throw error;
    }
  }

  self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);
    if (shouldBypass(event.request, url)) return;

    if (event.request.mode === 'navigate') {
      event.respondWith(networkFirst(event.request, '/'));
      return;
    }

    if (
      url.pathname === '/manifest.webmanifest' ||
      url.pathname.startsWith('/icons/') ||
      url.pathname.startsWith('/branding/')
    ) {
      event.respondWith(networkFirst(event.request));
      return;
    }

    if (url.pathname.startsWith('/assets/')) {
      event.respondWith(
        caches.match(event.request).then(async (cached) => {
          if (cached) return cached;
          const response = await fetch(event.request);
          if (response.ok) {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(event.request, response.clone());
          }
          return response;
        }),
      );
    }
  });
}
