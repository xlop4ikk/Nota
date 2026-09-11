/* ============================================================
   Nota — Cloudflare Worker: хранение расписания и push-напоминания.

   Только бесплатные сервисы и только Web Crypto API:
   ни одной npm-зависимости в рантайме.

   Переменные окружения (wrangler.toml / secrets):
     KV_NAMESPACE       — привязка KV
     VAPID_PUBLIC_KEY   — 87 символов base64url ([vars])
     VAPID_PRIVATE_KEY  — 43 символа base64url (ТОЛЬКО secret!)
     VAPID_SUBJECT      — mailto:you@example.com
     SITE_URL           — адрес PWA, со слэшем на конце (срежем сами)
   ============================================================ */

"use strict";

const KV_SUBSCRIPTIONS = "subscriptions";
const MAX_PUSH_BODY = 4096; /* жёсткий лимит APNs/FCM на тело запроса */
const SAFE_PAYLOAD = 3600;  /* запас на заголовки и шифротекст */

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400",
};

/* ============================================================
   1. Мелкие утилиты
   ============================================================ */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToB64url(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlToBytes(text) {
  const normalized = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function jsonB64url(value) {
  return bytesToB64url(encoder.encode(JSON.stringify(value)));
}

function concatBytes() {
  let total = 0;
  for (let i = 0; i < arguments.length; i++) total += arguments[i].length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (let i = 0; i < arguments.length; i++) {
    out.set(arguments[i], offset);
    offset += arguments[i].length;
  }
  return out;
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ "content-type": "application/json; charset=utf-8" }, CORS_HEADERS),
  });
}

function textResponse(text, status) {
  return new Response(text, {
    status: status || 200,
    headers: Object.assign({ "content-type": "text/plain; charset=utf-8" }, CORS_HEADERS),
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch (err) {
    return null;
  }
}

async function kvGetJson(env, key, fallback) {
  const raw = await env.KV_NAMESPACE.get(key);
  if (raw === null || raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

async function kvPutJson(env, key, value) {
  await env.KV_NAMESPACE.put(key, JSON.stringify(value));
}

/* SITE_URL может быть указан со слэшем — при склейке с "?id=" двойной
   слэш ломает ссылку, поэтому срезаем завершающие слэши. */
function siteUrl(env) {
  return String(env.SITE_URL || "").replace(/\/+$/, "");
}

/* ============================================================
   2. VAPID (RFC 8292)
   ============================================================ */

/* Приватный ключ приходит как d-скаляр base64url (43 символа).
   Собираем JWK из координат публичного ключа и скаляра d.
   Формат PEM или JWK-JSON в секрете ломает importKey — не используем. */
async function importVapidPrivateKey(env) {
  const publicBytes = b64urlToBytes(env.VAPID_PUBLIC_KEY);
  const dBytes = b64urlToBytes(env.VAPID_PRIVATE_KEY);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(publicBytes.subarray(1, 33)),
    y: bytesToB64url(publicBytes.subarray(33, 65)),
    d: bytesToB64url(dBytes),
    key_ops: ["sign"],
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

async function isPrivateKeyOk(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  try {
    await importVapidPrivateKey(env);
    return true;
  } catch (err) {
    return false;
  }
}

/* JWT-утверждение VAPID: aud — origin push-сервиса, exp — 12 часов.
   crypto.subtle.sign для ECDSA уже возвращает raw r||s, конвертация не нужна. */
async function makeVapidAssertion(env, audience) {
  const privateKey = await importVapidPrivateKey(env);
  const header = jsonB64url({ typ: "JWT", alg: "ES256" });
  const payload = jsonB64url({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  });
  const signingInput = encoder.encode(header + "." + payload);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signingInput);
  return header + "." + payload + "." + bytesToB64url(signature);
}

/* ============================================================
   3. Шифрование payload (RFC 8291, aes128gcm)
   ============================================================ */

async function hkdf(salt, ikm, info, lengthBytes) {
  const baseKey = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt, info: info },
    baseKey,
    lengthBytes * 8
  );
  return new Uint8Array(bits);
}

async function encryptPayload(env, p256dh, auth, plaintext) {
  const uaPublic = b64urlToBytes(p256dh);      /* ключ браузера, 65 байт */
  const authSecret = b64urlToBytes(auth);      /* auth-секрет, 16 байт */
  const asPublic = b64urlToBytes(env.VAPID_PUBLIC_KEY);

  /* Эфемерная пара ECDH на каждое сообщение */
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const ephPublic = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256)
  );

  const ikmInfo = concatBytes(encoder.encode("WebPush: info\u0000"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, ikmInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\u0000"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\u0000"), 12);

  /* Record = payload || 0x02. Паддинг не добавляем: из-за него тело
     превышает 4096 байт и Apple отвечает HTTP 413. */
  const record = concatBytes(encoder.encode(plaintext), new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, record)
  );

  /* Body = salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext */
  const rs = new Uint8Array([0, 0, 0x10, 0x00]); /* 4096 big-endian */
  const header = concatBytes(salt, rs, new Uint8Array([ephPublic.length]), ephPublic);
  return concatBytes(header, ciphertext);
}

/* Собираем тело push-запроса, не выходя за 4096 байт: при переполнении
   укорачиваем текст уведомления, а не молча ловим 413. */
async function buildPushBody(env, keys, payload) {
  let candidate = { title: payload.title, body: payload.body, url: payload.url };
  let body = await encryptPayload(env, keys.p256dh, keys.auth, JSON.stringify(candidate));

  if (body.byteLength > MAX_PUSH_BODY) {
    let text = String(candidate.body || "");
    while (body.byteLength > MAX_PUSH_BODY && text.length > 0) {
      text = text.slice(0, Math.max(0, text.length - 32));
      candidate = { title: candidate.title, body: text + "…", url: candidate.url };
      body = await encryptPayload(env, keys.p256dh, keys.auth, JSON.stringify(candidate));
    }
  }

  if (body.byteLength > MAX_PUSH_BODY) {
    /* Даже пустое тело не влезает — не должно случаться, но бережёмся */
    throw new Error("push payload too large: " + body.byteLength);
  }
  return body;
}

/* ============================================================
   4. Отправка push конкретной подписке
   ============================================================ */

async function sendPush(env, record, payload) {
  const subscription = record.subscription || {};
  const endpoint = subscription.endpoint;
  if (!endpoint || !subscription.keys || !subscription.keys.p256dh || !subscription.keys.auth) {
    return { ok: false, status: 0, text: "subscription incomplete", expired: false };
  }

  const audience = new URL(endpoint).origin;
  const body = await buildPushBody(env, subscription.keys, payload);
  const assertion = await makeVapidAssertion(env, audience);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: "3600",
      Urgency: "high",
      Authorization: "vapid t=" + assertion + ", k=" + env.VAPID_PUBLIC_KEY,
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Crypto-Key": "p256dh=" + subscription.keys.p256dh + ";auth=" + subscription.keys.auth,
      "Content-Length": String(body.byteLength),
    },
    body: body,
  });

  const text = await response.text().catch(() => "");
  return {
    ok: response.ok,
    status: response.status,
    text: text.slice(0, 200),
    /* Push-сервис сообщил, что подписка больше не действительна */
    expired: response.status === 404 || response.status === 410,
    /* 16384 — размер тела больше лимита провайдера */
    tooLarge: response.status === 413,
  };
}

/* ============================================================
   5. Учёт подписок
   ============================================================ */

async function loadSubscriptions(env) {
  const store = await kvGetJson(env, KV_SUBSCRIPTIONS, null);
  if (!store || !Array.isArray(store.subscriptions)) return { subscriptions: [] };
  return store;
}

async function saveSubscriptions(env, store) {
  await kvPutJson(env, KV_SUBSCRIPTIONS, store);
}

/* Удалить подписку по endpoint (протухла или пользователь отписался) */
async function dropSubscription(env, endpoint) {
  const store = await loadSubscriptions(env);
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter((rec) => {
    return !rec || !rec.subscription || rec.subscription.endpoint !== endpoint;
  });
  if (store.subscriptions.length !== before) await saveSubscriptions(env, store);
  await env.KV_NAMESPACE.delete("ep:" + endpoint);
}

/* ============================================================
   6. Расписание пользователя
   ============================================================ */

async function loadSchedule(env, userId) {
  const sched = await kvGetJson(env, "user:" + userId, null);
  if (!sched || typeof sched !== "object") return { items: [], tzOffsetMin: 0, notifiedToday: {} };
  if (!Array.isArray(sched.items)) sched.items = [];
  if (typeof sched.tzOffsetMin !== "number") sched.tzOffsetMin = 0;
  if (!sched.notifiedToday || typeof sched.notifiedToday !== "object") sched.notifiedToday = {};
  return sched;
}

/* Локальная дата/время пользователя: Worker живёт в UTC, поэтому
   сдвигаем текущий момент на присланное клиентом смещение. */
function userLocalNow(tzOffsetMin) {
  return new Date(Date.now() - (tzOffsetMin || 0) * 60000);
}

function localDateParts(userNow) {
  const iso = userNow.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

/* Записи, по которым пора отправить напоминание */
export function collectDue(sched, date, time) {
  const due = [];
  for (const item of sched.items) {
    if (!item || item.done || !item.dueDate || !item.dueTime) continue;
    if (item.dueDate !== date) continue;
    if (String(item.dueTime) > time) continue;
    const key = item.id + ":" + date;
    if (sched.notifiedToday[key]) continue;
    due.push(item);
  }
  return due;
}

/* notifiedToday чистим ежедневно: иначе KV разрастается и копятся
   ложные отметки «уже уведомляли». */
function pruneNotified(notifiedToday, date) {
  const suffix = ":" + date;
  const cleaned = {};
  let changed = false;
  for (const key of Object.keys(notifiedToday)) {
    if (key.endsWith(suffix)) cleaned[key] = notifiedToday[key];
    else changed = true;
  }
  return { cleaned: cleaned, changed: changed };
}

function buildPayload(dueItems, baseUrl) {
  const first = dueItems[0];
  const title = "Nota";
  let body = "Пора: " + first.title;
  if (first.dueTime) body += " (" + first.dueTime + ")";
  if (dueItems.length > 1) body += " и ещё " + (dueItems.length - 1);
  return {
    title: title,
    body: body.slice(0, SAFE_PAYLOAD),
    url: baseUrl + "?id=" + encodeURIComponent(first.id),
  };
}

/* ============================================================
   7. Cron: обход подписок и отправка напоминаний
   ============================================================ */

export async function runCron(env, log) {
  const logger = log || console;
  const store = await loadSubscriptions(env);
  const results = [];

  for (const record of store.subscriptions) {
    const endpoint = record && record.subscription ? record.subscription.endpoint : null;
    if (!endpoint) continue;

    /* Мультипользовательская изоляция: подписка привязана ровно к одному
       пользователю. Чужое расписание мы не читаем и не отправляем. */
    let userId = record.userId;
    if (!userId) userId = await env.KV_NAMESPACE.get("ep:" + endpoint);
    if (!userId) continue;

    const sched = await loadSchedule(env, userId);
    if (!sched.items.length) continue;

    const { date, time } = localDateParts(userLocalNow(sched.tzOffsetMin));
    const due = collectDue(sched, date, time);

    /* Чистим старые отметки в любом случае */
    const pruned = pruneNotified(sched.notifiedToday, date);
    if (pruned.changed) {
      sched.notifiedToday = pruned.cleaned;
      await kvPutJson(env, "user:" + userId, sched);
    }

    if (!due.length) continue;

    const payload = buildPayload(due, siteUrl(env));
    let result;
    try {
      result = await sendPush(env, record, payload);
    } catch (err) {
      logger.log("Push: user=" + userId + " error=" + (err && err.message));
      results.push({ userId: userId, ok: false, error: String(err && err.message) });
      continue;
    }

    logger.log(
      "Push: user=" + userId +
      " due=" + due.map((it) => it.id).join(",") +
      " accepted=" + result.status +
      (result.ok ? "" : " body=" + result.text)
    );

    if (result.ok) {
      /* Отметку ставим только при успешной отправке — иначе напоминание
         потеряется из-за временного сбоя push-сервиса. */
      const fresh = await loadSchedule(env, userId);
      for (const item of due) fresh.notifiedToday[item.id + ":" + date] = Date.now();
      await kvPutJson(env, "user:" + userId, fresh);
    } else if (result.expired) {
      await dropSubscription(env, endpoint);
    }

    results.push({ userId: userId, ok: result.ok, status: result.status, due: due.length });
  }

  return results;
}

/* ============================================================
   8. HTTP API
   ============================================================ */

async function handleSubscribe(env, body) {
  const userId = body && body.userId;
  const subscription = body && body.subscription;
  const tzOffsetMin = typeof (body && body.tzOffsetMin) === "number" ? body.tzOffsetMin : 0;

  if (!userId || typeof userId !== "string") return jsonResponse({ error: "userId обязателен" }, 400);
  if (!subscription || !subscription.endpoint || !subscription.keys || !subscription.keys.p256dh) {
    return jsonResponse({ error: "subscription некорректна" }, 400);
  }

  const store = await loadSubscriptions(env);
  const endpoint = subscription.endpoint;
  const existing = store.subscriptions.find((rec) => rec && rec.subscription && rec.subscription.endpoint === endpoint);

  if (existing) {
    existing.userId = userId;
    existing.tzOffsetMin = tzOffsetMin;
    existing.subscription = subscription;
  } else {
    store.subscriptions.push({
      subscription: subscription,
      userId: userId,
      tzOffsetMin: tzOffsetMin,
      addedAt: Date.now(),
    });
  }

  await saveSubscriptions(env, store);
  await env.KV_NAMESPACE.put("ep:" + endpoint, userId);

  /* Заодно сохраняем расписание: пуш должен работать сразу после подписки */
  const sched = await loadSchedule(env, userId);
  sched.tzOffsetMin = tzOffsetMin;
  await kvPutJson(env, "user:" + userId, sched);

  return jsonResponse({ success: true });
}

async function handleUnsubscribe(env, body) {
  const endpoint = body && body.endpoint;
  const userId = body && body.userId;
  if (!endpoint) return jsonResponse({ error: "endpoint обязателен" }, 400);

  const store = await loadSubscriptions(env);
  store.subscriptions = store.subscriptions.filter(
    (rec) => rec && rec.subscription && rec.subscription.endpoint !== endpoint
  );
  await saveSubscriptions(env, store);
  await env.KV_NAMESPACE.delete("ep:" + endpoint);

  /* Расписание оставляем: пользователь может включить пуши заново */
  void userId;
  return jsonResponse({ success: true });
}

async function handleItemsSave(env, body) {
  const userId = body && body.userId;
  const items = body && body.items;
  const tzOffsetMin = typeof (body && body.tzOffsetMin) === "number" ? body.tzOffsetMin : 0;

  if (!userId || typeof userId !== "string") return jsonResponse({ error: "userId обязателен" }, 400);
  if (!Array.isArray(items)) return jsonResponse({ error: "items должен быть массивом" }, 400);

  const sched = await loadSchedule(env, userId);
  sched.items = items;
  sched.tzOffsetMin = tzOffsetMin;
  await kvPutJson(env, "user:" + userId, sched);

  return jsonResponse({ success: true, saved: items.length });
}

async function handleDebug(env) {
  const store = await loadSubscriptions(env);
  let users = 0;
  try {
    const listed = await env.KV_NAMESPACE.list({ prefix: "user:", limit: 1000 });
    users = (listed.keys || []).length;
  } catch (err) {
    users = -1;
  }
  return jsonResponse({
    ok: true,
    vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    privateKeyOk: await isPrivateKeyOk(env),
    subscriptions: store.subscriptions.length,
    users: users,
  });
}

export async function route(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (path === "/api/health") return jsonResponse({ ok: true, time: new Date().toISOString() });
  if (path === "/api/vapid-public-key") {
    if (!env.VAPID_PUBLIC_KEY) return textResponse("VAPID_PUBLIC_KEY не задан", 500);
    return textResponse(env.VAPID_PUBLIC_KEY);
  }
  if (path === "/api/debug") return handleDebug(env);

  if (request.method === "POST") {
    const body = await readJson(request);
    if (body === null) return jsonResponse({ error: "тело должно быть JSON" }, 400);

    if (path === "/api/subscribe") return handleSubscribe(env, body);
    if (path === "/api/unsubscribe") return handleUnsubscribe(env, body);
    if (path === "/api/items/save") return handleItemsSave(env, body);
  }

  return jsonResponse({ error: "не найдено", path: path }, 404);
}

/* ============================================================
   9. Точки входа Cloudflare Worker
   ============================================================ */

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 500);
    }
  },

  /* Запускается планировщиком каждые 1–2 минуты (см. wrangler.toml) */
  async scheduled(event, env, ctx) {
    await runCron(env);
  },
};
