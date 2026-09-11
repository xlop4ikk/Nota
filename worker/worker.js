/* Nota Push Worker — Cloudflare Worker
   Реализует Web Push (RFC 8291) без внешних библиотек.
   Endpoints:
     GET  /api/health
     GET  /api/vapid-public-key
     POST /api/subscribe
     POST /api/unsubscribe
     POST /api/items/save
     GET  /api/debug
   Cron: каждую минуту проверяет задачи и рассылает пуши. */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

/* ---------- base64url ---------- */

function b64uToBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64u(bytes) {
  let bin = "";
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function strToB64u(s) {
  return bytesToB64u(new TextEncoder().encode(s));
}

/* ---------- VAPID JWT (ES256) ---------- */

let cachedVapidKey = null;
let cachedVapidKeyRaw = null;

async function getVapidPrivateKey(env) {
  const raw = env.VAPID_PRIVATE_KEY;
  if (!raw) throw new Error("VAPID_PRIVATE_KEY не задан");
  if (cachedVapidKeyRaw === raw && cachedVapidKey) return cachedVapidKey;

  // d-скаляр (base64url) → JWK для importKey
  const d = b64uToBytes(raw);
  // Публичный ключ нужен, чтобы получить x и y для JWK
  const pub = b64uToBytes(env.VAPID_PUBLIC_KEY); // 65 байт: 0x04 || X(32) || Y(32)
  const x = bytesToB64u(pub.slice(1, 33));
  const y = bytesToB64u(pub.slice(33, 65));

  const jwk = {
    kty: "EC",
    crv: "P-256",
    d: bytesToB64u(d),
    x,
    y,
  };

  cachedVapidKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  );
  cachedVapidKeyRaw = raw;
  return cachedVapidKey;
}

async function buildVapidAuthHeader(env, endpoint) {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  };

  const signingInput =
    strToB64u(JSON.stringify(header)) + "." + strToB64u(JSON.stringify(payload));
  const key = await getVapidPrivateKey(env);
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = signingInput + "." + bytesToB64u(sig);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

/* ---------- HKDF ---------- */

async function hkdfExtract(salt, ikm) {
  const key = await crypto.subtle.importKey(
    "raw", ikm, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, salt));
}

async function hkdfExpand(prk, info, length) {
  const key = await crypto.subtle.importKey(
    "raw", prk, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const infoBytes = new Uint8Array(info);
  const prkLen = prk.byteLength;
  const result = new Uint8Array(length);
  let prev = new Uint8Array(0);
  let offset = 0;
  let counter = 1;
  while (offset < length) {
    const input = new Uint8Array(prev.length + infoBytes.length + 1);
    input.set(prev, 0);
    input.set(infoBytes, prev.length);
    input[input.length - 1] = counter;
    prev = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
    const take = Math.min(prev.length, length - offset);
    result.set(prev.slice(0, take), offset);
    offset += take;
    counter++;
  }
  return result;
}

/* ---------- Шифрование payload (RFC 8291) ---------- */

async function encryptPayload(subscription, payloadObj) {
  const uaPublic = b64uToBytes(subscription.keys.p256dh);
  const authSecret = b64uToBytes(subscription.keys.auth);

  // Эфемерная пара ECDH P-256
  const ephemeral = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );
  const asPublicRaw = new Uint8Array(
    await crypto.subtle.exportKey("raw", ephemeral.publicKey)
  );

  // Импортируем UA-ключ
  const uaKey = await crypto.subtle.importKey(
    "raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []
  );

  // ECDH shared secret
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: uaKey },
      ephemeral.privateKey,
      256
    )
  );

  // IKM
  const keyInfo = new Uint8Array(14 + 1 + uaPublic.length + asPublicRaw.length);
  keyInfo.set(new TextEncoder().encode("WebPush: info"), 0);
  keyInfo[13] = 0;
  keyInfo.set(uaPublic, 14);
  keyInfo.set(asPublicRaw, 14 + uaPublic.length);

  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // CEK и nonce
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hkdfExtract(salt, ikm);

  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm");
  const cekInfoFull = new Uint8Array(cekInfo.length + 1);
  cekInfoFull.set(cekInfo, 0);
  cekInfoFull[cekInfo.length] = 0;

  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce");
  const nonceInfoFull = new Uint8Array(nonceInfo.length + 1);
  nonceInfoFull.set(nonceInfo, 0);
  nonceInfoFull[nonceInfo.length] = 0;

  const cek = await hkdfExpand(prk, cekInfoFull, 16);
  const nonce = await hkdfExpand(prk, nonceInfoFull, 12);

  // Шифрование AES-128-GCM
  const cekKey = await crypto.subtle.importKey(
    "raw", cek, { name: "AES-GCM" }, false, ["encrypt"]
  );

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payloadObj));
  // record = payload || 0x02 (delimiter)
  const record = new Uint8Array(payloadBytes.length + 1);
  record.set(payloadBytes, 0);
  record[payloadBytes.length] = 0x02;

  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, tagLength: 128 },
      cekKey,
      record
    )
  );

  // Body = salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);

  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header, 0);
  body.set(ciphertext, header.length);

  return body;
}

/* ---------- Отправка push ---------- */

async function sendPush(env, subscription, payloadObj) {
  const endpoint = subscription.endpoint;
  const auth = await buildVapidAuthHeader(env, endpoint);
  const body = await encryptPayload(subscription, payloadObj);

  // Лимит 4096 байт (APNs/FCM)
  if (body.length > 4000) {
    console.warn("Push body слишком большой:", body.length);
    throw new Error("Payload > 4096 байт");
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Push ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.status;
}

/* ---------- Cron: проверка напоминаний ---------- */

async function checkReminders(env) {
  const list = await env.NotaStorage.list({ prefix: "user:" });
  const now = Date.now();

  for (const key of list.keys) {
    const userId = key.name.slice(5);
    let sched;
    try {
      sched = await env.NotaStorage.get(key.name, "json");
    } catch {
      continue;
    }
    if (!sched) continue;

    const items = sched.items || [];
    const tzOffsetMin = sched.tzOffsetMin || 0;
    const notified = sched.notifiedToday || {};
    const userNow = new Date(now - tzOffsetMin * 60000);

    // Локальные дата и время пользователя
    const yyyy = userNow.getUTCFullYear();
    const mm = String(userNow.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(userNow.getUTCDate()).padStart(2, "0");
    const today = `${yyyy}-${mm}-${dd}`;
    const hh = String(userNow.getUTCHours()).padStart(2, "0");
    const mi = String(userNow.getUTCMinutes()).padStart(2, "0");
    const currentTime = `${hh}:${mi}`;

    const due = [];
    for (const item of items) {
      if (item.done || !item.due) continue;
      const dueDate = new Date(item.due);
      if (Number.isNaN(dueDate.getTime())) continue;
      // Локальная дата/время задачи
      const itemLocal = new Date(dueDate.getTime() - tzOffsetMin * 60000);
      const iy = itemLocal.getUTCFullYear();
      const im = String(itemLocal.getUTCMonth() + 1).padStart(2, "0");
      const id = String(itemLocal.getUTCDate()).padStart(2, "0");
      const itemDate = `${iy}-${im}-${id}`;
      if (itemDate !== today) continue;
      const ih = String(itemLocal.getUTCHours()).padStart(2, "0");
      const imi = String(itemLocal.getUTCMinutes()).padStart(2, "0");
      const itemTime = `${ih}:${imi}`;
      if (itemTime > currentTime) continue;
      const notifyKey = `${item.id}:${today}`;
      if (notified[notifyKey]) continue;
      due.push({ item, notifyKey });
    }

    if (!due.length) continue;

    // Получаем подписки пользователя
    const subsList = await env.NotaStorage.list({ prefix: `sub:${userId}:` });
    if (!subsList.keys.length) continue;

    for (const subKey of subsList.keys) {
      const sub = await env.NotaStorage.get(subKey.name, "json");
      if (!sub || !sub.subscription) continue;

      for (const { item, notifyKey } of due) {
        try {
          const status = await sendPush(env, sub.subscription, {
            title: "Nota",
            body: item.title,
            tag: "nota-" + Date.now(),
            taskId: item.id,
          });
          console.log(`Push: user=${userId} item=${item.id} status=${status}`);
          notified[notifyKey] = now;
        } catch (err) {
          console.error(`Push error user=${userId}:`, err.message);
        }
      }
    }

    // Чистим notifiedToday: оставляем только ключи сегодня
    const cleaned = {};
    for (const k of Object.keys(notified)) {
      if (k.endsWith(":" + today)) cleaned[k] = notified[k];
    }
    sched.notifiedToday = cleaned;
    sched.items = items;
    await env.NotaStorage.put(key.name, JSON.stringify(sched));
  }
}

/* ---------- HTTP ---------- */

async function handleRequest(request, env) {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  if (url.pathname === "/api/health") {
    return json({ ok: true, time: new Date().toISOString() });
  }

  if (url.pathname === "/api/vapid-public-key") {
    return new Response(env.VAPID_PUBLIC_KEY, {
      headers: { ...CORS, "Content-Type": "text/plain" },
    });
  }

  if (url.pathname === "/api/subscribe" && request.method === "POST") {
    const { userId, subscription, tzOffsetMin } = await request.json();
    if (!userId || !subscription || !subscription.endpoint) {
      return json({ error: "invalid payload" }, 400);
    }

    // Сохраняем подписку по endpoint
    await env.NotaStorage.put(
      `sub:${userId}:${subscription.endpoint}`,
      JSON.stringify({ subscription, userId, tzOffsetMin, addedAt: Date.now() })
    );

    // Обновляем расписание пользователя
    const sched = (await env.NotaStorage.get(`user:${userId}`, "json")) || {
      items: [],
      tzOffsetMin,
      notifiedToday: {},
    };
    sched.tzOffsetMin = tzOffsetMin;
    await env.NotaStorage.put(`user:${userId}`, JSON.stringify(sched));

    return json({ success: true });
  }

  if (url.pathname === "/api/unsubscribe" && request.method === "POST") {
    const { userId, endpoint } = await request.json();
    if (userId && endpoint) {
      await env.NotaStorage.delete(`sub:${userId}:${endpoint}`);
    }
    return json({ success: true });
  }

  if (url.pathname === "/api/items/save" && request.method === "POST") {
    const { userId, items, tzOffsetMin } = await request.json();
    if (!userId || !Array.isArray(items)) {
      return json({ error: "invalid payload" }, 400);
    }
    const sched = (await env.NotaStorage.get(`user:${userId}`, "json")) || {
      items: [],
      tzOffsetMin: tzOffsetMin || 0,
      notifiedToday: {},
    };
    sched.items = items;
    if (typeof tzOffsetMin === "number") sched.tzOffsetMin = tzOffsetMin;
    await env.NotaStorage.put(`user:${userId}`, JSON.stringify(sched));
    return json({ success: true, saved: items.length });
  }

  if (url.pathname === "/api/debug") {
    const users = await env.NotaStorage.list({ prefix: "user:" });
    const subs = await env.NotaStorage.list({ prefix: "sub:" });
    return json({
      ok: true,
      vapidConfigured: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
      users: users.keys.length,
      subscriptions: subs.keys.length,
    });
  }

  return json({ error: "not found" }, 404);
}

export default {
  fetch: handleRequest,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(checkReminders(env));
  },
};