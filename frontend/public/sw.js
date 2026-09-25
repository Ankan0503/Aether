const CACHE_NAME = 'aether-pwa-v2';
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/aether-logo.svg',
  '/icons/aether-icon-192.png',
  '/icons/aether-icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys()
        .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))),
      self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve(),
    ])
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const isNavigation = event.request.mode === 'navigate';

  event.respondWith(
    (isNavigation && event.preloadResponse ? event.preloadResponse : fetch(event.request))
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/')))
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (err) {
    data = { title: 'AETHER alert', body: event.data ? event.data.text() : 'New mesh notification.' };
  }

  const severity = data.severity || 'info';
  const title = data.title || 'AETHER notification';
  const options = {
    body: data.body || data.message || 'Aether mesh event received.',
    icon: '/icons/aether-icon-192.png',
    badge: '/icons/aether-icon-192.png',
    tag: data.tag || 'aether-notification',
    renotify: severity === 'critical' || severity === 'danger',
    requireInteraction: severity === 'critical' || severity === 'danger',
    data: {
      url: data.url || '/',
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data?.url || '/', self.location.origin).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((client) => client.url.startsWith(self.location.origin));
      if (existing) {
        existing.focus();
        existing.navigate(targetUrl);
        return;
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
