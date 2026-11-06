// 離線殼：App 檔案與 Firebase SDK 存在手機上，沒網路也能打開。
// 帳目資料由 Firestore 自己的離線快取處理，這裡不攔截 Firestore 的連線。
const VERSION = 'tripsplit-v1.1.0';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/firebase.js',
  './js/money.js',
  './js/parse.js',
  './js/store.js',
  './js/ai.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];
const SDK = 'https://www.gstatic.com/firebasejs/13.2.0/';
const SDK_FILES = ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js', 'firebase-ai.js'].map((f) => SDK + f);

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // SDK 抓不到不影響安裝，之後用到時會再快取
    await Promise.all(SDK_FILES.map((u) => cache.add(u).catch(() => null)));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isShell = url.origin === self.location.origin;
  const isSdk = url.href.startsWith('https://www.gstatic.com/firebasejs/');
  if (!isShell && !isSdk) return; // Firestore、登入、AI 等請求直接走網路

  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    if (isSdk) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    // App 檔案：先用網路拿最新版，沒網路才用快取
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') return cache.match('./index.html');
      throw new Error('offline');
    }
  })());
});
