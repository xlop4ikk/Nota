# Деплой Nota

Полная цепочка: GitHub Pages (фронтенд) + Cloudflare Worker с KV (push-напоминания).
Все сервисы — на бесплатных тарифах, npm-зависимостей в проекте нет.

```
nota/
├── docs/       → публикуется на GitHub Pages (источник — папка /docs)
├── worker/     → Cloudflare Worker (API + cron + push)
└── tools/      → генератор VAPID-ключей
```

---

## 1. VAPID-ключи

```bash
node tools/gen_vapid.js
```

Скрипт напечатает два значения:

| Что | Куда кладём |
|---|---|
| `VAPID_PUBLIC_KEY` (87 символов) | в `[vars]` файла `worker/wrangler.toml` |
| `VAPID_PRIVATE_KEY` (43 символа) | только в секрет Cloudflare (шаг 6) |

Приватный ключ — это `d`-скаляр P-256 в base64url. **Не** JWK-JSON и **не** PEM:
Worker импортирует именно скаляр, другие форматы дают ошибку
`Invalid EC key in JSON Web Key`.

---

## 2. GitHub Pages

1. Создайте репозиторий `nota` и загрузите в него файлы (`main`).
2. **Settings → Pages → Source: Deploy from a branch → `main` / `/docs`**.
3. Сайт станет доступен по адресу `https://<login>.github.io/nota/`.

`.nojekyll` в `docs/` уже лежит — он отключает обработку Jekyll (иначе
подчёркнутые имена файлов и папки с точкой ломаются).

Проверьте, что открывается `https://<login>.github.io/nota/manifest.json`.

---

## 3. Wrangler

```bash
npm i -g wrangler
wrangler login      # откроется браузер с запросом разрешения
```

---

## 4. KV-хранилище

```bash
cd worker
wrangler kv namespace create NOTA
```

В выводе будет строка вида `id = "1a2b3c..."` — скопируйте её в
`worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "KV_NAMESPACE"
id = "1a2b3c..."
```

---

## 5. Переменные в wrangler.toml

```toml
[vars]
VAPID_SUBJECT = "mailto:you@example.com"
SITE_URL = "https://<login>.github.io/nota/"
VAPID_PUBLIC_KEY = "<87 символов из шага 1>"
```

`SITE_URL` — адрес из шага 2. Завершающий слэш можно оставить: Worker
срезает его сам, двойной `//` в ссылках не появится.

---

## 6. Секрет с приватным ключом

```bash
cd worker
wrangler secret put VAPID_PRIVATE_KEY
# вставить 43-символьное значение и нажать Enter
```

В `[vars]` приватный ключ класть нельзя — он уедет в публичный бандл.

---

## 7. Деплой Worker'а

```bash
cd worker
wrangler deploy
```

Вывод даст адрес: `https://nota-push.<subdomain>.workers.dev`.

---

## 8. Прописать адрес Worker'а во фронтенде

Откройте `docs/app.js`, строка около 20:

```js
const API = "https://nota-push.<subdomain>.workers.dev";
```

После правки **поднимите версию кэша** в `docs/sw.js`:

```js
const VERSION = "nota-v2";   // было nota-v1
```

Иначе старые клиенты останутся на закешированной версии `app.js`.
Затем коммит и push в `main`.

---

## 9. Проверка бэкенда

| Запрос | Ожидаемый ответ |
|---|---|
| `GET /api/health` | `{"ok":true,"time":"..."}` |
| `GET /api/vapid-public-key` | 87 символов, одна строка, без кавычек |
| `GET /api/debug` | `"vapidConfigured": true, "privateKeyOk": true` |

```bash
curl https://nota-push.<subdomain>.workers.dev/api/health
curl https://nota-push.<subdomain>.workers.dev/api/vapid-public-key
curl https://nota-push.<subdomain>.workers.dev/api/debug
```

Если `privateKeyOk: false` — ключ в секрете битый (лишние пробелы, PEM или
JWK вместо скаляра). Выполните шаг 6 заново.

---

## 10. Включение push на устройстве

**Android / Chrome:** открыть сайт → меню → «Установить приложение» →
открыть из иконки → нажать 🔔 в шапке → «Разрешить».

**iOS:** Safari → Поделиться → «На экран Домой» → **открыть именно с
иконки** → нажать 🔔 → «Разрешить».

Требования iOS: версия 16.4+, приложение открыто из PWA-иконки. В обычной
вкладке Safari `PushManager` отсутствует — это ограничение Apple, а не баг.
После установки иногда нужна перезагрузка телефона, чтобы push-канал
активировался.

Дальше: создайте задачу с датой на ближайшую минуту — придёт уведомление
«Nota · Пора: <название>».

---

## Отладка

```bash
wrangler tail nota-push
```

Штатная строка: `Push: user=user_xxx due=mtf8k2x7 accepted=201`.

| Симптом | Причина и решение |
|---|---|
| `accepted=404` или `410` | подписка протухла, Worker удаляет её сам — нужно включить 🔔 заново |
| `accepted=413` | тело > 4096 байт; в Worker есть укорочение текста, проверьте длину `SITE_URL` и заголовки |
| `accepted=403` | `VAPID_SUBJECT` некорректен (нужен реальный `mailto:` или `https:` URL) |
| `privateKeyOk: false` | неверный формат секрета, см. шаг 6 |
| пушей нет, в логах пусто | у подписки нет `userId`: отключите и снова включите 🔔; либоcron не настроен — проверьте `[triggers]` и `wrangler deployments view` |
| уведомление приходит, но без звука | одинаковый `tag` — в `sw.js` он уникален (`nota-<timestamp>`), не меняйте |
| приложение не обновилось | не поднят `VERSION` в `sw.js` |
| «браузер не поддерживает push» на GitHub Pages | HTTPS там есть; причина в контексте — обычная вкладка вместо PWA или встроенный браузер соцсети |

Проверить расписание пользователя в KV:

```bash
wrangler kv key get "user:<userId>" --binding KV_NAMESPACE --remote
```

---

## Ключи KV — что где лежит

| Ключ | Значение |
|---|---|
| `subscriptions` | `{ subscriptions: [{ subscription, userId, tzOffsetMin, addedAt }] }` |
| `user:<userId>` | `{ items, tzOffsetMin, notifiedToday: { "<itemId>:<YYYY-MM-DD>": ts } }` |
| `ep:<endpoint>` | строка `userId` — привязка подписки к владельцу |

`notifiedToday` очищается каждый день при обходе cron: остаются только
ключи текущей даты. Поэтому повторный пуш одной задачи в тот же день не
дублируется, а на следующий день напоминание снова придёт.

---

## Как проверить изоляцию пользователей

1. На двух устройствах откройте сайт, включите 🔔 — в KV появятся две
   подписки с разными `userId`.
2. На устройстве А создайте задачу на ближайшую минуту.
3. Пуш придёт только устройству А. В `wrangler tail` одна строка
   `Push: user=<A> ...`.
4. На устройстве Б задача не появится: `user:<B>` содержит только
   собственные `items`.
