/* ============================================================
   Nota — Service Worker.
   1) кэш оболочки для офлайна;
   2) приём push-уведомлений от Cloudflare Worker.

   ВАЖНО: при каждом деплое фронтенда поднимайте VERSION
   (nota-v1 → nota-v2 ...), иначе пользователи останутся на старом кэше.
   ============================================================ */

"use strict";

const VERSION = "nota-v1";
const CACHE_NAME = VERSION;

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

const ICON_192 = "./icons/icon-192.png";
const DEFAULT_URL = new URL("./", self.location.href).href;

/* ---------- 1. install: кэш оболочки ---------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting())
  );
});

/* ---------- 2. activate: чужие кеши долой ---------- */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

/* ---------- 3. fetch: cache-first для своего происхождения ---------- */

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(
      (hit) =>
        hit ||
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
          })
          /* Нет сети и нет кэша — отдаём оболочку */
          .catch(() => caches.match("./index.html"))
    )
  );
});

/* ---------- 4. push ----------
   Правила, проверенные на практике:
   - показываем уведомление ВСЕГДА, даже если payload битый (иначе iOS
     отзывает разрешение на push);
   - showNotification вызывается ПЕРВЫМ ДЕЛОМ внутри waitUntil, без await
     до него — у Service Worker на показ всего несколько секунд жизни;
   - tag уникален на каждое уведомление: с одинаковым tag Chrome молча
     заменяет старое уведомление новым, без звука. */

function showWithFallback(registration, title, body, tag, url) {
  const full = {
    body: body,
    tag: tag,
    icon: ICON_192,
    badge: ICON_192,
    vibrate: [90, 60, 90],
    data: { url: url || DEFAULT_URL },
  };
  return registration
    .showNotification(title, full)
    /* Часть опций не поддерживается (например vibrate) — пробуем короче */
    .catch(() => registration.showNotification(title, { body: body, tag: tag }))
    /* И совсем уж минимальный вариант */
    .catch(() => registration.showNotification(title));
}

self.addEventListener("push", (event) => {
  /* Читаем payload синхронно: никаких await до showNotification */
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch (err) {
      try {
        data = { body: event.data.text() };
      } catch (err2) {
        data = {};
      }
    }
  }

  const title = (data && data.title) || "Nota";
  const body = (data && data.body) || "Напоминание из Nota";
  /* Случайная часть обязательна: два push, пришедших в одну миллисекунду,
     получили бы одинаковый tag — и Chrome заменил бы первое уведомление
     вторым молча, без звука. */
  const tag = "nota-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);

  event.waitUntil(showWithFallback(self.registration, title, body, tag, data && data.url));
});

/* ---------- 5. notificationclick ---------- */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || DEFAULT_URL;

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if ("focus" in client) {
            /* Открытое приложение: показываем нужную задачу без перезагрузки */
            client.postMessage({ type: "nota:open", url: url });
            return client.focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
