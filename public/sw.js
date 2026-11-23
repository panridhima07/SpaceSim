// Offline support for the website build. Pages (navigations and .html) go network-first so a
// new release is picked up on the next load, falling back to the cache when offline. Other
// same-origin GETs (hashed assets, images) are served from cache and refreshed in the background.
const CACHE = 'sfb-v2';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', './manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// Only successful, same-origin ("basic") responses are worth keeping; never opaque or error ones.
function cacheable(res) {
  return res && res.ok && res.type === 'basic';
}

function isPage(req, url) {
  return req.mode === 'navigate' || url.pathname.endsWith('.html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (isPage(req, url)) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        try {
          const res = await fetch(req);
          if (cacheable(res)) cache.put(req, res.clone());
          return res;
        } catch (err) {
          const cached = (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('./') : undefined);
          if (cached) return cached;
          throw err;
        }
      }),
    );
    return;
  }

  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const fresh = fetch(req).then((res) => {
        if (cacheable(res)) cache.put(req, res.clone());
        return res;
      });
      if (cached) {
        fresh.catch(() => {}); // background refresh; offline failures are fine
        return cached;
      }
      return fresh;
    }),
  );
});
