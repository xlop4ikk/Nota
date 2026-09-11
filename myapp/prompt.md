# ПРОМПТ: Создание приложения «Nota» — менеджер заметок и задач с push-напоминаниями

Скопируй этот промпт целиком и отправь нейросети-разработчику. Он самодостаточен: содержит архитектуру, контракты API, известные подводные камни и шаги деплоя, проверенные на реальном проекте.

---

## Роль

Ты — опытный fullstack-разработчик. Создай с нуля веб-приложение **«Nota»** — менеджер заметок, задач и списков дел с push-напоминаниями. Приложение должно работать как PWA: устанавливаться на главный экран телефона, работать офлайн и присылать фоновые уведомления о задачах **даже когда приложение закрыто**.

## Жёсткие технические ограничения (соблюдать обязательно)

1. **Ноль платных сервисов.** Только бесплатные тарифы: GitHub Pages (хостинг статики), Cloudflare Workers + KV (бэкенд), Apple APNs / Google FCM (доставка пушей).
2. **Ноль npm-зависимостей в рантайме.** Фронтенд — чистый HTML/CSS/JavaScript (без React/Vue/сборщиков). Бэкенд — чистый Web Crypto API в Cloudflare Worker (без библиотек типа web-push).
3. **Весь код и UI на русском языке.** Комментарии в коде — на русском.
4. **Мультипользовательская изоляция:** данные и уведомления каждого пользователя строго разделены (см. раздел «Архитектура»).
5. Никакого бэкенда на Node/Python — серверная часть живёт ТОЛЬКО в Cloudflare Worker.

## Структура репозитория

```
nota/
├── docs/                  # сайт, публикуется на GitHub Pages (папка /docs как source)
│   ├── .nojekyll          # пустой файл, отключает Jekyll
│   ├── index.html         # единственный HTML-файл приложения
│   ├── style.css          # все стили
│   ├── app.js             # вся логика клиента
│   ├── sw.js              # Service Worker (кэш + приём push)
│   ├── manifest.json      # PWA-манифест
│   └── icons/             # icon-192.png, icon-512.png
├── worker/                # бэкенд Cloudflare Worker
│   ├── worker.js          # весь серверный код (один файл)
│   └── wrangler.toml      # конфиг деплоя
├── tools/
│   └── gen_vapid.js       # генератор VAPID-ключей (Node.js)
└── DEPLOY.md              # пошаговая инструкция деплоя
```

## Модель данных

### Заметка (note) — хранится в localStorage

```js
{
  id: "mtf8k2x7a",          // uid: Date.now().toString(36) + random
  type: "task" | "note" | "list",
  title: "Купить молоко",    // до 80 символов, обязательное
  body: "",                  // текст заметки / Markdown-lite
  items: [],                 // для type="list": [{ text, done }]
  priority: "low" | "normal" | "high",
  dueDate: "2026-09-15",     // YYYY-MM-DD или null
  dueTime: "18:30",          // HH:MM или null (если есть dueTime — обязана быть dueDate)
  repeat: "none" | "daily" | "weekly" | "monthly",
  done: false,
  doneAt: null,              // timestamp
  createdAt: 1788000000000,
  notifiedAt: null           // защита от повторных пушей
}
```

### Ключи localStorage

```
nota.items.v1          — массив всех заметок/задач
nota.userId.v1         — уникальный ID устройства: "user_" + Date.now().toString(36) + random
nota.pushEnabled.v1    — "1" / "0"
nota.view.v1           — последний выбранный раздел (активные/сегодня/все/архив)
```

`userId` генерируется один раз при первом запуске и НЕ удаляется при очистке данных заметок (иначе потеряются подписки).

## Функциональность фронтенда

1. **Разделы (вкладки внизу):** «Сегодня», «Все», «Списки», «Архив».
2. **Создание/редактирование** через нижнюю шторку (bottom sheet): тип (задача/заметка/список), название, описание, дата, время, повтор (none/daily/weekly/monthly), приоритет.
3. **Валидация формы:** название обязательно; если указано время — дата обязательна; дата не может быть в прошлом при создании.
4. **Отметка выполнения** — тап по чекбоксу, анимация, вибрация (navigator.vibrate), звуковой сигнал через WebAudio (короткий «дзынь»).
5. **Свайп для удаления** + подтверждение через confirm().
6. **Поиск** по названию и тексту (обычный filter()).
7. **Счётчик активных задач** в шапке.
8. **Кнопка 🔔/🔕 в шапке** — вкл/выкл push-уведомлений (подписка/отписка).
9. **Тосты** вместо alert() для всех сообщений пользователю.
10. **Синхронизация:** после каждого изменения — debounce-отправка (1 сек) всего массива на сервер `POST /api/items/save`.

### Требования к UI

- Мобильный first: ширина контента max 640px, крупные тач-цели (≥44px).
- Светлая дружелюбная тема, CSS-переменные, скругления 16px, мягкие тени.
- Тёмная тема через `@media (prefers-color-scheme: dark)`.
- Safe area для iPhone (`viewport-fit=cover`, `env(safe-area-inset-bottom)` у нижней навигации).

## Контракты API (Worker)

Все ответы — JSON с CORS-заголовками. Обработчик `OPTIONS` возвращает 204 с теми же CORS.

```
GET  /api/health
  → { ok: true, time: "<ISO>" }

GET  /api/vapid-public-key
  → text/plain: публичный VAPID-ключ (87 символов base64url)

POST /api/subscribe
  body: { userId, subscription: PushSubscription.toJSON(), tzOffsetMin }
  → { success: true }
  Действия: сохранить/обновить запись в "subscriptions" (по endpoint),
  записать "ep:{endpoint}" → userId, сохранить расписание в "user:{userId}".

POST /api/unsubscribe
  body: { userId, endpoint }
  → { success: true }
  Удалить запись из "subscriptions" и ключ "ep:{endpoint}".

POST /api/items/save
  body: { userId, items, tzOffsetMin }
  → { success: true, saved: <число> }
  Записать в KV-ключ "user:{userId}".

GET  /api/debug
  → { ok, vapidConfigured, privateKeyOk, subscriptions, users }
```

## Структура Cloudflare KV

| Ключ | Значение |
|---|---|
| `subscriptions` | `{ subscriptions: [{ subscription, userId, tzOffsetMin, addedAt }] }` |
| `user:{userId}` | `{ items, tzOffsetMin, notifiedToday: { "itemId:YYYY-MM-DD": ts } }` |
| `ep:{endpoint}` | строка `userId` (mapping подписки пользователя) |

## Логика cron-напоминаний (scheduled, каждые 1–2 минуты)

```
для каждой подписки в subscriptions:
  userId = rec.userId || KV.get("ep:" + endpoint)
  если нет userId — пропустить
  sched = KV.get("user:" + userId)
  userNow = new Date(Date.now() - sched.tzOffsetMin * 60000)   // локальное время пользователя
  для каждого item:
    если done || !dueDate || !dueTime — пропустить
    если dueDate !== сегодня — пропустить
    если dueTime > текущее время пользователя — пропустить
    если notifiedToday[itemId + ":" + today] — пропустить
    → добавить в due
  если due не пусто:
    сформировать payload { title, body, url }
    отправить push ЭТОЙ подписке (не всем!)
    если отправлено успешно — записать notifiedToday, сохранить sched
  чистить notifiedToday: оставлять только ключи сегодняшнего дня
повторы (repeat): при срабатывании напоминания for daily/weekly/monthly —
сервер не меняет данные (источник правды — localStorage клиента),
но при syncToServer клиент сам сдвигает dueDate на следующий период,
когда задача с repeat отмечена выполненной.
```

**Критично:** пуш отправляется ТОЛЬКО подпискам с тем же userId, чьё расписание проверено. Один пользователь никогда не получает чужие напоминания.

## Web Push: криптография (реализовать вручную, без библиотек)

### VAPID (RFC 8292)
- Пара EC P-256. Публичный ключ — uncompressed point (65 байт, base64url, 87 символов).
- Приватный ключ хранить как **Cloudflare Secret** (`wrangler secret put VAPID_PRIVATE_KEY`) в формате **`d`-скalar base64url (43 символа)** — НЕ JWK-JSON, НЕ PEM.
- JWT: header `{typ:"JWT",alg:"ES256"}`, payload `{aud: origin endpoint, exp: now+12h, sub: mailto}`. Подпись ES256 через `crypto.subtle.sign` (это уже raw r||s, конвертация не нужна).
- Заголовок: `Authorization: vapid t=<jwt>, k=<публичный ключ>`.

### Шифрование payload (RFC 8291, aes128gcm)
- Эфемерная пара ECDH P-256 на каждое сообщение.
- `IKM = HKDF-Expand(HKDF-Extract(auth_secret, ecdh_secret), "WebPush: info\0" || ua_public || as_public, 32)`
- `salt = 16 случайных байт`; `CEK = HKDF(..., "Content-Encoding: aes128gcm\0", 16)`; `nonce = HKDF(..., "Content-Encoding: nonce\0", 12)`
- Record = `payload || 0x02` (без раздувания паддингом!)
- Body = `salt(16) || rs(4 BE) || idlen(1) || keyid(65) || ciphertext`

### ⚠️ Критический лимит
**Полное тело запроса в APNs/FCM не может превышать 4096 байт.** Не дополняй record паддингом до rs — Apple вернёт HTTP 413. Проверяй длину до отправки: если payload > ~3900 байт — укорачивай текст.

## Service Worker (sw.js)

1. **install:** закешировать оболочку (index.html, style.css, app.js, manifest, иконки), `skipWaiting()`.
2. **activate:** удалить все кешы кроме текущего, `clients.claim()`.
3. **fetch:** cache-first для GET своего происхождения; при ошибке сети — отдать index.html.
4. **push:** показать уведомление. Правила:
   - Показывать уведомление ВСЕГДА при получении push (иначе iOS отзовет разрешения), даже если payload битый — показывать дефолт.
   - Показывать ПЕРВЫМ делом, через `event.waitUntil`, без await-ов до showNotification.
   - **`tag` должен быть уникальным на каждое уведомление** (`"nota-" + Date.now()`): одинаковый tag заставляет Chrome молча заменять уведомление без звука — пользователь думает, что пуши не приходят.
   - Вызывать showNotification с fallback: полный набор опций → при ошибке только {body, tag} → при ошибке вообще без опций.
5. **notificationclick:** закрыть уведомление, найти открытый client и focus(), иначе openWindow.

### Версионирование кеша
При каждом деплое фронтенда поднимай константу версии кеша (`nota-v1` → `nota-v2` ...). Иначе пользователи останутся на старом кэше.

## ⚠️ Известные подводные камни (проверено на практике, не наступай)

1. **Формат приватного VAPID-ключа** — только `d`-скаляр base64url (43 символа). JWK-JSON и PEM ломают `crypto.subtle.importKey` с ошибкой «Invalid EC key in JSON Web Key».
2. **HTTP 413 от Apple** — тело push > 4096 байт из-за паддинга до `rs`. См. выше.
3. **Одинаковый tag** — тихая замена уведомлений в Chrome.
4. **iOS:** пуши работают ТОЛЬКО из PWA, добавленной на главный экран (Safari → Поделиться → «На экран Домой»), iOS ≥ 16.4. В обычной вкладке Safari `PushManager` отсутствует — это норма, а не баг. После установки PWA может потребоваться перезагрузка телефона для активации push-канала.
5. **GitHub Pages уже отдаёт HTTPS** — если браузер пишет «не поддерживает Web Push», причина не в HTTPS, а в контексте (вкладка вместо PWA, встроенный браузер соцсети).
6. **Ошибка `atob` «string contains invalid characters»** — клиент получил JSON-ошибку вместо VAPID-ключа. Валидируй ответ: `/^[A-Za-z0-9_-]{87}$/`.
7. **SITE_URL без слэша на конце** при склейке с путями иконок (двойной `//` ломает загрузку иконки).
8. **Cron-зона:** Worker работает в UTC. Локальное время пользователя = `new Date(Date.now() - tzOffsetMin * 60000)`, где `tzOffsetMin = new Date().getTimezoneOffset()` клиента.
9. **`notifiedToday` чистить ежедневно** (ключи только текущего дня), иначе KV разрастётся и будут ложные «уже уведомляли».
10. **Хранить приватный ключ в [vars] нельзя** — только `wrangler secret put`.

## Генератор ключей (tools/gen_vapid.js)

Node.js, без зависимостей:
- `crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })`
- Публичный: SPKI DER → последние 65 байт → base64url (87 символов) → `VAPID_PUBLIC_KEY` в `[vars]`.
- Приватный: JWK-экспорт → взять поле `.d` → base64url 43 символа → `wrangler secret put VAPID_PRIVATE_KEY`.

## wrangler.toml (шаблон)

```toml
name = "nota-push"
main = "worker.js"
compatibility_date = "2024-09-01"

[[kv_namespaces]]
binding = "KV_NAMESPACE"
id = "<id из 'wrangler kv namespace create NOTA'>"

[triggers]
crons = ["* * * * *"]

[vars]
VAPID_SUBJECT = "mailto:you@example.com"
SITE_URL = "https://<login>.github.io/nota/"   # со слэшем — в воркере срезать
VAPID_PUBLIC_KEY = "<87 символов>"
# VAPID_PRIVATE_KEY — только через secret, в файле его нет
```

## Пошаговые инструкции деплоя (положить в DEPLOY.md)

1. `node tools/gen_vapid.js` → получить пару ключей.
2. GitHub: создать репозиторий `nota`, загрузить файлы, Settings → Pages → Branch `main`, folder `/docs`.
3. `npm i -g wrangler && wrangler login`.
4. `cd worker && wrangler kv namespace create NOTA` → вписать id в wrangler.toml.
5. Вписать VAPID_PUBLIC_KEY, SITE_URL, VAPID_SUBJECT в wrangler.toml.
6. `wrangler secret put VAPID_PRIVATE_KEY` → вставить 43-символьный ключ.
7. `wrangler deploy` → получить `https://nota-push.<subdomain>.workers.dev`.
8. Во фронтенде прописать `const API = "https://nota-push.<subdomain>.workers.dev"`.
9. Проверка: `GET /api/health` → ok; `GET /api/vapid-public-key` → 87 символов; `GET /api/debug` → `privateKeyOk: true`.
10. На телефоне: Safari (iOS) / Chrome (Android) → открыть сайт → «На экран Домой» → открыть из иконки → 🔕 → разрешить уведомления.

## Критерии приёмки (проверь всё перед сдачей)

- [ ] Приложение открывается по HTTPS с телефона, добавляется на главный экран, работает офлайн (режим полёта).
- [ ] Заметки, задачи и списки создаются, редактируются, удаляются, отмечаются выполненными; данные переживают перезапуск.
- [ ] Напоминание приходит в указанное время при ЗАКРЫТОМ приложении (смагнутом из списка недавних).
- [ ] Два пользователя на двух устройствах не получают чужие уведомления и не видят чужие данные.
- [ ] Повторные напоминания одной задачи за день не дублируются; на следующий день приходят снова.
- [ ] `wrangler tail nota-push` показывает `Push: user=... due=... accepted=...` без ошибок.
- [ ] В коде нет ни одного npm-импорта в рантайме; воркер использует только Web Crypto API.
- [ ] Реализованы все 10 пунктов из раздела «подводные камни».

Начни с фронтенда (index.html → style.css → app.js → sw.js → manifest.json), затем tools/gen_vapid.js, затем worker.js + wrangler.toml, в конце DEPLOY.md. Выкладывай каждый файл целиком, без сокращений и плейсхолдеров вида «тут аналогично».

---

## Приложение: почему этот промпт устроен именно так

Все ограничения и «подводные камни» выше — это реальный опыт отладки приложения «Пилюлькин День»: неверный формат ключа давал «Invalid EC key», паддинг до 4096+ байт давал 413 от Apple, общий tag глушил уведомления в Chrome, общее расписание в KV заставляло пушей делиться со всеми пользователями, а проверки `isSecureContext`/`PushManager` экономят часы вопросов «почему не работает на iPhone». Новый проект с этим промптом проходит мимо всех этих граблей.
