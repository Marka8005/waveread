// Minimal service worker — required for "add to home screen".
// Network-first passthrough; never caches API responses.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.url.includes('/api/')) return; // always hit network for analyses
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
