const CACHE = 'eastc-food-court-v1';
const SHELL = ['/', '/pos.html', '/kitchen.html', '/css/platform.css', '/favicon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api') || url.pathname.startsWith('/pay') || event.request.method !== 'GET') return;
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});

self.addEventListener('push', (event) => {
  const payload = event.data ? event.data.json() : { title: 'Food Court', body: 'Your order is ready.' };
  event.waitUntil(self.registration.showNotification(payload.title || 'Food Court', { body: payload.body, icon: '/favicon.svg' }));
});
