/**
 * 淇肌淨膚 QIJI Service Worker
 * 策略：
 * - HTML 用 NetworkFirst（保證內容新鮮，離線時 fallback cache）
 * - 圖片用 StaleWhileRevalidate（先回 cache 再背景更新）
 * - JSON / 字體 / favicon 用 CacheFirst（變更頻率低）
 */
const CACHE_VERSION = 'qiji-v1-2026-04-26';
const HTML_CACHE = 'qiji-html-' + CACHE_VERSION;
const STATIC_CACHE = 'qiji-static-' + CACHE_VERSION;
const IMG_CACHE = 'qiji-img-' + CACHE_VERSION;

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/favicon.svg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => cache.addAll(PRECACHE_URLS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => !k.endsWith(CACHE_VERSION))
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

function isImg(url) {
  return /\.(png|jpg|jpeg|webp|avif|gif|svg)(\?|$)/i.test(url);
}
function isHTML(req) {
  return req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 跳過跨網域：cloudinary, google, line, freetime
  if (url.origin !== self.location.origin) return;

  if (isHTML(req)) {
    // NetworkFirst for HTML
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(HTML_CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  if (isImg(url.pathname)) {
    // StaleWhileRevalidate for images
    event.respondWith(
      caches.open(IMG_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const fetchPromise = fetch(req).then((res) => {
            cache.put(req, res.clone());
            return res;
          }).catch(() => cached);
          return cached || fetchPromise;
        })
      )
    );
    return;
  }

  // CacheFirst for everything else (json, css, js, fonts)
  event.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
