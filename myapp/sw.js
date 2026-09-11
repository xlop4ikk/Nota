/* Nota service worker: app-shell caching + offline support.
   Uses relative paths so it works on GitHub Pages project sites
   (https://user.github.io/repo/). */

const VERSION = "nota-v1";
const CACHE_NAME = `nota-${VERSION}`;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./manifest.webmanifest",
  "./js/app.js",
  "./js/store.js",
  "./js/i18n.js",
  "./js/notify.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  const sameOrigin = url.origin === self.location.origin;

  if (request.mode === "navigate") {
    // Network-first for HTML so updates arrive quickly, cache as offline fallback.
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  if (sameOrigin) {
    // Cache-first for local static assets.
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
      )
    );
    return;
  }

  // Runtime cache for third-party resources (Google Fonts).
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok || response.type === "opaque") {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});

// Ready for real Web Push later (requires a push server / service).
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    try { data = { body: event.data ? event.data.text() : "" }; }
    catch { data = {}; }
  }

  const title = data.title || "Nota";
  const body = data.body || "Напоминание";
  const tag = data.tag || ("nota-" + Date.now()); // уникальный!
  const taskId = data.taskId;

  const fullOptions = {
    body,
    tag,
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { taskId },
  };

  event.waitUntil(
    self.registration.showNotification(title, fullOptions)
      .catch(() => self.registration.showNotification(title, { body, tag }))
      .catch(() => self.registration.showNotification(title))
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const taskId = event.notification.data && event.notification.data.taskId;
  const target = taskId ? `./?task=${encodeURIComponent(taskId)}` : "./";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ("focus" in client) {
          client.postMessage({ type: "open-task", taskId });
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
