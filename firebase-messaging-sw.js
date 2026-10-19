// Service Worker unificat — cache + Firebase Messaging
// MTC Transport v7

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// ── FIREBASE MESSAGING ────────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyA1O2Lw3unTXECgCtp2bdYuHjgfVqPEW6U",
  authDomain: "flota-firma.firebaseapp.com",
  projectId: "flota-firma",
  storageBucket: "flota-firma.firebasestorage.app",
  messagingSenderId: "281579444434",
  appId: "1:281579444434:web:facb358aa0434a2c00b50b"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background FCM message:', JSON.stringify(payload));
  const title = payload.notification?.title || payload.data?.title || 'MTC Transport';
  const body = payload.notification?.body || payload.data?.body || '';

  // Tag fix bazat pe conținut — previne notificări duplicate
  const tag = 'mtc-' + btoa(title + body).slice(0, 16);

  self.registration.showNotification(title, {
    body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag, // același tag = înlocuiește notificarea existentă în loc să adauge alta
    renotify: false,
    data: payload.data || {},
    requireInteraction: true,
    vibrate: [200, 100, 200]
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('mtctransportgmbh.github.io') && 'focus' in client) {
          return client.focus();
        }
      }
      return clients.openWindow('https://mtctransportgmbh.github.io');
    })
  );
});

// ── CACHE (PWA offline) ───────────────────────────────────────
const CACHE = 'flota-v7';
const ASSETS = ['./', './index.html', './manifest.json', './config.js'];

self.addEventListener('install', e => {
  console.log('[SW] Installing v7...');
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  console.log('[SW] Activating v7...');
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = e.request.url;
  if (url.includes('firebaseio') || url.includes('googleapis') ||
      url.includes('firebase') || url.includes('gstatic')) {
    return;
  }
  e.respondWith(
    // cache:'no-cache' = ocolește cache-ul HTTP al browserului/CDN (GitHub Pages ține 10 min) -> mereu versiunea nouă
    fetch(e.request, { cache: 'no-cache' })
      .then(resp => {
        if (e.request.method === 'GET' && resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});

self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

console.log('[SW] sw.js v7 unificat activ ✓');
