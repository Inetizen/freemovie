const CACHE_NAME = 'hotfake-cache-v2'; // Jab bhi major update ho, ise v3 karein

// Nayi files add kar di gayi hain
const urlsToCache = [
  '/',
  '/index.html',
  '/downloads.html', 
  '/100.png',
  '/LargeTile.scale-100.png',
  '/manifest.json'
];

// 1. Install Event
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Essential files cached!');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. Activate Event (Purane cache delete karne ke liye)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// 3. Fetch Event
self.addEventListener('fetch', event => {
  // Firebase, API, aur Ad network ko ignore karein
  if (event.request.url.includes('firebaseio.com') || 
      event.request.url.includes('ipapi.co') ||
      event.request.url.includes('google-analytics')) {
     return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Agar net chal raha hai, toh latest file cache mein update karo
        if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseClone);
            });
        }
        return response;
      })
      .catch(() => {
        // Agar OFFLINE hain, toh Cache mein check karo
        return caches.match(event.request);
      })
  );
});
