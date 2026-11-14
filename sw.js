/* HEALA Handshake: offline cache. Caches local files only; never talks to any other site.
   When you add a new file the app needs, add it to FILES and change CACHE (for example heala-v2). */
const CACHE = 'heala-v1';
const FILES = [
  './', './index.html', './card.html',
  './js/data.js', './js/engine.js', './js/app.js', './js/pwa.js',
  './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Network first (so updates arrive when online), cache when offline or when the network takes over 3 seconds.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(answer(req));
});

function fromCache(req) {
  return caches.match(req, { ignoreSearch: true })
    .then(r => r || (req.mode === 'navigate' ? caches.match('./index.html') : undefined));
}

function answer(req) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done && r) { done = true; resolve(r); } };
    const timer = setTimeout(() => { fromCache(req).then(finish); }, 3000);
    fetch(req).then(res => {
      clearTimeout(timer);
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      finish(res);
    }).catch(() => {
      clearTimeout(timer);
      fromCache(req).then(r => { if (r) finish(r); else if (!done) { done = true; resolve(Response.error()); } });
    });
  });
}
