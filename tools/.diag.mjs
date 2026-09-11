/* Диагностика: сколько слушателей навешано и сколько раз зовётся обработчик */
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const JSDOM_PATH = join(process.env.TEMP, "koda-smoke", "node_modules", "jsdom", "lib", "api.js");
const { JSDOM } = await import(pathToFileURL(JSDOM_PATH).href);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs");
const html = readFileSync(join(DOCS, "index.html"), "utf8");
const appSrc = readFileSync(join(DOCS, "app.js"), "utf8");

const dom = new JSDOM(html, { url: "https://example.github.io/nota/", runScripts: "outside-only" });
const { window } = dom;
const { document } = window;

const counts = new Map();
const origAdd = window.EventTarget.prototype.addEventListener;
window.EventTarget.prototype.addEventListener = function (type, fn, opts) {
  const target = this.id ? "#" + this.id : this.tagName + "." + (this.className || "");
  const key = target + " " + type;
  counts.set(key, (counts.get(key) || 0) + 1);
  return origAdd.call(this, type, fn, opts);
};

window.fetch = async () => ({ ok: true, status: 200, text: async () => "ok" });
Object.defineProperty(window.navigator, "vibrate", { value: () => true, configurable: true });
window.confirm = () => false;

window.eval(appSrc);
console.log("DOMContentLoaded был ранее? readyState =", document.readyState);
document.dispatchEvent(new window.Event("DOMContentLoaded"));
await new Promise((r) => setTimeout(r, 60));

console.log("\nСлушатели, навешанные при старте:");
for (const [key, n] of counts) console.log("  " + key + " -> " + n);

/* одна задача и один клик по чекбоксу */
const $ = (id) => document.getElementById(id);
$("addBtn").dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
$("fTitle").value = "Диагноз";
$("itemForm").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const stored = () => JSON.parse(window.localStorage.getItem("nota.items.v1") || "[]");
console.log("\nсоздано:", stored().length, "done:", stored()[0] && stored()[0].done);

const checkBtn = document.querySelector(".item .check");
checkBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
console.log("после 1 клика done:", stored()[0].done, "doneAt:", stored()[0].doneAt);

console.log("\nСлушатели после рендера:");
for (const [key, n] of counts) console.log("  " + key + " -> " + n);

window.close();
process.exit(0);
