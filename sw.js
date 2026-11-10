// Service worker: lets the site open without a connection after the first visit.
// - The engine files never change under the same name, so they are served from the saved copy.
// - Everything else on this site is fetched fresh when online (so your edits show up straight away)
//   and served from the saved copy only when offline.
// - Requests to Chess.com are left alone: fetching games always needs a connection.
// To force every visitor to drop the saved copies, change the number in CACHE.

const CACHE = 'second-look-v1';
const FILES = ['./', 'index.html', 'style.css', 'pieces.css', 'app.js', 'util.js', 'engine.js', 'board.js', 'analysis.js',
  'tactics.js', 'games.js', 'train.js', 'progress.js', 'store.js', 'sound.js', 'chess.js', 'openings.json',
  'stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(FILES.map(f => c.add(f).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const keep = res => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return res; };
  if (url.pathname.includes('stockfish')) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(keep)));
  } else {
    e.respondWith(fetch(e.request).then(keep).catch(() => caches.match(e.request, { ignoreSearch: true }).then(hit => hit || Response.error())));
  }
});
