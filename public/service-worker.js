// public/service-worker.js

const CACHE_NAME = 'recip-cache-v1';
// Add core assets to cache. Add icons once they exist.
const urlsToCache = [
  '/',
  '/index.html', // Explicitly cache index.html for offline fallback
  '/style.css',
  '/script.js',
  '/manifest.json',
  '/icons/icon-192x192.png', // Make sure this path is correct
  '/icons/icon-512x512.png'  // Make sure this path is correct
  // Add '/icons/apple-touch-icon.png' if you created it
];

// Install event: Open cache and add core assets
self.addEventListener('install', event => {
  console.log('Service Worker: Install event');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching app shell');
        return cache.addAll(urlsToCache);
      })
      .then(() => {
         console.log('Service Worker: Installation complete, skipping waiting.');
         return self.skipWaiting(); // Activate worker immediately
      })
      .catch(error => {
         console.error('Service Worker: Caching failed during install:', error);
      })
  );
});

// Activate event: Clean up old caches
self.addEventListener('activate', event => {
  console.log('Service Worker: Activate event');
  const cacheWhitelist = [CACHE_NAME]; // Only keep the current cache version
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cacheName => {
          if (cacheWhitelist.indexOf(cacheName) === -1) {
            console.log('Service Worker: Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
       console.log('Service Worker: Claiming clients.');
       return self.clients.claim(); // Take control of existing pages
    })
  );
});

// Fetch event: Serve from cache first, then network
self.addEventListener('fetch', event => {
  // Only handle GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // For navigation requests (HTML pages), try network first, then cache, then offline page (optional)
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
           console.log('Service Worker: Network fetch failed for navigation, trying cache for /');
           return caches.match('/'); // Fallback to cached root index.html
           // Optionally return a specific offline.html page: caches.match('/offline.html')
        })
    );
    return;
  }

  // For other assets (CSS, JS, images in urlsToCache), use Cache First strategy
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        if (cachedResponse) {
          // console.log('Service Worker: Returning from cache:', event.request.url);
          return cachedResponse; // Serve from cache
        }
        // console.log('Service Worker: Fetching from network:', event.request.url);
        return fetch(event.request); // Fetch from network if not in cache
        // Optional: Clone response and put it in cache for next time?
        // .then(networkResponse => {
        //   if (networkResponse && networkResponse.status === 200) {
        //     const responseToCache = networkResponse.clone();
        //     caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
        //   }
        //   return networkResponse;
        // })
      })
      .catch(error => {
          console.error('Service Worker: Error during fetch:', error);
          // Optionally provide a fallback response or error indication
      })
  );
});