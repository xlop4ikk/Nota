#!/usr/bin/env node
/* ============================================================
   Nota — генератор VAPID-ключей (Web Push, RFC 8292).
   Только Node.js, без единой зависимости.

   Запуск:  node tools/gen_vapid.js

   На выходе два значения:
     VAPID_PUBLIC_KEY  — 87 символов base64url → в [vars] wrangler.toml
     VAPID_PRIVATE_KEY — 43 символа base64url  → только в секрет:
                         wrangler secret put VAPID_PRIVATE_KEY
   ============================================================ */

"use strict";

const crypto = require("crypto");

function toBase64Url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/* Публичный ключ: SPKI DER содержит 26-байтный префикс алгоритма,
   нас интересует последние 65 байт — uncompressed point (0x04 || X || Y). */
function publicAsBase64Url(publicKey) {
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - 65);
  if (raw[0] !== 0x04) {
    throw new Error("Ожидалась uncompressed точка (0x04), получился другой формат ключа");
  }
  return toBase64Url(raw);
}

/* Приватный ключ: берём скаляр d из JWK. Именно этот формат (43 символа)
   понимает Worker в crypto.subtle.importKey. JWK-JSON и PEM ломают импорт
   ошибкой «Invalid EC key in JSON Web Key». */
function privateAsBase64Url(privateKey) {
  const jwk = privateKey.export({ format: "jwk" });
  if (!jwk.d) throw new Error("В JWK нет поля d — приватный ключ не найден");
  return jwk.d;
}

const { publicKey, privateKey } = crypto.generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

const publicKeyStr = publicAsBase64Url(publicKey);
const privateKeyStr = privateAsBase64Url(privateKey);

if (publicKeyStr.length !== 87) {
  throw new Error("Публичный ключ должен быть 87 символов, получилось " + publicKeyStr.length);
}
if (privateKeyStr.length !== 43) {
  throw new Error("Приватный ключ должен быть 43 символов, получилось " + privateKeyStr.length);
}

console.log("VAPID-ключи сгенерированы.\n");
console.log("1) Впишите в worker/wrangler.toml секции [vars]:");
console.log("   VAPID_PUBLIC_KEY = \"" + publicKeyStr + "\"\n");
console.log("2) Сохраните приватный ключ как секрет Cloudflare (из папки worker):");
console.log("   wrangler secret put VAPID_PRIVATE_KEY");
console.log("   и вставьте это значение:");
console.log("   " + privateKeyStr + "\n");
console.log("Приватный ключ не должен попадать в git и в [vars].");
