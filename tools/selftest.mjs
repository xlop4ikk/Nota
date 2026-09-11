#!/usr/bin/env node
/* ============================================================
   Nota — автономная проверка Worker'а без деплоя в Cloudflare.

   Запуск:  node tools/selftest.mjs

   Поднимает мок KV и мок push-сервиса, генерирует настоящую
   P-256 пару ключей и проверяет:
     • контракты HTTP API и CORS;
     • структуру ключей KV;
     • VAPID: формат, ES256-подпись, claims;
     • шифрование aes128gcm — payload реально расшифровывается
       «на стороне браузера» (значит клиент Chrome его примет);
     • cron-цикл, защиту от дублей и очистку notifiedToday;
     • изоляцию двух пользователей;
     • лимит 4096 байт на тело push.

   Только встроенные модули Node.js.
   ============================================================ */

import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const workerModule = await import(pathToFileURL(join(ROOT, "worker", "worker.js")).href);
const { route, runCron, collectDue } = workerModule;

/* ---------- мелкие помощники ---------- */

const enc = new TextEncoder();
const dec = new TextDecoder();
let passed = 0;
const failures = [];

function check(name, condition, extra) {
  if (condition) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failures.push(name + (extra ? " :: " + extra : ""));
    console.log("  FAIL " + name + (extra ? " :: " + extra : ""));
  }
}

function b64u(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64u(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function cat() {
  let total = 0;
  for (const part of arguments) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of arguments) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, base, length * 8);
  return new Uint8Array(bits);
}

/* ---------- VAPID-пара, как её выдаёт tools/gen_vapid.js ---------- */

function genVapid() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    pub: b64u(spki.subarray(spki.length - 65)),
    priv: privateKey.export({ format: "jwk" }).d,
  };
}

/* ---------- мок Cloudflare KV ---------- */

class MockKV {
  constructor() {
    this.store = new Map();
  }
  async get(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  async put(key, value) {
    this.store.set(key, String(value));
  }
  async delete(key) {
    this.store.delete(key);
  }
  async list(options) {
    const prefix = (options && options.prefix) || "";
    return {
      keys: [...this.store.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((name) => ({ name })),
    };
  }
}

/* ---------- мок браузера: подписка с приватным ключом ---------- */

const browsers = new Map(); /* endpoint → { private, auth, uaPublic } */

async function makeSubscription(endpoint) {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  browsers.set(endpoint, { private: pair.privateKey, auth, uaPublic });
  return { endpoint, keys: { p256dh: b64u(uaPublic), auth: b64u(auth) } };
}

/* Разбираем и расшифровываем тело push так, как это сделал бы браузер */
async function decryptPushBody(env, body, endpoint) {
  const bytes = new Uint8Array(body);
  const salt = bytes.slice(0, 16);
  const idlen = bytes[20];
  const keyid = bytes.slice(21, 21 + idlen);
  const ciphertext = bytes.slice(21 + idlen);
  const ua = browsers.get(endpoint);

  const ephPub = await crypto.subtle.importKey("raw", keyid, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ephPub }, ua.private, 256));
  const asPublic = fromB64u(env.VAPID_PUBLIC_KEY);

  const ikm = await hkdf(ua.auth, shared, cat(enc.encode("WebPush: info\u0000"), ua.uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\u0000"), 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  return dec.decode(plain.slice(0, plain.length - 1)); /* убираем разделитель record'а 0x02 */
}

/* ---------- мок push-сервиса (FCM/APNs) ---------- */

let pushQueue = [];
let pushStatus = 201;

globalThis.fetch = async (url, init) => {
  const record = {
    url: String(url),
    headers: init && init.headers ? init.headers : {},
    body: init && init.body ? new Uint8Array(init.body) : new Uint8Array(),
  };
  pushQueue.push(record);
  return new Response(pushStatus === 201 ? "" : "mocked failure", { status: pushStatus });
};

/* ---------- окружение Worker'а ---------- */

const vapid = genVapid();
const env = {
  KV_NAMESPACE: new MockKV(),
  VAPID_PUBLIC_KEY: vapid.pub,
  VAPID_PRIVATE_KEY: vapid.priv,
  VAPID_SUBJECT: "mailto:test@example.com",
  SITE_URL: "https://example.github.io/nota/",
};

const BASE = "https://nota-push.workers.dev";
const req = (path, options) => new Request(BASE + path, options);
const post = (path, body) =>
  req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/* локальное время пользователя: Worker в UTC, смещение присылает клиент */
const TZ = -180; /* UTC+3 → getTimezoneOffset() возвращает -180 */
const userNow = new Date(Date.now() - TZ * 60000);
const today = userNow.toISOString().slice(0, 10);
const nowTime = userNow.toISOString().slice(11, 16);
const plusTwo = new Date(userNow.getTime() + 2 * 60000);
const futureTime = plusTwo.toISOString().slice(11, 16);
const futureSameDay = plusTwo.toISOString().slice(0, 10) === today;

const logs = [];
const quietLog = { log: (...parts) => logs.push(parts.join(" ")) };

function makeTask(overrides) {
  return Object.assign(
    {
      id: "task", type: "task", title: "Задача", body: "", items: [],
      priority: "normal", dueDate: today, dueTime: "00:00", repeat: "none",
      done: false, doneAt: null, createdAt: Date.now(), notifiedAt: null,
    },
    overrides
  );
}

/* ============================================================
   1. HTTP API и CORS
   ============================================================ */

console.log("\n1. HTTP API и CORS");

let res = await route(req("/api/health"), env);
let json = await res.json();
check("health: ok + ISO время", json.ok === true && typeof json.time === "string", JSON.stringify(json));
check("health: CORS allow-origin *", res.headers.get("access-control-allow-origin") === "*");

res = await route(req("/api/vapid-public-key"), env);
const keyText = await res.text();
check("vapid-public-key: 87 символов base64url", /^[A-Za-z0-9_-]{87}$/.test(keyText), keyText);
check("vapid-public-key: content-type text/plain", (res.headers.get("content-type") || "").includes("text/plain"));

res = await route(req("/api/subscribe", { method: "OPTIONS" }), env);
check("OPTIONS: 204 без тела", res.status === 204 && res.headers.get("access-control-allow-origin") === "*");

res = await route(req("/api/unknown"), env);
check("неизвестный маршрут: 404", res.status === 404);

res = await route(post("/api/subscribe", { subscription: { endpoint: "x", keys: { p256dh: "y" } } }), env);
check("subscribe без userId: 400", res.status === 400);

res = await route(post("/api/subscribe", { userId: "user_x" }), env);
check("subscribe без subscription: 400", res.status === 400);

res = await route(post("/api/items/save", { userId: "user_x", items: "не массив" }), env);
check("items/save с некорректным items: 400", res.status === 400);

/* ============================================================
   2. Подписка и расписание пользователя A
   ============================================================ */

console.log("\n2. Подписка и расписание");

const subA = await makeSubscription("https://push.example.com/A/aaaa");
res = await route(post("/api/subscribe", { userId: "user_A", subscription: subA, tzOffsetMin: TZ }), env);
json = await res.json();
check("subscribe: success", json.success === true);

const store = JSON.parse(await env.KV_NAMESPACE.get("subscriptions"));
check("KV subscriptions: одна запись", store.subscriptions.length === 1);
check("KV subscriptions: сохранён userId", store.subscriptions[0].userId === "user_A");
check("KV subscriptions: сохранён addedAt", typeof store.subscriptions[0].addedAt === "number");
check("KV ep:<endpoint> → userId", (await env.KV_NAMESPACE.get("ep:" + subA.endpoint)) === "user_A");
check("subscribe сразу создаёт user:<userId>", (await env.KV_NAMESPACE.get("user:user_A")) !== null);

/* повторная подписка на тот же endpoint не плодит дубликат */
await route(post("/api/subscribe", { userId: "user_A", subscription: subA, tzOffsetMin: TZ }), env);
const storeAgain = JSON.parse(await env.KV_NAMESPACE.get("subscriptions"));
check("повторный subscribe не дублирует запись", storeAgain.subscriptions.length === 1);

const taskA = makeTask({ id: "taskA1", title: "Полить цветы" });
const taskAFuture = makeTask({ id: "taskA2", dueTime: futureTime });
const taskADone = makeTask({ id: "taskA3", done: true, doneAt: Date.now() });
const taskNoTime = makeTask({ id: "taskA4", dueTime: null });
const taskNoDate = makeTask({ id: "taskA5", dueDate: null, dueTime: "00:00" });

res = await route(
  post("/api/items/save", {
    userId: "user_A",
    items: [taskA, taskAFuture, taskADone, taskNoTime, taskNoDate],
    tzOffsetMin: TZ,
  }),
  env
);
json = await res.json();
check("items/save: saved = 5", json.success === true && json.saved === 5, JSON.stringify(json));

const schedA = JSON.parse(await env.KV_NAMESPACE.get("user:user_A"));
check("KV user:user_A хранит items", schedA.items.length === 5);
check("KV user:user_A хранит tzOffsetMin", schedA.tzOffsetMin === TZ);

const dueA = collectDue(schedA, today, nowTime);
check("collectDue берёт только подходящую задачу", dueA.length === 1 && dueA[0].id === "taskA1", dueA.map((i) => i.id).join(","));

if (futureSameDay && futureTime > nowTime) {
  check("задача с будущим временем не попадает в due", !dueA.some((i) => i.id === "taskA2"));
} else {
  console.log("  skip проверка будущего времени (слишком близко к полуночи)");
}

/* ============================================================
   3. Cron: отправка, VAPID, расшифровка payload
   ============================================================ */

console.log("\n3. Cron-напоминание и криптография");

pushQueue = [];
pushStatus = 201;
await runCron(env, quietLog);

check("cron: ровно одна отправка", pushQueue.length === 1, String(pushQueue.length));
check("cron: отправлено подписке A", pushQueue[0] && pushQueue[0].url === subA.endpoint);

const headers = pushQueue[0] ? pushQueue[0].headers : {};
check("Content-Encoding: aes128gcm", headers["Content-Encoding"] === "aes128gcm");
check("TTL задан", typeof headers.TTL === "string" && Number(headers.TTL) > 0);
check("Crypto-Key содержит p256dh и auth", /p256dh=.+;auth=.+/.test(String(headers["Crypto-Key"])));
check("Content-Length совпадает с телом", String(pushQueue[0].body.byteLength) === String(headers["Content-Length"]));

const authMatch = /^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]{87})$/.exec(String(headers.Authorization || ""));
check("Authorization в форме «vapid t=…, k=…»", Boolean(authMatch), String(headers.Authorization));

if (authMatch) {
  check("k= совпадает с публичным VAPID-ключом", authMatch[2] === env.VAPID_PUBLIC_KEY);

  const parts = authMatch[1].split(".");
  check("JWT состоит из трёх частей", parts.length === 3);

  const pubKey = await crypto.subtle.importKey(
    "raw",
    fromB64u(authMatch[2]),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"]
  );
  const signatureOk = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    pubKey,
    fromB64u(parts[2]),
    enc.encode(parts[0] + "." + parts[1])
  );
  check("ES256-подпись VAPID проходит проверку", signatureOk === true);

  const claims = JSON.parse(dec.decode(fromB64u(parts[1])));
  const head = JSON.parse(dec.decode(fromB64u(parts[0])));
  check("JWT header: ES256", head.alg === "ES256" && head.typ === "JWT");
  check("JWT aud = origin push-сервиса", claims.aud === "https://push.example.com", String(claims.aud));
  check("JWT exp ≈ +12 часов", claims.exp - Math.floor(Date.now() / 1000) > 11 * 3600);
  check("JWT sub взят из VAPID_SUBJECT", claims.sub === "mailto:test@example.com", String(claims.sub));
}

check("тело push меньше 4096 байт", pushQueue[0].body.byteLength < 4096, String(pushQueue[0].body.byteLength));

const payloadRaw = await decryptPushBody(env, pushQueue[0].body, subA.endpoint);
let payload = null;
try {
  payload = JSON.parse(payloadRaw);
} catch (err) {
  /* ниже фиксится проверкой */
}
check("payload расшифрован алгоритмом aes128gcm", Boolean(payload), payloadRaw.slice(0, 60));
check("payload.title = «Nota»", payload && payload.title === "Nota");
check("payload.body содержит название задачи", Boolean(payload) && payload.body.includes("Полить цветы"), payload && payload.body);
check(
  "payload.url = SITE_URL без двойного слэша + ?id=",
  payload && payload.url === "https://example.github.io/nota?id=taskA1",
  payload && payload.url
);

check(
  "лог в формате «Push: user=… accepted=…»",
  logs.some((line) => line.includes("Push: user=user_A") && line.includes("accepted=201")),
  logs.join(" | ")
);

const schedAfter = JSON.parse(await env.KV_NAMESPACE.get("user:user_A"));
check("notifiedToday записан после успешной отправки", Boolean(schedAfter.notifiedToday["taskA1:" + today]));

/* ============================================================
   4. Отсутствие дублей и очистка notifiedToday
   ============================================================ */

console.log("\n4. Дубли и очистка отметок");

pushQueue = [];
await runCron(env, quietLog);
check("второй cron за тот же день: 0 отправок", pushQueue.length === 0, String(pushQueue.length));

const yesterday = new Date(userNow.getTime() - 86400000).toISOString().slice(0, 10);
schedAfter.notifiedToday["taskA1:" + yesterday] = Date.now();
schedAfter.notifiedToday["taskOld:" + yesterday] = Date.now();
await env.KV_NAMESPACE.put("user:user_A", JSON.stringify(schedAfter));

pushQueue = [];
await runCron(env, quietLog);
const schedCleaned = JSON.parse(await env.KV_NAMESPACE.get("user:user_A"));
const staleKeys = Object.keys(schedCleaned.notifiedToday).filter((key) => key.endsWith(":" + yesterday));
check("вчерашние ключи notifiedToday удалены", staleKeys.length === 0, staleKeys.join(","));
check("сегодняшний ключ notifiedToday остался", Boolean(schedCleaned.notifiedToday["taskA1:" + today]));

/* Клиент сам сдвигает dueDate повторяющейся задачи; отметка notifiedToday
   привязана к дате, поэтому на новом сроке напоминание не блокируется. */
const tomorrow = new Date(userNow.getTime() + 86400000).toISOString().slice(0, 10);
const movedTask = Object.assign({}, taskA, { dueDate: tomorrow });
const dueMoved = collectDue(
  { items: [movedTask], notifiedToday: schedCleaned.notifiedToday, tzOffsetMin: TZ },
  tomorrow,
  nowTime
);
check("после переноса срока задача снова становится due", dueMoved.length === 1 && dueMoved[0].id === "taskA1");

/* ============================================================
   5. Изоляция пользователей
   ============================================================ */

console.log("\n5. Изоляция пользователей");

const subB = await makeSubscription("https://push.example.com/B/bbbb");
await route(post("/api/subscribe", { userId: "user_B", subscription: subB, tzOffsetMin: TZ }), env);
await route(post("/api/items/save", { userId: "user_B", items: [makeTask({ id: "taskB1", title: "Позвонить маме" })], tzOffsetMin: TZ }), env);

pushQueue = [];
await runCron(env, quietLog);
check("cron отправил только пользователю B", pushQueue.length === 1 && pushQueue[0].url === subB.endpoint, pushQueue.map((p) => p.url).join(","));

const payloadB = JSON.parse(await decryptPushBody(env, pushQueue[0].body, subB.endpoint));
check("B получил свою задачу", payloadB.body.includes("Позвонить маме"));
check("B не получил чужую задачу", !payloadB.body.includes("Полить цветы"));

const schedBCheck = JSON.parse(await env.KV_NAMESPACE.get("user:user_B"));
check("расписание B не содержит задач A", !schedBCheck.items.some((it) => it.id === "taskA1"));

/* ============================================================
   6. Лимит 4096 байт
   ============================================================ */

console.log("\n6. Лимит тела push");

await route(
  post("/api/items/save", {
    userId: "user_B",
    items: [makeTask({ id: "taskHuge", title: "Очень длинная задача", body: "х".repeat(6000) })],
    tzOffsetMin: TZ,
  }),
  env
);
const schedB = JSON.parse(await env.KV_NAMESPACE.get("user:user_B"));
schedB.notifiedToday = {};
await env.KV_NAMESPACE.put("user:user_B", JSON.stringify(schedB));

pushQueue = [];
await runCron(env, quietLog);
check("большой payload: отправка состоялась", pushQueue.length === 1);
check("большой payload: тело <= 4096 байт", pushQueue[0] && pushQueue[0].body.byteLength <= 4096, pushQueue ? String(pushQueue[0].body.byteLength) : "нет отправки");

const payloadHuge = JSON.parse(await decryptPushBody(env, pushQueue[0].body, subB.endpoint));
check("большой payload: текст укорочен", typeof payloadHuge.body === "string" && payloadHuge.body.length < 3000, "len=" + (payloadHuge.body || "").length);
check("большой payload: url сохранён", payloadHuge.url.includes("id=taskHuge"));

/* ============================================================
   7. Протухшая и снятая подписки
   ============================================================ */

console.log("\n7. Жизненный цикл подписки");

const schedBBefore = JSON.parse(await env.KV_NAMESPACE.get("user:user_B"));
schedBBefore.notifiedToday = {};
await env.KV_NAMESPACE.put("user:user_B", JSON.stringify(schedBBefore));

pushStatus = 410;
pushQueue = [];
await runCron(env, quietLog);
check("при 410 попытка отправки была сделана", pushQueue.length === 1);
const storeAfterGone = JSON.parse(await env.KV_NAMESPACE.get("subscriptions"));
check("при 410 подписка удалена из KV", !storeAfterGone.subscriptions.some((rec) => rec.subscription.endpoint === subB.endpoint));
check("при 410 удалён ep-ключ", (await env.KV_NAMESPACE.get("ep:" + subB.endpoint)) === null);

pushStatus = 201;

/* подписка без userId и без ep-ключа должна пропускаться, а не стрелять */
await env.KV_NAMESPACE.put(
  "subscriptions",
  JSON.stringify({ subscriptions: [{ subscription: subA, tzOffsetMin: TZ, addedAt: Date.now() }] })
);
await env.KV_NAMESPACE.delete("ep:" + subA.endpoint);
pushQueue = [];
const strayResults = await runCron(env, quietLog);
check("подписка без userId пропускается", pushQueue.length === 0 && strayResults.length === 0);

await route(post("/api/subscribe", { userId: "user_A", subscription: subA, tzOffsetMin: TZ }), env);
res = await route(post("/api/unsubscribe", { userId: "user_A", endpoint: subA.endpoint }), env);
json = await res.json();
const storeFinal = JSON.parse(await env.KV_NAMESPACE.get("subscriptions"));
check("unsubscribe: success", json.success === true);
check("unsubscribe: список подписок очищен", storeFinal.subscriptions.length === 0);
check("unsubscribe: ep-ключ удалён", (await env.KV_NAMESPACE.get("ep:" + subA.endpoint)) === null);
check("unsubscribe: расписание пользователя сохранено", (await env.KV_NAMESPACE.get("user:user_A")) !== null);

/* ============================================================
   8. /api/debug
   ============================================================ */

console.log("\n8. Диагностика");

await route(post("/api/subscribe", { userId: "user_A", subscription: subA, tzOffsetMin: TZ }), env);
json = await (await route(req("/api/debug"), env)).json();
check("debug: ok", json.ok === true);
check("debug: vapidConfigured", json.vapidConfigured === true);
check("debug: privateKeyOk с корректным секретом", json.privateKeyOk === true, JSON.stringify(json));
check("debug: считает подписки", json.subscriptions === 1, String(json.subscriptions));
check("debug: считает пользователей KV", json.users === 2, String(json.users));

const brokenDebug = await (await route(req("/api/debug"), { ...env, VAPID_PRIVATE_KEY: "не base64url!" })).json();
check("битый секрет → privateKeyOk: false", brokenDebug.privateKeyOk === false);

const noKeyDebug = await (await route(req("/api/vapid-public-key"), { ...env, VAPID_PUBLIC_KEY: "" })).text();
check("пустой VAPID_PUBLIC_KEY → 500 с текстом ошибки", noKeyDebug.includes("не задан"), noKeyDebug);

/* ============================================================
   Итог
   ============================================================ */

console.log("\n" + "=".repeat(52));
if (failures.length) {
  console.log("ПРОВАЛЕНО " + failures.length + " проверок из " + (passed + failures.length) + ":");
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ: " + passed + " шт.");
