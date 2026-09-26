const CACHE_NAME = 'spotify-pwa-shell-v1';
const AUDIO_CACHE_NAME = 'spotify-pwa-audio-v1';

const APP_SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/manifest.json'
];

// Install Event: Pre-cache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching App Shell');
      return cache.addAll(APP_SHELL);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event: Clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== AUDIO_CACHE_NAME) {
            console.log('[SW] Removing old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event: Cache First for static assets & Audio Cache for songs
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // If request is for audio streaming or uploaded cover images, try Audio Cache first
  if (url.pathname.startsWith('/api/stream') || url.pathname.startsWith('/uploads')) {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          console.log('[SW] Serving from audio cache:', url.pathname);
          return cachedResponse;
        }

        return fetch(event.request).then((networkResponse) => {
          // If offline download header or audio request, we can cache if needed
          return networkResponse;
        }).catch(() => {
          return new Response('Offline audio unavailable', { status: 503, statusText: 'Offline' });
        });
      })
    );
    return;
  }

  // App shell & static files: Network first with Cache fallback
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (event.request.method === 'GET' && networkResponse.status === 200) {
          const resClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) return cachedResponse;
          if (event.request.headers.get('accept').includes('text/html')) {
            return caches.match('/index.html');
          }
        });
      })
  );
});
