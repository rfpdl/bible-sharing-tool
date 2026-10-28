// Caches the app shell so Bible Sharing Tool opens offline. Bump VERSION when shipping changes.
const VERSION = 'bst-v14';
// The page is cached under './' only: Cloudflare redirects /index.html to /, and a cached
// redirect can't be used to answer a navigation, which would break opening the app offline.
const PAGE = './';
const SHELL = [PAGE, './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png', './icon-maskable-512.png',
  './fonts/inter-normal.woff2', './fonts/newsreader-normal.woff2', './fonts/newsreader-italic.woff2'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Pages: network first so a new deploy shows up immediately, cache when offline.
// Other same-origin files: cache first, refreshed in the background.
// Verse text (bible.helloao.org) is cached by the page in localStorage, so it passes through here.
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok && !res.redirected) caches.open(VERSION).then(c => c.put(PAGE, res.clone()));
          return res;
        })
        .catch(() => caches.match(PAGE))
    );
    return;
  }

  e.respondWith(
    caches.open(VERSION).then(async cache => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request)
        .then(res => { if (res.ok && !res.redirected) cache.put(e.request, res.clone()); return res; })
        .catch(() => cached);
      return cached || fresh;
    })
  );
});
