/* Одноразовая проверка docs/sw.js на моках Service Worker API.
   Запуск: node tools/.sw-smoke.mjs  (после прогона файл удаляется) */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "docs", "sw.js"), "utf8");

let passed = 0;
const failures = [];
const check = (n, c, e) => {
  if (c) { passed++; console.log("  ok   " + n); }
  else { failures.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); }
};

/* ---------- мок self ---------- */

function makeScope(options) {
  const listeners = new Map();
  const state = {
    skipped: false,
    claimed: false,
    notifications: [],
    opened: [],
    posted: [],
    focused: 0,
    closed: 0,
    cacheOpens: [],
    cacheDeletes: [],
    addAll: [],
    puts: [],
    fetches: [],
  };

  const scope = {
    location: {
      href: "https://example.github.io/nota/sw.js",
      origin: "https://example.github.io",
    },
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    skipWaiting: async () => { state.skipped = true; },
    clients: {
      claim: async () => { state.claimed = true; },
      matchAll: async () => options.clients || [],
      openWindow: async (url) => { state.opened.push(url); return { id: "w" + state.opened.length }; },
    },
    registration: {
      showNotification: async (title, opts) => {
        state.notifications.push({ title, opts });
        const mode = options.notifyMode || "ok";
        const n = state.notifications.length;
        if (mode === "always-fail") throw new Error("unsupported");
        if (mode === "fail-first" && n === 1) throw new Error("vibrate unsupported");
        if (mode === "fail-two" && n <= 2) throw new Error("unsupported options");
      },
    },
    state,
    dispatch(type, event) {
      (listeners.get(type) || []).forEach((fn) => fn(event));
      return Promise.all(event.__waits || []);
    },
    listeners,
  };

  const caches = {
    open: async (name) => {
      state.cacheOpens.push(name);
      return {
        addAll: async (urls) => { state.addAll.push(...urls); },
        put: async (req, res) => { state.puts.push({ req, res }); },
      };
    },
    keys: async () => options.cacheKeys || ["nota-v0", "nota-v1"],
    delete: async (name) => { state.cacheDeletes.push(name); return true; },
    /* Реальный CacheStorage резолвит относительные пути относительно
       адреса SW — мок делает то же самое */
    match: async (req) => {
      const key = typeof req === "string" ? new URL(req, scope.location.href).href : req.url;
      return (options.hits || {})[key];
    },
  };

  const fetchMock = async (req) => {
    state.fetches.push(req.url);
    if (options.fetchFails) throw new Error("offline");
    return { clone: () => ({ clonedFor: req.url }), url: req.url, ok: true };
  };

  /* "use strict" внутри Function-области — как в реальном SW */
  new Function("self", "caches", "fetch", src)(scope, caches, fetchMock);
  return scope;
}

function makeEvent(extra) {
  const event = Object.assign({ __waits: [] }, extra);
  event.waitUntil = (p) => { event.__waits.push(Promise.resolve(p)); };
  event.respondWith = (p) => { event.__response = p; };
  return event;
}

/* ---------- 1. install / activate ---------- */

console.log("\n1. install и activate");

let scope = makeScope({});
check("зарегистрированы install/activate/fetch/push/notificationclick",
  ["install", "activate", "fetch", "push", "notificationclick"].every((t) => scope.listeners.has(t)),
  [...scope.listeners.keys()].join(","));

let event = makeEvent();
await scope.dispatch("install", event);
check("install открыл кэш nota-v1", scope.state.cacheOpens.includes("nota-v1"), scope.state.cacheOpens.join(","));
check("install кэширует оболочку целиком", scope.state.addAll.length >= 7, String(scope.state.addAll.length));
check("install кэширует index.html, style.css, app.js",
  ["./index.html", "./style.css", "./app.js"].every((p) => scope.state.addAll.includes(p)));
check("install вызывает skipWaiting", scope.state.skipped === true);

event = makeEvent();
await scope.dispatch("activate", event);
check("activate удалил только чужие кеши", scope.state.cacheDeletes.length === 1 && scope.state.cacheDeletes[0] === "nota-v0", scope.state.cacheDeletes.join(","));
check("activate вызывает clients.claim", scope.state.claimed === true);

/* ---------- 2. fetch ---------- */

console.log("\n2. Стратегия fetch");

scope = makeScope({ hits: { "https://example.github.io/nota/app.js": { fake: "cache" } } });
event = makeEvent({ request: { method: "GET", url: "https://example.github.io/nota/app.js" } });
await scope.dispatch("fetch", event);
let served = await event.__response;
check("попадание в кэш отдаётся без сети", served && served.fake === "cache" && scope.state.fetches.length === 0);

event = makeEvent({ request: { method: "GET", url: "https://example.github.io/nota/manifest.json" } });
await scope.dispatch("fetch", event);
served = await event.__response;
check("промах по кэшу идёт в сеть и кладётся в кэш", scope.state.fetches.length === 1 && scope.state.puts.length === 1);

event = makeEvent({ request: { method: "POST", url: "https://example.github.io/nota/api" } });
await scope.dispatch("fetch", event);
check("не-GET не перехватывается", event.__response === undefined);

event = makeEvent({ request: { method: "GET", url: "https://api.example.com/x" } });
await scope.dispatch("fetch", event);
check("чужое происхождение не перехватывается", event.__response === undefined);

scope = makeScope({ fetchFails: true, hits: { "https://example.github.io/nota/index.html": { fake: "shell" } } });
event = makeEvent({ request: { method: "GET", url: "https://example.github.io/nota/missing.js" } });
await scope.dispatch("fetch", event);
served = await event.__response;
check("без сети отдаётся закешированная оболочка", served && served.fake === "shell");

/* ---------- 3. push: штатный payload ---------- */

console.log("\n3. Push");

scope = makeScope({});
event = makeEvent({
  data: {
    json: () => ({ title: "Nota", body: "Пора: Полить цветы (08:00)", url: "https://example.github.io/nota?id=abc" }),
    text: () => "не должно использоваться",
  },
});
await scope.dispatch("push", event);
check("showNotification вызван синхронно, без await", scope.state.notifications.length === 1);
let n = scope.state.notifications[0];
check("title из payload", n.title === "Nota");
check("body из payload", n.opts.body === "Пора: Полить цветы (08:00)");
check("tag начинается с nota-", String(n.opts.tag).startsWith("nota-"), n.opts.tag);
check("иконка указана", String(n.opts.icon).includes("icon-192.png"));
check("url из payload попал в data", n.opts.data.url === "https://example.github.io/nota?id=abc");
check("vibrate в опциях есть", Array.isArray(n.opts.vibrate));

/* два push подряд не должны дать одинаковый tag */
event = makeEvent({ data: { json: () => ({ title: "Nota", body: "Вторая" }), text: () => "" } });
await scope.dispatch("push", event);
const second = scope.state.notifications[1];
check("tag второго уведомления отличается", second.opts.tag !== n.opts.tag, n.opts.tag + " == " + second.opts.tag);

/* ---------- 4. push: деградированные payload ---------- */

console.log("\n4. Push с нестандартным payload");

scope = makeScope({});
event = makeEvent({ data: { json: () => { throw new Error("битый JSON"); }, text: () => "Просто текст" } });
await scope.dispatch("push", event);
check("битый JSON -> текст как body", scope.state.notifications[0].opts.body === "Просто текст");
check("битый JSON -> заголовок по умолчанию", scope.state.notifications[0].title === "Nota");

scope = makeScope({});
event = makeEvent({ data: { json: () => { throw new Error("x"); }, text: () => { throw new Error("y"); } } });
await scope.dispatch("push", event);
check("нечитаемый payload -> уведомление всё равно показано", scope.state.notifications.length === 1);
check("дефолтный body", /Напоминание из Nota/.test(scope.state.notifications[0].opts.body));

scope = makeScope({});
event = makeEvent({ data: null });
await scope.dispatch("push", event);
check("push без данных -> уведомление показано", scope.state.notifications.length === 1);
check("url по умолчанию ведёт в приложение", scope.state.notifications[0].opts.data.url === "https://example.github.io/nota/", scope.state.notifications[0].opts.data.url);

/* ---------- 5. push: цепочка fallback ---------- */

console.log("\n5. Цепочка fallback showNotification");

scope = makeScope({ notifyMode: "fail-first" });
event = makeEvent({ data: { json: () => ({ title: "Nota", body: "Текст" }), text: () => "" } });
await scope.dispatch("push", event);
check("первая ошибка -> второй попыткой показано", scope.state.notifications.length === 2);
check("вторая попытка без vibrate", scope.state.notifications[1].opts.vibrate === undefined && scope.state.notifications[1].opts.body === "Текст");

scope = makeScope({ notifyMode: "fail-two" });
event = makeEvent({ data: { json: () => ({ title: "Nota", body: "Текст" }), text: () => "" } });
await scope.dispatch("push", event);
check("две ошибки -> минимальный вариант без опций", scope.state.notifications.length === 3 && scope.state.notifications[2].opts === undefined);
check("третья попытка с тем же заголовком", scope.state.notifications[2].title === "Nota");

scope = makeScope({ notifyMode: "always-fail" });
event = makeEvent({ data: { json: () => ({ title: "Nota", body: "Текст" }), text: () => "" } });
let rejected = false;
try {
  await scope.dispatch("push", event);
} catch (err) {
  rejected = true;
}
check("все попытки упали: waitUntil отклоняется, но не роняет SW", rejected === true);
check("сделано ровно три попытки", scope.state.notifications.length === 3, String(scope.state.notifications.length));

/* ---------- 6. notificationclick ---------- */

console.log("\n6. Клик по уведомлению");

const client = {
  __posted: null,
  postMessage(msg) { this.__posted = msg; },
  focus: async () => { scope.state.focused++; },
};
Object.defineProperty(client, "type", { value: "window" });

scope = makeScope({ clients: [client] });
event = makeEvent({ notification: { data: { url: "https://example.github.io/nota?id=abc" }, close: () => { scope.state.closed++; } } });
await scope.dispatch("notificationclick", event);
check("уведомление закрыто", scope.state.closed === 1);
check("открытому приложению послано nota:open", client.__posted && client.__posted.type === "nota:open", JSON.stringify(client.__posted));
check("в сообщении передан url задачи", client.__posted && client.__posted.url === "https://example.github.io/nota?id=abc");
check("приложение сфокусировано", scope.state.focused === 1);
check("новое окно не открывалось", scope.state.opened.length === 0);

scope = makeScope({ clients: [] });
event = makeEvent({ notification: { data: { url: "https://example.github.io/nota?id=xyz" }, close: () => {} } });
await scope.dispatch("notificationclick", event);
check("без клиентов открывается окно с url", scope.state.opened[0] === "https://example.github.io/nota?id=xyz", scope.state.opened.join(","));

scope = makeScope({ clients: [] });
event = makeEvent({ notification: { data: null, close: () => {} } });
await scope.dispatch("notificationclick", event);
check("без data открывается корень приложения", scope.state.opened[0] === "https://example.github.io/nota/", scope.state.opened.join(","));

console.log("\n" + "=".repeat(52));
if (failures.length) console.log("ПРОВАЛЕНО " + failures.length + " из " + (passed + failures.length) + ":");
else console.log("ПРОВЕРКИ SERVICE WORKER ПРОЙДЕНЫ: " + passed + " шт.");
process.exit(failures.length ? 1 : 0);
