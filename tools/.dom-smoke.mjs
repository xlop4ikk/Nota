/* Одноразовая DOM-проверка логики интерфейса (не часть проекта).
   Требует jsdom; запускается так:
     node tools/.dom-smoke.mjs
   После прогона файл удаляется. */

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const JSDOM_PATH = process.env.JSDOM_PATH || join(process.env.TEMP, "koda-smoke", "node_modules", "jsdom", "lib", "api.js");
const { JSDOM } = await import(pathToFileURL(JSDOM_PATH).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");

const html = readFileSync(join(DOCS, "index.html"), "utf8");
/* Подменяем адрес Worker'а, чтобы проверить ветку реальной синхронизации */
const appSrc = readFileSync(join(DOCS, "app.js"), "utf8").replace(
  "https://nota-push.YOUR-SUBDOMAIN.workers.dev",
  "https://nota-push.test.workers.dev"
);

const dom = new JSDOM(html, { url: "https://example.github.io/nota/", runScripts: "outside-only" });
const { window } = dom;
const { document } = window;

let passed = 0;
const failures = [];
const check = (n, c, e) => {
  if (c) { passed++; console.log("  ok   " + n); }
  else { failures.push(n + (e ? " :: " + e : "")); console.log("  FAIL " + n + (e ? " :: " + e : "")); }
};
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (id) => document.getElementById(id);
const items = () => JSON.parse(window.localStorage.getItem("nota.items.v1") || "[]");

/* ---------- моки окружения браузера ---------- */
const fetchCalls = [];
window.fetch = async (url, init) => {
  fetchCalls.push({ url: String(url), init });
  return { ok: true, status: 200, text: async () => "ok", json: async () => ({ success: true }) };
};
Object.defineProperty(window.navigator, "vibrate", { value: () => true, configurable: true });
const param = { setValueAtTime() {}, exponentialRampToValueAtTime() {} };
window.AudioContext = function () {
  return {
    state: "running", currentTime: 0, resume() {}, destination: {},
    createOscillator: () => ({ type: "", frequency: param, connect() {}, start() {}, stop() {} }),
    createGain: () => ({ gain: param, connect() {} }),
  };
};
window.confirm = () => false;
window.Element.prototype.scrollIntoView = function () {};
/* jsdom не выставляет isSecureContext — включаем, чтобы проверить ветку
   «HTTPS есть, но Service Worker недоступен» */
Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });

window.eval(appSrc);
/* Документ в jsdom ещё в loading — нативный DOMContentLoaded придёт сам.
   Диспатчить его вручную нельзя: init() отработает дважды. */
await tick(120);

/* ---------- помощники ---------- */
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const submit = () => $("itemForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const typeIn = (el, value) => { el.value = value; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const iso = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
};
const today = iso(0);
const pointer = (el, name, x) =>
  el.dispatchEvent(new window.MouseEvent(name, { bubbles: true, clientX: x, clientY: 100 }));
const tab = (name) => click(document.querySelector('.tabs__btn[data-view="' + name + '"]'));

console.log("\n1. Старт");
check("пустое состояние видно", $("emptyState").hidden === false);
check("счётчик активных = 0", $("activeCount").textContent === "0");
check("заголовок вкладки = Сегодня", $("viewTitle").textContent === "Сегодня");
check("userId создан", /^user_/.test(window.localStorage.getItem("nota.userId.v1")));

console.log("\n2. Шторка и валидация");
click($("addBtn"));
check("шторка открыта", $("sheet").hidden === false);
check("min даты = сегодня", $("fDate").getAttribute("min") === today);
submit();
check("пустое название -> ошибка", $("sheetError").hidden === false && /название/i.test($("sheetError").textContent));
check("запись не создана", items().length === 0);
$("fTitle").value = "Тест";
$("fTime").value = "10:00";
submit();
check("время без даты -> ошибка", /без даты/i.test($("sheetError").textContent), $("sheetError").textContent);
$("fTime").value = "";
$("fDate").value = iso(-1);
submit();
check("дата в прошлом -> ошибка", /прошлом/i.test($("sheetError").textContent));
$("fDate").value = today;
$("fTitle").value = "   Полить цветы   ";
$("fBody").value = "орхидеи";
submit();
check("задача создана", items().length === 1);
const first = items()[0];
check("шторка закрыта", $("sheet").hidden === true);
check("обрезка пробелов, type=task", first.title === "Полить цветы" && first.type === "task");
check("поля модели заполнены", Boolean(first.id) && first.createdAt > 0 && first.priority === "normal" && first.repeat === "none" && first.dueDate === today && first.notifiedAt === null);
check("тост показан", $("toast").hidden === false && /Добавлено/.test($("toast").textContent));

console.log("\n3. Вкладки и поиск");
tab("all");
check("view сохранён", window.localStorage.getItem("nota.view.v1") === "all");
check("вкладка подсвечена", document.querySelector('.tabs__btn[data-view="all"]').classList.contains("is-active"));
check("задача отображается", document.querySelectorAll(".item").length === 1);
typeIn($("searchInput"), "орхид");
check("поиск по описанию нашёл", document.querySelectorAll(".item").length === 1);
typeIn($("searchInput"), "абракадабра");
check("нет совпадений -> пустое состояние", document.querySelectorAll(".item").length === 0 && $("emptyState").hidden === false);
check("кнопка очистки появилась", $("searchClear").hidden === false);
click($("searchClear"));
check("очистка вернула запись", document.querySelectorAll(".item").length === 1 && $("searchClear").hidden === true);

console.log("\n4. Повтор и список");
click($("addBtn"));
$("fTitle").value = "Зарядка";
$("fDate").value = today;
$("fRepeat").value = "daily";
document.querySelector('input[name="fPriority"][value="high"]').checked = true;
submit();
click($("addBtn"));
const listRadio = document.querySelector('input[name="fType"][value="list"]');
listRadio.checked = true;
listRadio.dispatchEvent(new window.Event("change", { bubbles: true }));
check("поле состава видно для списка", $("fieldItems").hidden === false);
$("fTitle").value = "Продукты";
$("fItems").value = "Молоко\nХлеб\n\n";
submit();
check("пустые строки списка отброшены", items().find((x) => x.title === "Продукты").items.length === 2);
check("приоритет high сохранён", items().find((x) => x.title === "Зарядка").priority === "high");
tab("lists");
check("вкладка Списки содержит список", document.querySelectorAll(".item").length === 1);
check("подпункты отрисованы", document.querySelectorAll(".subitem").length === 2);
click(document.querySelector(".subitem"));
check("подпункт отмечен", items().find((x) => x.title === "Продукты").items[0].done === true);
check("прогресс списка", /1 из 2/.test(document.querySelector(".item__progress").textContent));

console.log("\n5. Выполнение и повтор");
tab("all");
const sportId = items().find((x) => x.title === "Зарядка").id;
click(document.querySelector('.item[data-id="' + sportId + '"] .check'));
const sportAfter = items().find((x) => x.title === "Зарядка");
check("repeat: срок перенесён на завтра", sportAfter.dueDate === iso(1) && sportAfter.done === false, sportAfter.dueDate);
check("repeat: notifiedAt сброшен", sportAfter.notifiedAt === null);
const flowersId = items().find((x) => x.title === "Полить цветы").id;
click(document.querySelector('.item[data-id="' + flowersId + '"] .check'));
const flowersAfter = items().find((x) => x.title === "Полить цветы");
check("задача выполнена", flowersAfter.done === true && flowersAfter.doneAt > 0);
check("счётчик = 2", $("activeCount").textContent === "2");
tab("archive");
check("архив содержит выполненную", document.querySelectorAll(".item").length === 1);
click(document.querySelector(".item .check"));
check("снятие отметки возвращает в работу", items().find((x) => x.title === "Полить цветы").done === false);

console.log("\n6. Редактирование");
tab("all");
click(document.querySelector(".item__title"));
check("открыто редактирование", $("sheet").hidden === false && $("sheetTitle").textContent === "Редактирование");
$("fTitle").value = "Полить цветы и подкормить";
$("fDate").value = iso(3);
submit();
const edited = items().find((x) => x.title === "Полить цветы и подкормить");
check("сохранено без дубликата", Boolean(edited) && items().length === 3 && edited.dueDate === iso(3));

console.log("\n7. Удаление: подтверждение и свайп");
window.confirm = () => false;
/* Свайп-слушатели навешивает MutationObserver — нужны микрозадачи */
await tick(10);
const before = items().length;
let node = document.querySelector('.item[data-id="' + edited.id + '"]');
pointer(node, "pointerdown", 300);
pointer(node, "pointermove", 140);
check("свайп добавил is-swiping", node.classList.contains("is-swiping"));
check("карточка сдвинута", /translateX\(-160px\)/.test(node.querySelector(".item__inner").style.transform), node.querySelector(".item__inner").style.transform);
pointer(node, "pointerup", 140);
check("отказ в подтверждении — запись цела", items().length === before);
window.confirm = () => true;
node = document.querySelector('.item[data-id="' + edited.id + '"]');
pointer(node, "pointerdown", 300);
pointer(node, "pointermove", 140);
pointer(node, "pointerup", 140);
check("свайп + подтверждение — удалена", items().length === before - 1);
await tick(10);
node = document.querySelector('.item[data-id="' + items().find((x) => x.title === "Продукты").id + '"]');
pointer(node, "pointerdown", 300);
pointer(node, "pointermove", 270);
pointer(node, "pointerup", 270);
check("короткий свайп не удаляет", items().length === before - 1);
node = document.querySelector(".item");
pointer(node, "pointerdown", 300);
pointer(node, "pointermove", 296);
check("вертикальный жест не свайп", !node.classList.contains("is-swiping"));

console.log("\n8. Escape, синхронизация, push-кнопка");
click($("addBtn"));
document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
check("Escape закрывает шторку", $("sheet").hidden === true);
await tick(1300);
const save = fetchCalls.find((c) => c.url.includes("/api/items/save"));
check("POST /api/items/save после debounce", Boolean(save), fetchCalls.map((c) => c.url).join(","));
if (save) {
  const payload = JSON.parse(save.init.body);
  check("payload: userId + items + tzOffsetMin", /^user_/.test(payload.userId) && Array.isArray(payload.items) && typeof payload.tzOffsetMin === "number");
  check("не чаще одного запроса на пачку правок", fetchCalls.filter((c) => c.url.includes("/api/items/save")).length <= 2);
}
click($("pushBtn"));
check("без Service Worker — подсказка про PWA", /Домой|не настроен/i.test($("toast").textContent), $("toast").textContent);
check("push-кнопка выключена", $("pushBtn").getAttribute("aria-pressed") === "false" && $("pushBtn").textContent === "🔕");
check("nota.pushEnabled.v1 не равен 1", window.localStorage.getItem("nota.pushEnabled.v1") !== "1");

console.log("\n9. Данные после перезагрузки");
const stored = items();
check("в localStorage валидный JSON", Array.isArray(stored) && stored.length === 2, "len=" + stored.length);
check("структура записи полная", ["id", "type", "title", "body", "items", "priority", "dueDate", "dueTime", "repeat", "done", "doneAt", "createdAt", "notifiedAt"].every((k) => k in stored[0]));

console.log("\n" + "=".repeat(52));
if (failures.length) console.log("ПРОВАЛЕНО " + failures.length + " из " + (passed + failures.length) + ":");
else console.log("DOM-ПРОВЕРКИ ПРОЙДЕНЫ: " + passed + " шт.");
window.close();
process.exit(failures.length ? 1 : 0);
