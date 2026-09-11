/* Local reminder engine: schedules in-page checks and fires notifications.
   Real Web Push (push events while the app is closed) requires a server and
   a PushSubscription — see the push listener in sw.js. */

const CHECK_INTERVAL_MS = 20_000;
// Reminders older than this are marked as seen silently (no notification spam).
const STALE_AFTER_MS = 12 * 60 * 60 * 1000;

let timer = null;

function fireNotification(task) {
  const title = "Nota";
  const options = {
    body: task.title,
    tag: `task-${task.id}`,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    data: { taskId: task.id },
  };

  // Prefer the service worker registration: it keeps notifications working
  // even when this tab is hidden or discarded.
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
  return Notification.permission; // "default" | "granted" | "denied"
}

export async function requestPermission() {
  if (!notificationSupported()) return "unsupported";
  if (Notification.permission === "granted") return "granted";
  try {
    return await Notification.requestPermission();
  } catch {
    // Safari (<= 15) uses the callback form.
    return new Promise((resolve) => {
      try {
        Notification.requestPermission(resolve);
      } catch {
        resolve("denied");
      }
    });
  }
}

export async function registerServiceWorker(url = "sw.js") {
  if (!("serviceWorker" in navigator)) return null;
  try {
    return await navigator.serviceWorker.register(url);
  } catch {
    return null;
  }
}

/* Checks due reminders.
   options.persist(tasks)  — save tasks after marking reminders as seen
   options.onFired(count)  — called when at least one notification was shown */
export async function flushDueReminders(tasks, options = {}) {
  const { persist, onFired } = options;
  if (permissionState() !== "granted") return 0;

  const now = Date.now();
  const due = [];
  let changed = false;

  for (const task of tasks) {
    if (task.done || !task.dueAt || task.reminderSent) continue;
    const dueAt = new Date(task.dueAt).getTime();
    if (Number.isNaN(dueAt) || dueAt > now) continue;

    task.reminderSent = true;
    changed = true;

    if (now - dueAt > STALE_AFTER_MS) continue; // too late to bother the user
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

  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}

export async function setBadge(count) {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if ("setAppBadge" in reg) {
      if (count > 0) await reg.setAppBadge(count);
      else await reg.clearAppBadge();
    }
  } catch {
    /* Badging API not available */
  }
}

/* Lets the user verify that notifications really arrive
   right after granting permission. */
export async function sendTestNotification() {
  if (permissionState() !== "granted") return false;
  await fireNotification({ id: "test", title: "✓" });
  return true;
}

export function focusTaskInApp(taskId) {
  if (!taskId) return;
  const url = new URL(window.location.href);
  url.searchParams.set("task", taskId);
  window.location.href = url.toString();
}
