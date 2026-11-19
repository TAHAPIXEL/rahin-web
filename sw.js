/* RAHIN Service Worker v2.0.0 — کش پوسته اپ + کاشی‌های نقشه برای استفاده آفلاین */
const VERSION = 'rahin-v2.0.0';
const SHELL = `${VERSION}-shell`;
const TILES = `${VERSION}-tiles`;

const PRECACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/db.js',
  '/js/domain.js',
  '/js/map.js',
  '/js/navigation.js',
  '/js/voice.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/vendor/mapbox-gl-rtl-text.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE).catch(() => {})).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => ![SHELL, TILES].includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'tiles.openfreemap.org' && /\.(pbf|png|jpg|webp)$/.test(url.pathname)) {
    event.respondWith(tileFetch(req));
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() =>
          caches.match(req).then(
            (hit) =>
              hit ||
              new Response(
                JSON.stringify({
                  ok: false,
                  offline: true,
                  error: { code: 'offline', message: 'شما آفلاین هستید؛ این پاسخ از حافظه پنهان در دسترس نیست.' },
                }),
                { headers: { 'Content-Type': 'application/json; charset=utf-8' } }
              )
          )
        )
    );
    return;
  }

  // Network-first for app JS/CSS/HTML so updates take effect immediately, fallback to cache offline
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(SHELL).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/index.html')))
  );
});

async function tileFetch(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
