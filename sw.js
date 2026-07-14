const CACHE_NAME = 'hotfake-cache-v2'; // Jab bhi website me bada change karein, iska version badha dein (v3, v4...)

const urlsToCache = [
  '/',
  '/index.html'
];

// 1. Install Event (Files ko offline save karne ke liye)
self.addEventListener('install', event => {
  self.skipWaiting(); // Naya Service Worker turant active ho jaye
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Site files saved for offline!');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. Activate Event (Purane useless cache ko delete karne ke liye - YE MISSING THA)
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            console.log('Purana cache delete kiya gaya:', cache);
            return caches.delete(cache); // Delete old versions
          }
        })
      );
    })
  );
});

// 3. Fetch Event (Network-First Strategy - TAKI UPDATES HAMESHA MILEIN)
self.addEventListener('fetch', event => {
  // Firebase aur external API requests ko ignore karein taaki wo direct internet se chalein
  if (event.request.url.includes('firebaseio.com') || event.request.url.includes('ipapi.co')) {
     return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response => {
        // Agar internet chal raha hai, toh latest file server se lo aur cache ko bhi update kar do
        if (response && response.status === 200) {
            const responseClone = response.clone();
            caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseClone);
            });
        }
        return response;
      })
      .catch(() => {
        // Agar user OFFILNE hai (internet nahi hai), tabhi Cache se file load karo
        return caches.match(event.request);
      })
  );
});
