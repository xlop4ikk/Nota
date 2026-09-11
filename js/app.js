// Nota app: state, rendering and event wiring.

import { loadTasks, saveTasks, createTask } from "./store.js";
import { t, getLang, setLang, applyI18n, formatDue } from "./i18n.js";
import {
  registerServiceWorker,
  notificationSupported,
  permissionState,
  requestPermission,
  startReminderLoop,
  setBadge,
} from "./notify.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  list: $("#taskList"),
  empty: $("#emptyState"),
  emptyTitle: $("#emptyTitle"),
  emptyText: $("#emptyText"),
  addForm: $("#addForm"),
  titleInput: $("#titleInput"),
  toggleDetails: $("#toggleDetails"),
  addDetails: $("#addDetails"),
  addDue: $("#addDue"),
  addReminder: $("#addReminder"),
  searchInput: $("#searchInput"),
  statTotal: $("#statTotal"),
  statActive: $("#statActive"),
  statDone: $("#statDone"),
  bellBtn: $("#bellBtn"),
  installBtn: $("#installBtn"),
  editDialog: $("#editDialog"),
  editForm: $("#editForm"),
  editTitle: $("#editTitle"),
  editDue: $("#editDue"),
  editReminder: $("#editReminder"),
  clearDue: $("#clearDue"),
  editDelete: $("#editDelete"),
  editCancel: $("#editCancel"),
  toast: $("#toast"),
  toastText: $("#toastText"),
  toastAction: $("#toastAction"),
};

const state = {
  tasks: loadTasks(),
  filter: "all",
  query: "",
  editingId: null,
  lastDeleted: null,
};

/* ---------- helpers ---------- */

function persist() {
  saveTasks(state.tasks);
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Convert value of <input type="datetime-local"> (local time) to ISO string.
function localInputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Convert ISO string to <input type="datetime-local"> value in local time.
function isoToLocalInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function visibleTasks() {
  const q = state.query.trim().toLowerCase();
  let list = state.tasks;
  if (state.filter === "active") list = list.filter((task) => !task.done);
  if (state.filter === "done") list = list.filter((task) => task.done);
  if (q) list = list.filter((task) => task.title.toLowerCase().includes(q));
  const byRecency = (a, b) => b.createdAt - a.createdAt;
  return [...list].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const aDue = a.due && !a.done ? new Date(a.due).getTime() : null;
    const bDue = b.due && !b.done ? new Date(b.due).getTime() : null;
    if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;
    if ((aDue !== null) !== (bDue !== null)) return aDue !== null ? -1 : 1;
    return byRecency(a, b);
  });
}

/* ---------- toast ---------- */

let toastTimer = null;

function showToast(text, { actionText = null, onAction = null, duration = 4000 } = {}) {
  clearTimeout(toastTimer);
  els.toastText.textContent = text;
  if (actionText) {
    els.toastAction.hidden = false;
    els.toastAction.textContent = actionText;
    els.toastAction.onclick = () => {
      onAction && onAction();
      hideToast();
    };
  } else {
    els.toastAction.hidden = true;
  }
  els.toast.hidden = false;
  toastTimer = setTimeout(hideToast, duration);
}

function hideToast() {
  clearTimeout(toastTimer);
  els.toast.hidden = true;
}

/* ---------- rendering ---------- */

const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8"/><path d="M12 7.5V12l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_EDIT = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 20h4L20 8l-4-4L4 16v4z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none"><path d="M4 7h16M10 7V5h4v2m-7 0l.6 12a2 2 0 0 0 2 1.9h4.8a2 2 0 0 0 2-1.9L17 7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function taskHtml(task) {
  const now = Date.now();
  const overdue = task.due && !task.done && new Date(task.due).getTime() < now;
  const parts = [];
  if (task.due) {
    parts.push(
      `<span class="meta-chip${overdue ? " is-overdue" : ""}">${ICON_CLOCK}${escapeHtml(formatDue(task.due))}</span>`
    );
  }
  if (task.priority !== "normal") {
    const label = t(task.priority === "high" ? "priority_high" : "priority_low");
    parts.push(
      `<span class="meta-chip meta-chip--priority"><span class="priority-dot priority-dot--${task.priority}"></span>${escapeHtml(label)}</span>`
    );
  }
  if (task.reminder && task.due && !task.done) {
    parts.push(`<span class="meta-chip">${ICON_CLOCK.replace("<svg", '<svg style="color:var(--accent)"')}${t("reminder")}</span>`);
  }
  const meta = parts.length ? `<div class="task__meta">${parts.join("")}</div>` : "";
  return `
    <li class="task${task.done ? " is-done" : ""}" data-id="${task.id}">
      <button type="button" class="task__check" role="checkbox" aria-checked="${task.done}"
              data-i18n-aria="aria_check" aria-label="${t("aria_check")}">${ICON_CHECK}</button>
      <div class="task__body">
        <p class="task__title">${escapeHtml(task.title)}</p>
        ${meta}
      </div>
      <div class="task__actions">
        <button type="button" class="task__action" data-action="edit" data-i18n-aria="aria_edit" aria-label="${t("aria_edit")}" title="${t("aria_edit")}">${ICON_EDIT}</button>
        <button type="button" class="task__action task__action--delete" data-action="delete" data-i18n-aria="aria_delete" aria-label="${t("aria_delete")}" title="${t("aria_delete")}">${ICON_TRASH}</button>
      </div>
    </li>`;
}

function renderEmpty() {
  let titleKey = "empty_title";
  let textKey = "empty_text";
  if (state.query.trim()) {
    titleKey = "empty_search_title";
    textKey = "empty_search_text";
  } else if (state.filter === "active") {
    titleKey = "empty_active_title";
    textKey = "empty_active_text";
  } else if (state.filter === "done") {
    titleKey = "empty_done_title";
    textKey = "empty_done_text";
  }
  els.emptyTitle.textContent = t(titleKey);
  els.emptyText.textContent = t(textKey);
  els.empty.hidden = visibleTasks().length > 0;
}

function render() {
  const total = state.tasks.length;
  const done = state.tasks.filter((task) => task.done).length;
  els.statTotal.textContent = String(total);
  els.statActive.textContent = String(total - done);
  els.statDone.textContent = String(done);

  els.list.innerHTML = visibleTasks().map(taskHtml).join("");
  renderEmpty();
  setBadge(total - done);
}

/* ---------- task actions ---------- */

function addTask() {
  const title = els.titleInput.value.trim();
  if (!title) {
    els.titleInput.focus();
    return;
  }
  const dueIso = localInputToIso(els.addDue.value);
  const priority =
    (document.querySelector('input[name="addPriority"]:checked') || {}).value || "normal";
  const reminder = els.addReminder.checked && Boolean(dueIso);
  state.tasks.push(createTask({ title, due: dueIso, priority, reminder }));
  persist();
  els.addForm.reset();
  els.addDetails.hidden = true;
  els.toggleDetails.setAttribute("aria-expanded", "false");
  render();
  els.titleInput.focus();
}

function deleteTask(id) {
  const index = state.tasks.findIndex((task) => task.id === id);
  if (index === -1) return;
  const [removed] = state.tasks.splice(index, 1);
  state.lastDeleted = removed;
  persist();
  render();
  showToast(t("toast_deleted"), {
    actionText: t("toast_undo"),
    onAction: () => {
      if (!state.lastDeleted) return;
      state.tasks.push(state.lastDeleted);
      state.lastDeleted = null;
      persist();
      render();
    },
  });
}

function toggleTask(id) {
  const task = state.tasks.find((x) => x.id === id);
  if (!task) return;
  task.done = !task.done;
  persist();
  render();
}

/* ---------- edit dialog ---------- */

function openEdit(id) {
  const task = state.tasks.find((x) => x.id === id);
  if (!task) return;
  state.editingId = id;
  els.editTitle.value = task.title;
  els.editDue.value = isoToLocalInput(task.due);
  els.editReminder.checked = task.reminder;
  const radio = document.querySelector(`input[name="editPriority"][value="${task.priority}"]`);
  if (radio) radio.checked = true;
  els.editDialog.showModal();
  els.editTitle.focus();
  els.editTitle.select();
}

function saveEdit() {
  const task = state.tasks.find((x) => x.id === state.editingId);
  if (!task) return;
  const title = els.editTitle.value.trim();
  if (!title) {
    els.editTitle.focus();
    return;
  }
  task.title = title;
  const dueIso = localInputToIso(els.editDue.value);
  const dueChanged = dueIso !== task.due;
  task.due = dueIso;
  task.priority =
    (document.querySelector('input[name="editPriority"]:checked') || {}).value || "normal";
  task.reminder = els.editReminder.checked && Boolean(dueIso);
  if (dueChanged || (task.reminder && !task.notified)) task.notified = false;
  persist();
  render();
  els.editDialog.close();
}

/* ---------- notifications UI ---------- */

function updateBell() {
  const perm = permissionState();
  const dot = els.bellBtn.querySelector(".icon-btn__dot");
  els.bellBtn.classList.toggle("is-denied", perm === "denied" || perm === "unsupported");
  if (dot) dot.hidden = perm !== "granted";
  const key =
    perm === "granted" ? "notif_on" :
    perm === "denied" ? "notif_denied" :
    perm === "unsupported" ? "notif_unsupported" : "notif_enable";
  els.bellBtn.title = t(key);
  els.bellBtn.setAttribute("aria-label", t(key));
}

async function onBellClick() {
  const perm = permissionState();
  if (perm === "granted") {
    showToast(t("notif_on"));
    return;
  }
  if (perm === "denied" || perm === "unsupported") {
    showToast(t(perm === "denied" ? "notif_denied" : "notif_unsupported"));
    return;
  }
  const result = await requestPermission();
  updateBell();
  if (result === "granted") showToast(t("notif_on"));
}

/* ---------- install prompt ---------- */

let deferredPrompt = null;

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  els.installBtn.hidden = false;
});

els.installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
  els.installBtn.hidden = true;
});

window.addEventListener("appinstalled", () => {
  els.installBtn.hidden = true;
});

/* ---------- deep link from notification ---------- */

function focusTaskFromUrl() {
  const id = new URLSearchParams(location.search).get("task");
  if (!id) return;
  state.filter = "all";
  state.query = "";
  els.searchInput.value = "";
  document.querySelectorAll(".chip").forEach((chip) =>
    chip.classList.toggle("is-active", chip.dataset.filter === "all"));
  render();
  const node = els.list.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (node) {
    node.scrollIntoView({ behavior: "smooth", block: "center" });
    node.classList.add("is-flash");
  }
  history.replaceState(null, "", location.pathname);
}

/* ---------- events ---------- */

els.addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  addTask();
});

els.toggleDetails.addEventListener("click", () => {
  const hidden = els.addDetails.hidden;
  els.addDetails.hidden = !hidden;
  els.toggleDetails.setAttribute("aria-expanded", String(hidden));
  if (hidden) els.addDue.focus();
});

// Reminder switch only makes sense with a date.
els.addReminder.addEventListener("change", () => {
  if (els.addReminder.checked && !els.addDue.value) {
    els.addDue.focus();
    els.addDue.reportValidity();
  }
});

els.list.addEventListener("click", (event) => {
  const item = event.target.closest(".task");
  if (!item) return;
  const id = item.dataset.id;
  const actionBtn = event.target.closest("[data-action]");
  if (actionBtn) {
    if (actionBtn.dataset.action === "delete") deleteTask(id);
    if (actionBtn.dataset.action === "edit") openEdit(id);
    return;
  }
  if (event.target.closest(".task__check")) toggleTask(id);
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    state.filter = chip.dataset.filter;
    document.querySelectorAll(".chip").forEach((x) =>
      x.classList.toggle("is-active", x === chip));
    render();
  });
});

els.searchInput.addEventListener("input", () => {
  state.query = els.searchInput.value;
  render();
});

document.querySelectorAll(".lang-switch__btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.lang === getLang()) return;
    setLang(btn.dataset.lang);
    document.querySelectorAll(".lang-switch__btn").forEach((x) =>
      x.classList.toggle("is-active", x === btn));
    applyI18n();
    render();
    updateBell();
  });
});

els.bellBtn.addEventListener("click", onBellClick);

els.editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  saveEdit();
});

els.editCancel.addEventListener("click", () => els.editDialog.close());
els.clearDue.addEventListener("click", () => { els.editDue.value = ""; });
els.editDelete.addEventListener("click", () => {
  const id = state.editingId;
  els.editDialog.close();
  if (id) deleteTask(id);
});

els.editDialog.addEventListener("click", (event) => {
  if (event.target === els.editDialog) els.editDialog.close();
});

/* ---------- init ---------- */

async function init() {
  applyI18n();
  document.querySelectorAll(".lang-switch__btn").forEach((btn) =>
    btn.classList.toggle("is-active", btn.dataset.lang === getLang()));
  await registerServiceWorker();
  updateBell();
  render();
  startReminderLoop(() => state.tasks, { markTask: null, persist });
  focusTaskFromUrl();
  // Re-render every minute so relative "overdue" styles stay fresh.
  setInterval(render, 60_000);
}

init();
