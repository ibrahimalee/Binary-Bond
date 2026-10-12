// App-shell service worker. Network-first so deploys take effect immediately;
// the cache is only an offline fallback. API, websocket and dashboard data are
// never cached.
const CACHE = 'bb-shell-v3';
const SHELL = [
  '/', '/css/app.css', '/icon.svg', '/manifest.webmanifest',
  '/js/app.js', '/js/util.js', '/js/crypto.js', '/js/signaling.js', '/js/mesh.js', '/js/media.js',
  '/js/transfer.js', '/js/chat.js', '/js/panels.js', '/js/ui.js', '/js/qr.js',
  '/js/board.js', '/js/recorder.js', '/js/captions.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|v1|admin|billing|ws|metrics|healthz)/.test(url.pathname)) return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok && SHELL.includes(url.pathname)) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('/'))),
  );
});
