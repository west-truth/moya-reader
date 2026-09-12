/* The build replaces this declaration with a versioned, complete application asset list. */
const BUILD = { version: '__BUILD_VERSION__', files: [] };
const BASE = new URL(self.registration.scope).pathname;
const PREFIX = `moya-web-shell:${encodeURIComponent(BASE)}:`;
const CACHE = PREFIX + BUILD.version;
const PUBLIC_FILES = new Set(BUILD.files.map((file) => new URL(file, self.location.origin).href));

self.addEventListener('install', (event) => {
  // A partially downloaded application must never replace a working offline version.
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        for (let offset = 0; offset < BUILD.files.length; offset += 8) {
          await cache.addAll(BUILD.files.slice(offset, offset + 8).map((url) => new Request(url, { cache: 'reload' })));
        }
      } catch (error) {
        await caches.delete(CACHE);
        throw error;
      }
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Retain the previous version for another tab's still-running lazy imports.
      const versions = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE);
      await Promise.all(versions.slice(0, -1).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') event.waitUntil(self.skipWaiting());
});

function bypass(request, url) {
  return (
    request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    !url.pathname.startsWith(BASE) ||
    request.headers.has('authorization') ||
    request.headers.has('range') ||
    url.pathname.startsWith(`${BASE}api/`) ||
    url.pathname === `${BASE}runtime-config.js` ||
    url.pathname === `${BASE}sw.js`
  );
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (bypass(request, url)) return;
  if (request.mode === 'navigate') {
    // Match the HTML to this worker's installed chunks, including during an update.
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const page = PUBLIC_FILES.has(url.href) ? url.href : `${BASE}index.html`;
        return (await cache.match(page)) ?? fetch(request);
      })(),
    );
  } else if (PUBLIC_FILES.has(url.href) || url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const current = await cache.match(request);
        if (current) return current;
        const previous = (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE);
        for (const key of previous) {
          const cached = await (await caches.open(key)).match(request);
          if (cached) return cached;
        }
        return fetch(request);
      })(),
    );
  }
});
