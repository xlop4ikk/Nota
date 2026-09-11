#!/usr/bin/env node
/* ============================================================
   Nota — проверка согласованности фронтенда (без зависимостей).

   Запуск:  node tools/check-site.mjs

   Ловит ошибки интеграции HTML ↔ JS ↔ манифеста, которые видны
   только в браузере: несуществующие id, битые пути иконок,
   отсутствие файлов из кэша Service Worker'а.
   ============================================================ */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

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

const html = readFileSync(join(DOCS, "index.html"), "utf8");
const appJs = readFileSync(join(DOCS, "app.js"), "utf8");
const swJs = readFileSync(join(DOCS, "sw.js"), "utf8");
const css = readFileSync(join(DOCS, "style.css"), "utf8");
const manifest = JSON.parse(readFileSync(join(DOCS, "manifest.json"), "utf8"));

/* ---------- 1. Каждый getElementById есть в разметке ---------- */

console.log("\n1. Селекторы app.js против index.html");

const ids = new Set();
for (const match of appJs.matchAll(/\$\("([^"]+)"\)|getElementById\("([^"]+)"\)/g)) {
  ids.add(match[1] || match[2]);
}
check("в app.js найдены обращения к элементам", ids.size > 10, "найдено " + ids.size);

const missingIds = [...ids].filter((id) => !new RegExp('id="' + id + '"').test(html));
check("все id из app.js присутствуют в HTML", missingIds.length === 0, missingIds.join(", "));

/* ---------- 2. Имена radiogroup из app.js есть в разметке ---------- */

const names = new Set();
for (const match of appJs.matchAll(/name="([^"]+)"/g)) names.add(match[1]);
const missingNames = [...names].filter((name) => !new RegExp('name="' + name + '"').test(html));
check("все name= из app.js присутствуют в HTML", missingNames.length === 0, missingNames.join(", "));

/* ---------- 3. Классы, которыми app.js управляет, описаны в CSS ---------- */

const cssClasses = ["item", "item__inner", "item--done", "is-swiping", "is-checked", "is-flash", "check__box", "subitem", "is-on", "is-active"];
const missingCss = cssClasses.filter((cls) => !css.includes("." + cls));
check("управляемые классы описаны в style.css", missingCss.length === 0, missingCss.join(", "));

/* ---------- 4. Пути ресурсов в HTML существуют ---------- */

console.log("\n2. Пути ресурсов");

const refs = new Set();
for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
  const value = match[1];
  if (/^(https?:|mailto:|data:)/.test(value) || value.startsWith("#")) continue;
  refs.add(value);
}
const missingRefs = [...refs].filter((ref) => !existsSync(join(DOCS, ref)));
check("все href/src из index.html указывают на существующие файлы", missingRefs.length === 0, missingRefs.join(", "));
check("в index.html есть подключение style.css", refs.has("style.css"));
check("в index.html есть подключение app.js", refs.has("app.js"));
check("в index.html подключён manifest", refs.has("manifest.json"));

/* ---------- 5. Манифест ---------- */

console.log("\n3. PWA-манифест");

const missingIcons = manifest.icons.map((icon) => icon.src).filter((src) => !existsSync(join(DOCS, src)));
check("иконки из манифеста существуют", missingIcons.length === 0, missingIcons.join(", "));
check("манифест: display standalone", manifest.display === "standalone");
check("манифест: есть иконка 192", manifest.icons.some((i) => i.sizes === "192x192"));
check("манифест: есть иконка 512", manifest.icons.some((i) => i.sizes === "512x512"));
check("манифест: есть maskable-иконка", manifest.icons.some((i) => i.purpose === "maskable"));
check("манифест: относительные start_url и scope (для /nota/ на Pages)", manifest.start_url === "./" && manifest.scope === "./");
check("манифест: lang ru", manifest.lang === "ru");

/* ---------- 6. Service Worker кэширует только существующее ---------- */

console.log("\n4. Service Worker");

const coreBlock = swJs.slice(swJs.indexOf("CORE_ASSETS"), swJs.indexOf("];", swJs.indexOf("CORE_ASSETS")));
const cached = [...coreBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== "./");
const missingCached = cached.filter((path) => !existsSync(join(DOCS, path.replace(/^\.\//, ""))));
check("CORE_ASSETS кэширует существующие файлы", missingCached.length === 0, missingCached.join(", "));
check("sw.js содержит версию кэша", /const VERSION = "nota-v\d+"/.test(swJs));
check("sw.js: skipWaiting в install", /skipWaiting\(\)/.test(swJs));
check("sw.js: clients.claim в activate", /clients\.claim\(\)/.test(swJs));
check("sw.js: уникальный tag (время + случайная часть)", /"nota-" \+ Date\.now\(\)\.toString\(36\)/.test(swJs) && /Math\.random\(\)\.toString\(36\)/.test(swJs));
check("sw.js: имя кэша = VERSION без дублирования префикса", /const CACHE_NAME = VERSION;/.test(swJs));
check("sw.js: showNotification без await до него", /event\.waitUntil\(showWithFallback/.test(swJs));
check("sw.js: цепочка fallback из трёх попыток", (swJs.match(/showNotification/g) || []).length >= 3);
check("sw.js: обработчик notificationclick", /notificationclick/.test(swJs));
check("sw.js: openWindow как запасной вариант", /clients\.openWindow/.test(swJs));

/* ---------- 7. Ключи localStorage по спецификации ---------- */

console.log("\n5. Ключи localStorage");

for (const key of ["nota.items.v1", "nota.userId.v1", "nota.pushEnabled.v1", "nota.view.v1"]) {
  check("ключ " + key + " используется", appJs.includes('"' + key + '"'));
}

/* ---------- 8. Модель данных ---------- */

console.log("\n6. Модель данных и требования задания");

for (const field of ["type", "title", "body", "items", "priority", "dueDate", "dueTime", "repeat", "done", "doneAt", "createdAt", "notifiedAt"]) {
  check("поле " + field + " присутствует в модели", appJs.includes(field + ":"));
}
check("title ограничен 80 символами", appJs.includes("slice(0, 80)"));
check("валидация: название обязательно", /Если|укажите название|Название/i.test(appJs) && appJs.includes("!title"));
check("валидация: время без даты запрещена", appJs.includes("dueTime && !dueDate"));
check("валидация: дата не в прошлом при создании", /!editingId && dueDate && dueDate < todayStr\(\)/.test(appJs));
check("поиск использует filter()", /\.filter\(/.test(appJs));
check("вибрация через navigator.vibrate", appJs.includes("navigator.vibrate"));
check("звук через WebAudio", appJs.includes("AudioContext"));
check("подтверждение удаления через confirm()", appJs.includes("window.confirm("));
check("debounce синхронизации 1000 мс", appJs.includes("setTimeout(syncToServer, 1000)"));
check("синк идёт на /api/items/save", appJs.includes("/api/items/save"));
check("подписка использует applicationServerKey", appJs.includes("applicationServerKey"));
check("VAPID-ключ валидируется регуляркой из 87 символов", /\[A-Za-z0-9_-\]\{87\}/.test(appJs));
check("обработка отсутствия PushManager (iOS)", appJs.includes("PushManager"));
check("проверка isSecureContext", appJs.includes("isSecureContext"));
check("tzOffsetMin берётся из getTimezoneOffset", appJs.includes("getTimezoneOffset()"));
check("тосты вместо alert()", !/[^.\w]alert\(/.test(appJs) && appJs.includes("function toast("));
check("повтор: daily/weekly/monthly поддерживаются", ["daily", "weekly", "monthly"].every((r) => appJs.includes('"' + r + '"')));

/* ---------- 9. UI-ограничения из задания ---------- */

console.log("\n7. Требования к UI");

check("тёмная тема через prefers-color-scheme", css.includes("prefers-color-scheme: dark"));
check("max-width контента 640px", css.includes("max-width: 640px"));
check("тач-цели 44px заданы переменной", css.includes("--tap: 44px"));
check("скругление 16px задано переменной", css.includes("--radius: 16px"));
check("safe area: viewport-fit=cover в HTML", html.includes("viewport-fit=cover"));
check("safe area: env(safe-area-inset-bottom) в CSS", css.includes("env(safe-area-inset-bottom)"));
check("безопасная зона учтена у нижних вкладок", css.slice(css.indexOf(".tabs {"), css.indexOf(".tabs {") + 900).includes("safe-area-inset-bottom"));
check("prefers-reduced-motion учтён", css.includes("prefers-reduced-motion"));
check("в HTML четыре вкладки", (html.match(/data-view="/g) || []).length === 4);
check("в HTML есть кнопка push со state", html.includes('id="pushBtn"') && html.includes("aria-pressed"));
check("разметка и текст на русском", /Сегодня|Архив|Напоминания/.test(html));

/* ---------- 10. Worker не тянет зависимостей ---------- */

console.log("\n8. Ограничения бэкенда");

const workerJs = readFileSync(join(ROOT, "worker", "worker.js"), "utf8");
check("worker: нет import/require сторонних модулей", !/(^|\n)\s*import .* from "(?!\.)/.test(workerJs.replace(/export \{[\s\S]*?\}/g, "")));
check("worker: используется crypto.subtle", workerJs.includes("crypto.subtle"));
check("worker: нет npm-пакета в проекте", !existsSync(join(ROOT, "package.json")));
check("структура репозитория соответствует заданию",
  ["docs/index.html", "docs/style.css", "docs/app.js", "docs/sw.js", "docs/manifest.json", "docs/.nojekyll", "worker/worker.js", "worker/wrangler.toml", "tools/gen_vapid.js", "DEPLOY.md"]
    .every((p) => existsSync(join(ROOT, p))));

/* ---------- Итог ---------- */

console.log("\n" + "=".repeat(52));
if (failures.length) {
  console.log("ПРОВАЛЕНО " + failures.length + " проверок из " + (passed + failures.length) + ":");
  for (const failure of failures) console.log("  - " + failure);
  process.exit(1);
}
console.log("ВСЕ ПРОВЕРКИ ПРОЙДЕНЫ: " + passed + " шт.");
