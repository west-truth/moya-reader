/* Replaced at build time. Only declared public app assets enter this cache. */
const BUILD = { version: '__BUILD_VERSION__', files: [] };
const BASE = new URL(self.registration.scope).pathname;
const PREFIX = `moya-web-shell:${encodeURIComponent(BASE)}:`;
const CACHE = PREFIX + BUILD.version;
const PUBLIC_FILES = new Map(BUILD.assets.map((asset) => [new URL(asset.url, self.location.origin).href, asset]));
const INTEGRITY_HEADER = 'X-Moya-Asset-Revision';
const FULL_OFFLINE = new URL('__offline-complete', self.registration.scope).href;
let preparation;
const observers = new Set();

async function previousCaches() {
  return (await caches.keys()).filter((key) => key.startsWith(PREFIX) && key !== CACHE).reverse();
}

async function storeAsset(asset, cache, previous) {
  const current = await cache.match(asset.url);
  if (current?.headers.get(INTEGRITY_HEADER) === asset.integrity) return current;
  // HTML may be modified by local content filters (e.g. AdGuard). Always refresh it for a new version.
  for (const name of asset.verify === false ? [] : previous) {
    const response = await (await caches.open(name)).match(asset.url);
    if (response?.headers.get(INTEGRITY_HEADER) === asset.integrity) {
      await cache.put(asset.url, response.clone());
      return response;
    }
  }
  const response = await fetch(
    new Request(asset.url, { cache: 'no-cache', integrity: asset.verify === false ? '' : asset.integrity }),
  );
  if (!response.ok || response.status !== 200) throw new Error('asset-download-failed');
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.set(INTEGRITY_HEADER, asset.integrity);
  const stored = new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  await cache.put(asset.url, stored.clone());
  return stored;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      const previous = await previousCaches();
      try {
        const keepFullOffline = (
          await Promise.all(previous.map(async (name) => Boolean(await (await caches.open(name)).match(FULL_OFFLINE))))
        ).some(Boolean);
        // Optional PDF/archive downloads must never block installation of the initial screen.
        // If the user chose full offline, preserve that guarantee before offering an update.
        for (const url of keepFullOffline ? BUILD.files : BUILD.precache)
          await storeAsset(PUBLIC_FILES.get(new URL(url, self.location.origin).href), cache, previous);
        if (keepFullOffline) await cache.put(FULL_OFFLINE, new Response('ready'));
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
      const versions = await previousCaches();
      await Promise.all(versions.slice(1).map((key) => caches.delete(key)));
      await self.clients.claim();
    })(),
  );
});

async function offlineStatus() {
  const cache = await caches.open(CACHE);
  const cached = await Promise.all(
    BUILD.assets.map(async (asset) => {
      const response = await cache.match(asset.url);
      return response?.headers.get(INTEGRITY_HEADER) === asset.integrity;
    }),
  );
  return {
    version: BUILD.version,
    total: BUILD.assets.length,
    completed: cached.filter(Boolean).length,
    totalBytes: BUILD.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    cachedBytes: BUILD.assets.reduce((sum, asset, index) => sum + (cached[index] ? asset.bytes : 0), 0),
    preparing: Boolean(preparation),
  };
}

function broadcast(value) {
  for (const port of observers) port.postMessage(value);
}

async function prepareOffline() {
  const cache = await caches.open(CACHE);
  const previous = await previousCaches();
  const status = await offlineStatus();
  broadcast({ type: 'progress', ...status });
  // Bounded work resumes from already cached assets after a connection or quota failure.
  for (const asset of BUILD.assets) {
    const present = await cache.match(asset.url);
    if (present?.headers.get(INTEGRITY_HEADER) === asset.integrity) continue;
    await storeAsset(asset, cache, previous);
    status.completed += 1;
    status.cachedBytes += asset.bytes;
    broadcast({ type: 'progress', ...status, preparing: true });
  }
  await cache.put(FULL_OFFLINE, new Response('ready'));
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') {
    event.waitUntil(self.skipWaiting());
    return;
  }
  const port = event.ports?.[0];
  if (!port) return;
  if (event.data?.type === 'OFFLINE_STATUS') {
    event.waitUntil(
      offlineStatus()
        .then((status) => port.postMessage({ type: 'status', ...status }))
        .catch(() => port.postMessage({ type: 'error' })),
    );
  } else if (event.data?.type === 'PREPARE_OFFLINE') {
    observers.add(port);
    if (!preparation) {
      preparation = prepareOffline()
        .then(async () => broadcast({ type: 'complete', ...(await offlineStatus()), preparing: false }))
        .catch(() => broadcast({ type: 'error' }))
        .finally(() => {
          preparation = undefined;
          observers.clear();
        });
    }
    event.waitUntil(preparation);
  }
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
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const asset = PUBLIC_FILES.get(url.href);
        const page = asset?.url ?? `${BASE}index.html`;
        return (await cache.match(page)) ?? fetch(request);
      })(),
    );
  } else if (PUBLIC_FILES.has(url.href) || url.pathname.startsWith(`${BASE}assets/`)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        const asset = PUBLIC_FILES.get(url.href);
        const current = await cache.match(request);
        if (current) return current;
        const previous = await previousCaches();
        if (asset) {
          try {
            return await storeAsset(asset, cache, previous);
          } catch {
            return fetch(request);
          } // Online reading survives cache quota failure.
        }
        // An older open tab may still request a previous version's hashed lazy chunk.
        for (const name of previous) {
          const cached = await (await caches.open(name)).match(request);
          if (cached) return cached;
        }
        return fetch(request); // Unknown URLs and query strings are never cached.
      })(),
    );
  }
});
