/* Nota: локальный reminder-loop + Web Push подписка. */

const API_BASE = "https://nota.xatabeach42.workers.dev"; // ← ЗАМЕНИТЕ
const CHECK_INTERVAL_MS = 20_000;
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

let timer = null;

function fireNotification(task) {
  const title = "Nota";
  const options = {
    body: task.title,
    tag: `nota-${Date.now()}`, // уникальный tag!
    icon: "./icons/icon-192.png",
    badge: "./icons/icon-192.png",
    data: { taskId: task.id },
  };
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    return navigator.serviceWorker.ready
      .then((reg) => reg.showNotification(title, options))
      .catch(() => new Notification(title, options));
  }
  try {
    new Notification(title, options);
    return Promise.resolve();
  } catch {
    return Promise.resolve();
  }
}

export function notificationSupported() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function permissionState() {
  if (!notificationSupported()) return "unsupported";
  return Notification.permission;
}

export async function requestPermission() {
  if (!notificationSupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    return new Promise((resolve) => {
      try { Notification.requestPermission(resolve); }
      catch { resolve("denied"); }
    });
  }
}

export async function registerServiceWorker(url = "sw.js") {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register(url); }
  catch { return null; }
}

/* ---------- userId ---------- */

const USER_ID_KEY = "nota.userId.v1";

export function getUserId() {
  try {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = "user_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  } catch {
    return "user_anon";
  }
}

/* ---------- base64url ---------- */

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

/* ---------- Подписка на Web Push ---------- */

export async function subscribeToPush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return { ok: false, reason: "unsupported" };
  }

  const perm = await requestPermission();
  if (perm !== "granted") return { ok: false, reason: perm };

  // VAPID публичный ключ
  let vapidKey;
  try {
    const res = await fetch(`${API_BASE}/api/vapid-public-key`);
    const text = (await res.text()).trim();
    if (!/^[A-Za-z0-9_-]{87}$/.test(text)) {
      return { ok: false, reason: "bad-vapid-key" };
    }
    vapidKey = text;
  } catch {
    return { ok: false, reason: "network" };
  }

  const reg = await navigator.serviceWorker.ready;
  let sub;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey),
      });
    }
  } catch (err) {
    return { ok: false, reason: "subscribe-failed", error: err.message };
  }

  // Отправляем на сервер
  const userId = getUserId();
  const tzOffsetMin = new Date().getTimezoneOffset();
  try {
    const res = await fetch(`${API_BASE}/api/subscribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, subscription: sub.toJSON(), tzOffsetMin }),
    });
    if (!res.ok) return { ok: false, reason: "server" };
  } catch {
    return { ok: false, reason: "network" };
  }

  try { localStorage.setItem("nota.pushEnabled.v1", "1"); } catch {}
  return { ok: true };
}

export async function unsubscribeFromPush() {
  try { localStorage.setItem("nota.pushEnabled.v1", "0"); } catch {}
  if (!("serviceWorker" in navigator)) return;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  const userId = getUserId();
  await fetch(`${API_BASE}/api/unsubscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId, endpoint }),
  }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
}

export async function isSubscribed() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) return false;
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return Boolean(sub);
}

/* ---------- Синхронизация задач на сервер ---------- */

let syncTimer = null;

export function syncToServer(items) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(async () => {
    try {
      await fetch(`${API_BASE}/api/items/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: getUserId(),
          items,
          tzOffsetMin: new Date().getTimezoneOffset(),
        }),
      });
    } catch { /* offline — попробуем при следующем изменении */ }
  }, 1000);
}

/* ---------- Локальный reminder-loop ---------- */

export async function flushDueReminders(tasks, options = {}) {
  const { persist, onFired } = options;
  if (permissionState() !== "granted") return 0;
  const now = Date.now();
  const due = [];
  let changed = false;
  for (const task of tasks) {
    if (task.done || !task.due || task.notified) continue;
    const dueAt = new Date(task.due).getTime();
    if (Number.isNaN(dueAt) || dueAt > now) continue;
    task.notified = true;
    changed = true;
    if (now - dueAt > STALE_AFTER_MS) continue;
    due.push(task);
  }
  if (changed && persist) persist(tasks);
  if (!due.length) return 0;
  await Promise.all(due.map((task) => fireNotification(task)));
  if (onFired) onFired(due.length);
  return due.length;
}

export function startReminderLoop(getTasks, options = {}) {
  if (timer) clearInterval(timer);
  const tick = async () => {
    const tasks = typeof getTasks === "function" ? getTasks() : getTasks;
    if (!Array.isArray(tasks)) return;
    await flushDueReminders(tasks, options);
  };
  tick();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick();
  });
  return () => { if (timer) clearInterval(timer); timer = null; };
}

export async function setBadge(count) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("setAppBadge" in reg) {
      if (count > 0) await reg.setAppBadge(count);
      else await reg.clearAppBadge();
    }
  } catch {}
}