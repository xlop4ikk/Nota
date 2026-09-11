/* ============================================================
   Nota — клиентская логика.
   Чистый JavaScript, без сборщиков и npm-зависимостей.

   Данные живут в localStorage, сервер (Cloudflare Worker) хранит
   только копию расписания и push-подписки конкретного устройства.
   ============================================================ */

"use strict";

/* ------------------------------------------------------------
   0. Конфигурация
   ------------------------------------------------------------ */

/* Базовый адрес Cloudflare Worker.
   Замените на адрес из вывода `wrangler deploy`, например
   https://nota-push.example.workers.dev
   Пока значение не изменено, приложение работает полностью локально
   (push-кнопка объяснит, что бэкенд не настроен). */
const API = "https://nota-push.YOUR-SUBDOMAIN.workers.dev";

const STORAGE = {
  items: "nota.items.v1",
  user: "nota.userId.v1",
  push: "nota.pushEnabled.v1",
  view: "nota.view.v1",
};

const TYPES = { task: "Задача", note: "Заметка", list: "Список" };
const TYPE_ICON = { task: "✅", note: "📝", list: "📋" };
const REPEAT_LABEL = { none: "", daily: "каждый день", weekly: "каждую неделю", monthly: "каждый месяц" };
const PRIORITY_LABEL = { low: "низкий", normal: "обычный", high: "высокий" };

const VIEWS = {
  today: "Сегодня",
  all: "Все",
  lists: "Списки",
  archive: "Архив",
};

/* ------------------------------------------------------------
   1. Утилиты
   ------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[ch]));
}

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw;
  } catch (err) {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch (err) {
    /* приватный режим Safari — работаем без сохранения настроек */
  }
}

/* Устойчивый ID устройства. Создаётся один раз и НЕ удаляется вместе
   с заметками — иначе потерялись бы push-подписки на сервере. */
function getUserId() {
  let id = read(STORAGE.user, "");
  if (!id) {
    id = "user_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    write(STORAGE.user, id);
  }
  return id;
}

/* Смещение локального часа в минутах (как getTimezoneOffset):
   для UTC+3 будет -180. Worker использует его для расчёта
   «локального времени пользователя». */
function tzOffsetMin() {
  return new Date().getTimezoneOffset();
}

/* Локальная дата в формате YYYY-MM-DD */
function localDate(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function todayStr() {
  return localDate();
}

/* Прибавить период к дате YYYY-MM-DD, не выходя за границы месяцев */
function addPeriod(dateStr, repeat) {
  const parts = String(dateStr).split("-").map(Number);
  const d = new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  if (Number.isNaN(d.getTime())) return dateStr;
  if (repeat === "daily") d.setDate(d.getDate() + 1);
  if (repeat === "weekly") d.setDate(d.getDate() + 7);
  if (repeat === "monthly") {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  }
  return localDate(d);
}

function humanDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-").map(Number);
  const d = new Date(parts[0], parts[1] - 1, parts[2]);
  if (Number.isNaN(d.getTime())) return dateStr;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d - today) / 86400000);
  if (diff === 0) return "сегодня";
  if (diff === 1) return "завтра";
  if (diff === -1) return "вчера";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(d);
}

/* ------------------------------------------------------------
   2. Модель данных и хранилище
   ------------------------------------------------------------ */

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.title !== "string") return null;
  const type = ["task", "note", "list"].indexOf(raw.type) >= 0 ? raw.type : "task";
  const items = Array.isArray(raw.items)
    ? raw.items
        .filter((it) => it && typeof it.text === "string" && it.text.trim())
        .map((it) => ({ text: it.text.trim().slice(0, 200), done: Boolean(it.done) }))
    : [];
  const dueDate = typeof raw.dueDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueDate) ? raw.dueDate : null;
  const dueTime = dueDate && typeof raw.dueTime === "string" && /^\d{2}:\d{2}$/.test(raw.dueTime) ? raw.dueTime : null;
  return {
    id: String(raw.id || uid()),
    type: type,
    title: raw.title.trim().slice(0, 80),
    body: typeof raw.body === "string" ? raw.body.slice(0, 4000) : "",
    items: type === "list" ? items : [],
    priority: ["low", "normal", "high"].indexOf(raw.priority) >= 0 ? raw.priority : "normal",
    dueDate: dueDate,
    dueTime: dueTime,
    repeat: ["none", "daily", "weekly", "monthly"].indexOf(raw.repeat) >= 0 ? raw.repeat : "none",
    done: Boolean(raw.done),
    doneAt: typeof raw.doneAt === "number" ? raw.doneAt : null,
    createdAt: typeof raw.createdAt === "number" ? raw.createdAt : Date.now(),
    notifiedAt: typeof raw.notifiedAt === "number" ? raw.notifiedAt : null,
  };
}

let items = [];

function loadItems() {
  try {
    const parsed = JSON.parse(read(STORAGE.items, "[]"));
    items = (Array.isArray(parsed) ? parsed : []).map(normalizeItem).filter(Boolean);
  } catch (err) {
    items = [];
  }
}

function saveItems() {
  try {
    localStorage.setItem(STORAGE.items, JSON.stringify(items));
  } catch (err) {
    toast("Не удалось сохранить: хранилище переполнено");
  }
}

/* ------------------------------------------------------------
   3. Синхронизация с сервером (debounce 1 секунда)
   ------------------------------------------------------------ */

let syncTimer = null;

function scheduleSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToServer, 1000);
}

function syncToServer() {
  if (!apiConfigured()) return Promise.resolve(false);
  return fetch(API + "/api/items/save", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: getUserId(),
      items: items,
      tzOffsetMin: tzOffsetMin(),
    }),
  })
    .then((res) => res.ok)
    .catch(() => false);
}

function apiConfigured() {
  return API.indexOf("YOUR-SUBDOMAIN") === -1 && /^https:\/\//.test(API);
}

/* ------------------------------------------------------------
   4. Звук и вибрация
   ------------------------------------------------------------ */

let audioCtx = null;

function playDing() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1470, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.36);
  } catch (err) {
    /* звук не критичен */
  }
}

function buzz(pattern) {
  try {
    if (navigator.vibrate) navigator.vibrate(pattern || 15);
  } catch (err) {
    /* не поддерживается */
  }
}

/* ------------------------------------------------------------
   5. Тосты (вместо alert)
   ------------------------------------------------------------ */

let toastTimer = null;

function toast(text, ms) {
  const el = $("toast");
  clearTimeout(toastTimer);
  el.textContent = text;
  el.hidden = false;
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms || 3200);
}

/* ------------------------------------------------------------
   6. Состояние интерфейса
   ------------------------------------------------------------ */

let currentView = read(STORAGE.view, "today");
if (!VIEWS[currentView]) currentView = "today";
let query = "";

function visibleItems() {
  const today = todayStr();
  const q = query.trim().toLowerCase();
  let list = items.slice();

  if (currentView === "today") {
    list = list.filter((it) => !it.done && it.dueDate && it.dueDate <= today);
  } else if (currentView === "all") {
    list = list.filter((it) => !it.done);
  } else if (currentView === "lists") {
    list = list.filter((it) => it.type === "list" && !it.done);
  } else if (currentView === "archive") {
    list = list.filter((it) => it.done);
  }

  if (q) {
    list = list.filter((it) => {
      const inItems = (it.items || []).some((sub) => sub.text.toLowerCase().indexOf(q) >= 0);
      return (
        it.title.toLowerCase().indexOf(q) >= 0 ||
        it.body.toLowerCase().indexOf(q) >= 0 ||
        inItems
      );
    });
  }

  list.sort((a, b) => {
    if (currentView === "archive") return (b.doneAt || 0) - (a.doneAt || 0);
    const aKey = a.dueDate ? a.dueDate + (a.dueTime || " ") : "9999-99-99";
    const bKey = b.dueDate ? b.dueDate + (b.dueTime || " ") : "9999-99-99";
    if (aKey !== bKey) return aKey < bKey ? -1 : 1;
    return b.createdAt - a.createdAt;
  });

  return list;
}

/* ------------------------------------------------------------
   7. Отрисовка
   ------------------------------------------------------------ */

const CHECK_SVG =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function itemHtml(item) {
  const meta = [];

  if (item.dueDate) {
    const overdue = !item.done && item.dueDate < todayStr();
    const when = humanDate(item.dueDate) + (item.dueTime ? ", " + item.dueTime : "");
    meta.push('<span class="tag' + (overdue ? ' tag--due' : '') + '">🗓 ' + escapeHtml(when) + (overdue ? " · просрочено" : "") + "</span>");
  }
  if (item.repeat !== "none") {
    meta.push('<span class="tag">🔁 ' + REPEAT_LABEL[item.repeat] + "</span>");
  }
  if (item.priority !== "normal") {
    meta.push(
      '<span class="tag"><span class="dot dot--' + item.priority + '"></span>' +
        PRIORITY_LABEL[item.priority] + "</span>"
    );
  }
  if (item.type === "list" && item.items.length) {
    const doneCount = item.items.filter((s) => s.done).length;
    meta.push('<span class="item__progress">' + doneCount + " из " + item.items.length + "</span>");
  }
  if (item.done && item.doneAt) {
    meta.push('<span class="tag tag--done">выполнено ' + new Date(item.doneAt).toLocaleDateString("ru-RU") + "</span>");
  }

  let sub = "";
  if (item.type === "list" && item.items.length) {
    sub =
      '<ul class="item__sub">' +
      item.items
        .map(
          (it, i) =>
            '<li class="subitem' + (it.done ? " is-on" : "") + '" data-index="' + i + '">' +
            '<span class="subitem__box">' + CHECK_SVG + "</span>" +
            '<span class="subitem__text">' + escapeHtml(it.text) + "</span></li>"
        )
        .join("") +
      "</ul>";
  }

  return (
    '<li class="item' + (item.done ? " item--done" : "") + '" data-id="' + item.id + '">' +
    '<div class="item__danger"><span>Удалить</span> 🗑</div>' +
    '<div class="item__inner">' +
    '<button type="button" class="check" aria-pressed="' + item.done + '" aria-label="Отметить выполнение">' +
    '<span class="check__box' + (item.done ? " is-on" : "") + '">' + CHECK_SVG + "</span></button>" +
    '<div class="item__body">' +
    '<p class="item__title"><span class="item__badge">' + TYPE_ICON[item.type] + "</span>" + escapeHtml(item.title) + "</p>" +
    (item.body ? '<p class="item__desc">' + escapeHtml(item.body) + "</p>" : "") +
    sub +
    (meta.length ? '<div class="item__meta">' + meta.join("") + "</div>" : "") +
    "</div></div></li>"
  );
}

function emptyStateText() {
  if (query.trim()) return { icon: "🔍", title: "Ничего не найдено", text: "Измените запрос или очистите поиск." };
  if (currentView === "today") return { icon: "☀️", title: "На сегодня пусто", text: "Задач на сегодня нет. Добавьте новую или перенесите срок." };
  if (currentView === "all") return { icon: "🗒️", title: "Список пуст", text: "Нажмите «+», чтобы создать первую задачу." };
  if (currentView === "lists") return { icon: "📋", title: "Списков пока нет", text: "Создайте запись типа «Список» — например, список покупок." };
  return { icon: "📦", title: "Архив пуст", text: "Здесь появятся выполненные задачи." };
}

function render() {
  const list = visibleItems();
  const html = list.map(itemHtml).join("");
  $("itemsList").innerHTML = html;
  $("emptyState").hidden = list.length > 0;
  if (!list.length) {
    const e = emptyStateText();
    $("emptyIcon").textContent = e.icon;
    $("emptyTitle").textContent = e.title;
    $("emptyText").textContent = e.text;
  }
  $("viewTitle").textContent = VIEWS[currentView];
  $("activeCount").textContent = String(items.filter((it) => !it.done).length);

  document.querySelectorAll(".tabs__btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === currentView);
  });
}

/* ------------------------------------------------------------
   8. Шторка: создание и редактирование
   ------------------------------------------------------------ */

let editingId = null;

function sheetOpen() {
  return !$("sheet").hidden;
}

function openSheet(item) {
  editingId = item ? item.id : null;
  $("sheetTitle").textContent = item ? "Редактирование" : "Новая запись";
  $("sheetError").hidden = true;

  const type = item ? item.type : "task";
  document.querySelectorAll('input[name="fType"]').forEach((r) => {
    r.checked = r.value === type;
  });
  const priority = item ? item.priority : "normal";
  document.querySelectorAll('input[name="fPriority"]').forEach((r) => {
    r.checked = r.value === priority;
  });

  $("fTitle").value = item ? item.title : "";
  $("fBody").value = item ? item.body : "";
  $("fItems").value = item && item.items ? item.items.map((s) => s.text).join("\n") : "";
  $("fDate").value = item && item.dueDate ? item.dueDate : "";
  $("fTime").value = item && item.dueTime ? item.dueTime : "";
  $("fRepeat").value = item ? item.repeat : "none";
  if (!item) $("fDate").min = todayStr();
  else $("fDate").removeAttribute("min");

  syncTypeFields();
  $("sheet").hidden = false;
  document.body.style.overflow = "hidden";
  setTimeout(() => $("fTitle").focus(), 120);
}

function closeSheet() {
  $("sheet").hidden = true;
  editingId = null;
  document.body.style.overflow = "";
}

function sheetType() {
  const checked = document.querySelector('input[name="fType"]:checked');
  return checked ? checked.value : "task";
}

function syncTypeFields() {
  const type = sheetType();
  $("fieldItems").hidden = type !== "list";
  $("fieldBody").hidden = false;
}

function sheetError(text) {
  const el = $("sheetError");
  el.textContent = text;
  el.hidden = false;
}

function submitSheet(event) {
  event.preventDefault();
  $("sheetError").hidden = true;

  const title = $("fTitle").value.trim();
  const dueDate = $("fDate").value || null;
  const dueTime = $("fTime").value || null;
  const type = sheetType();

  /* Валидация по требованиям задания */
  if (!title) {
    sheetError("Укажите название — это обязательное поле.");
    $("fTitle").focus();
    buzz(120);
    return;
  }
  if (dueTime && !dueDate) {
    sheetError("Указано время без даты. Выберите дату напоминания.");
    $("fDate").focus();
    buzz(120);
    return;
  }
  if (!editingId && dueDate && dueDate < todayStr()) {
    sheetError("Дата не может быть в прошлом. Выберите сегодняшний или будущий день.");
    $("fDate").focus();
    buzz(120);
    return;
  }

  const subTexts = $("fItems").value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const existing = editingId ? items.find((it) => it.id === editingId) : null;

  if (existing) {
    /* Если срок передвинули — напоминание снова актуально */
    const dateChanged = dueDate !== existing.dueDate || dueTime !== existing.dueTime;
    existing.type = type;
    existing.title = title.slice(0, 80);
    existing.body = $("fBody").value.trim().slice(0, 4000);
    existing.priority = (document.querySelector('input[name="fPriority"]:checked') || {}).value || "normal";
    existing.dueDate = dueDate;
    existing.dueTime = dueTime;
    existing.repeat = $("fRepeat").value;
    if (dateChanged) existing.notifiedAt = null;
    if (type === "list") {
      const old = existing.items;
      existing.items = subTexts.map((text, i) => ({
        text: text.slice(0, 200),
        done: old[i] && old[i].text === text ? old[i].done : false,
      }));
    } else {
      existing.items = [];
    }
    toast("Изменения сохранены");
  } else {
    items.push(
      normalizeItem({
        id: uid(),
        type: type,
        title: title,
        body: $("fBody").value.trim(),
        items: type === "list" ? subTexts.map((text) => ({ text: text, done: false })) : [],
        priority: (document.querySelector('input[name="fPriority"]:checked') || {}).value || "normal",
        dueDate: dueDate,
        dueTime: dueTime,
        repeat: $("fRepeat").value,
        done: false,
        createdAt: Date.now(),
      })
    );
    toast("Добавлено");
  }

  saveItems();
  scheduleSync();
  render();
  closeSheet();
  buzz(12);
}

/* ------------------------------------------------------------
   9. Выполнение, повтор, удаление
   ------------------------------------------------------------ */

function findItem(id) {
  return items.find((it) => it.id === id);
}

function toggleDone(id) {
  const item = findItem(id);
  if (!item) return;

  item.done = !item.done;
  item.doneAt = item.done ? Date.now() : null;

  /* Повторяющаяся задача «переезжает» на следующий срок вместо архива:
     источник правды — клиент, сервер только шлёт пуш по расписанию. */
  if (item.done && item.repeat !== "none" && item.dueDate) {
    const next = addPeriod(item.dueDate, item.repeat);
    item.dueDate = next;
    item.done = false;
    item.notifiedAt = null;
    toast("Выполнено. Следующий раз: " + humanDate(next));
  } else if (item.done) {
    toast("Выполнено 🎉");
  } else {
    toast("Снова в работе");
  }

  saveItems();
  scheduleSync();
  render();

  const node = document.querySelector('.item[data-id="' + item.id + '"]');
  if (node && item.doneAt) {
    node.classList.add("is-checked");
    setTimeout(() => node.classList.remove("is-checked"), 400);
  }
  buzz([12, 40, 18]);
  playDing();
}

function toggleListItem(id, index) {
  const item = findItem(id);
  if (!item || !item.items || !item.items[index]) return;
  item.items[index].done = !item.items[index].done;
  saveItems();
  scheduleSync();
  render();
  buzz(10);
  playDing();
}

function removeItem(id) {
  const item = findItem(id);
  if (!item) return;
  /* Подтверждение удаления — по требованию задания */
  if (!window.confirm('Удалить «' + item.title + "»? Действие необратимо.")) return;
  items = items.filter((it) => it.id !== id);
  saveItems();
  scheduleSync();
  render();
  toast("Удалено");
  buzz([25, 30, 25]);
}

/* ------------------------------------------------------------
   10. Свайп для удаления
   ------------------------------------------------------------ */

const SWIPE_THRESHOLD = 90;
let swipeState = null;

function bindSwipe(node) {
  node.addEventListener("pointerdown", (event) => {
    if (event.target.closest(".check") || event.target.closest(".subitem")) return;
    const inner = node.querySelector(".item__inner");
    swipeState = {
      node: node,
      inner: inner,
      id: node.dataset.id,
      startX: event.clientX,
      startY: event.clientY,
      dx: 0,
      active: false,
      decided: false,
      pointerId: event.pointerId,
    };
  });

  node.addEventListener("pointermove", (event) => {
    if (!swipeState || swipeState.node !== node || swipeState.pointerId !== event.pointerId) return;
    const dxTotal = event.clientX - swipeState.startX;
    const dyTotal = event.clientY - swipeState.startY;

    if (!swipeState.decided) {
      if (Math.abs(dyTotal) > 12 && Math.abs(dyTotal) > Math.abs(dxTotal)) {
        swipeState = null; /* это прокрутка */
        return;
      }
      if (Math.abs(dxTotal) > 10) {
        swipeState.decided = true;
        swipeState.active = true;
        node.classList.add("is-swiping");
      }
    }
    if (!swipeState || !swipeState.active) return;

    /* Разрешаем только свайп влево */
    swipeState.dx = Math.min(0, dxTotal);
    swipeState.inner.style.transform = "translateX(" + swipeState.dx + "px)";
    event.preventDefault();
  });

  const finish = (event) => {
    if (!swipeState || swipeState.node !== node) return;
    const state = swipeState;
    swipeState = null;
    if (!state.active) return;
    node.classList.remove("is-swiping");
    if (state.dx < -SWIPE_THRESHOLD) {
      state.inner.style.transform = "translateX(0)";
      removeItem(state.id);
    } else {
      state.inner.style.transform = "translateX(0)";
    }
  };

  node.addEventListener("pointerup", finish);
  node.addEventListener("pointercancel", finish);
}

/* ------------------------------------------------------------
   11. Push-уведомления
   ------------------------------------------------------------ */

function urlBase64ToUint8Array(base64String) {
  const padded = base64String + "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (padded + "==").replace(/_/g, "/").replace(/-/g, "+");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/* Публичный VAPID-ключ приходит с Worker'а. Если вместо ключа вернулся
   JSON с ошибкой, подписка упадёт с невнятной ошибкой atob — проверяем
   формат заранее (87 символов base64url). */
function isValidVapidKey(key) {
  return typeof key === "string" && /^[A-Za-z0-9_-]{87}$/.test(key);
}

function pushSupported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getSubscription() {
  if (!("serviceWorker" in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) || null;
}

async function refreshPushButton() {
  const btn = $("pushBtn");
  const enabled = read(STORAGE.push, "0") === "1";
  let hasSubscription = false;
  try {
    hasSubscription = Boolean(await getSubscription());
  } catch (err) {
    hasSubscription = false;
  }
  const on = enabled && hasSubscription && (!("Notification" in window) || Notification.permission === "granted");
  btn.textContent = on ? "🔔" : "🔕";
  btn.setAttribute("aria-pressed", on ? "true" : "false");
  btn.title = on ? "Напоминания включены — нажмите, чтобы выключить" : "Включить напоминания";
  btn.classList.toggle("is-muted", !pushSupported());
}

async function enablePush() {
  if (!apiConfigured()) {
    toast("Бэкенд не настроен: впишите адрес Worker в const API в app.js");
    return;
  }
  if (!window.isSecureContext) {
    toast("Нужен HTTPS: откройте сайт по адресу https://…");
    return;
  }
  if (!pushSupported()) {
    toast(
      "На iPhone пуши работают только в PWA: Safari → Поделиться → «На экран Домой», затем открыть из иконки (iOS 16.4+)"
    );
    return;
  }

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch (err) {
      permission = "denied";
    }
  }
  if (permission !== "granted") {
    toast("Разрешение на уведомления не выдано");
    return;
  }

  let keyText;
  try {
    const res = await fetch(API + "/api/vapid-public-key");
    keyText = (await res.text()).trim();
  } catch (err) {
    toast("Сервер недоступен");
    return;
  }
  if (!isValidVapidKey(keyText)) {
    toast("Worker вернул некорректный VAPID-ключ");
    return;
  }

  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyText),
      });
    }
    const res = await fetch(API + "/api/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        userId: getUserId(),
        subscription: sub.toJSON(),
        tzOffsetMin: tzOffsetMin(),
      }),
    });
    if (!res.ok) throw new Error("subscribe " + res.status);
    write(STORAGE.push, "1");
    await syncToServer();
    await refreshPushButton();
    toast("Напоминания включены 🔔");
    buzz([10, 30, 10]);
  } catch (err) {
    console.error(err);
    toast("Не удалось подписаться: " + err.message);
  }
}

async function disablePush() {
  try {
    const sub = await getSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await fetch(API + "/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: getUserId(), endpoint: endpoint }),
      });
    }
  } catch (err) {
    console.error(err);
  }
  write(STORAGE.push, "0");
  await refreshPushButton();
  toast("Напоминания выключены 🔕");
}

/* ------------------------------------------------------------
   12. Обработчики событий
   ------------------------------------------------------------ */

function bindEvents() {
  /* Вкладки */
  document.querySelectorAll(".tabs__btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      currentView = btn.dataset.view;
      write(STORAGE.view, currentView);
      render();
    });
  });

  /* Поиск */
  $("searchInput").addEventListener("input", (event) => {
    query = event.target.value;
    $("searchClear").hidden = !query;
    render();
  });
  $("searchClear").addEventListener("click", () => {
    query = "";
    $("searchInput").value = "";
    $("searchClear").hidden = true;
    render();
  });

  /* Создание */
  $("addBtn").addEventListener("click", () => openSheet(null));

  /* Шторка */
  $("itemForm").addEventListener("submit", submitSheet);
  $("sheetCancel").addEventListener("click", closeSheet);
  $("sheetOverlay").addEventListener("click", closeSheet);
  document.querySelectorAll('input[name="fType"]').forEach((radio) => {
    radio.addEventListener("change", syncTypeFields);
  });

  /* Список: один обработчик на контейнер + привязка свайпов */
  $("itemsList").addEventListener("click", (event) => {
    const node = event.target.closest(".item");
    if (!node) return;
    const id = node.dataset.id;

    const check = event.target.closest(".check");
    if (check) {
      toggleDone(id);
      return;
    }
    const sub = event.target.closest(".subitem");
    if (sub) {
      toggleListItem(id, Number(sub.dataset.index));
      return;
    }
    /* Свайп уже обработан, тап по карточке — редактирование */
    if (Math.abs(node.querySelector(".item__inner").getBoundingClientRect().left - node.getBoundingClientRect().left) > 2) return;
    openSheet(findItem(id));
  });

  /* Push-кнопка */
  $("pushBtn").addEventListener("click", () => {
    const enabled = read(STORAGE.push, "0") === "1";
    if (enabled) disablePush();
    else enablePush();
  });

  /* Свайпы: перепривязываем после каждой отрисовки */
  const observer = new MutationObserver(() => {
    document.querySelectorAll(".item").forEach((node) => {
      if (node.dataset.swipeBound) return;
      node.dataset.swipeBound = "1";
      bindSwipe(node);
    });
  });
  observer.observe($("itemsList"), { childList: true });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && sheetOpen()) closeSheet();
  });
}

/* Перейти к задаче и подсветить её (используется при клике по пушу) */
function openTaskById(id) {
  const item = findItem(id);
  if (!item) return false;
  query = "";
  const search = $("searchInput");
  if (search) search.value = "";
  $("searchClear").hidden = true;

  if (item.done) currentView = "archive";
  else if (item.type === "list") currentView = "lists";
  else currentView = "all";
  write(STORAGE.view, currentView);
  render();

  const node = document.querySelector('.item[data-id="' + id + '"]');
  if (node) {
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("is-flash");
  }
  return true;
}

/* пуш открывает приложение с адресом вида ./?id=<itemId> */
function highlightFromUrl() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return;
  if (openTaskById(id)) history.replaceState(null, "", location.pathname);
}

/* Клик по уведомлению, когда приложение уже открыто:
   Service Worker присылает сообщение вместо перезагрузки страницы */
function listenServiceWorkerMessages() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type !== "nota:open" || !data.url) return;
    try {
      const url = new URL(data.url, location.href);
      const id = url.searchParams.get("id");
      if (id) openTaskById(id);
    } catch (err) {
      /* некорректный адрес — просто игнорируем */
    }
  });
}

/* ------------------------------------------------------------
   13. Старт
   ------------------------------------------------------------ */

async function init() {
  loadItems();
  getUserId();
  render();
  bindEvents();
  listenServiceWorkerMessages();
  highlightFromUrl();
  refreshPushButton();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    try {
      await navigator.serviceWorker.register("sw.js");
    } catch (err) {
      console.warn("Service Worker не зарегистрирован:", err);
    }
  }

  /* Если включено раньше — обновляем расписание на сервере */
  if (read(STORAGE.push, "0") === "1") syncToServer();

  /* Ярлык «Новая задача» из манифеста: ./?new=task */
  if (new URLSearchParams(location.search).get("new") === "task") {
    openSheet(null);
    history.replaceState(null, "", location.pathname);
  }
}

document.addEventListener("DOMContentLoaded", init);
