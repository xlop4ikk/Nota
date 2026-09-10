// i18n: RU/EN dictionary and DOM translation helpers.

const dict = {
  ru: {
    doc_title: "Nota — список задач",
    tagline: "Список задач",
    add_placeholder: "Новая задача…",
    add_title: "Добавить",
    more_options: "Параметры",
    details_due: "Дата и время",
    details_priority: "Приоритет",
    priority_low: "Низкий",
    priority_normal: "Обычный",
    priority_high: "Высокий",
    reminder: "Напомнить",
    filter_all: "Все",
    filter_active: "Активные",
    filter_done: "Выполненные",
    search_placeholder: "Поиск",
    stat_total: "Всего",
    stat_active: "Активных",
    stat_done: "Готово",
    empty_title: "Пока пусто",
    empty_text: "Добавьте первую задачу — она появится здесь.",
    empty_active_title: "Всё сделано",
    empty_active_text: "Активных задач нет. Отличный момент для перерыва.",
    empty_done_title: "Пока нечего показать",
    empty_done_text: "Выполненные задачи появятся здесь.",
    empty_search_title: "Ничего не найдено",
    empty_search_text: "Попробуйте изменить запрос или фильтр.",
    edit_title: "Редактировать задачу",
    field_title: "Задача",
    save: "Сохранить",
    cancel: "Отмена",
    delete: "Удалить",
    clear: "Убрать",
    toast_deleted: "Задача удалена",
    toast_undo: "Вернуть",
    notif_enable: "Включить напоминания",
    notif_on: "Напоминания включены",
    notif_denied: "Уведомления заблокированы в настройках браузера",
    notif_unsupported: "Браузер не поддерживает уведомления",
    footer: "Данные хранятся только в вашем браузере",
    install: "Установить",
    aria_edit: "Редактировать",
    aria_delete: "Удалить",
    aria_check: "Отметить выполненной",
  },
  en: {
    doc_title: "Nota — to-do list",
    tagline: "To-do list",
    add_placeholder: "New task…",
    add_title: "Add",
    more_options: "Options",
    details_due: "Date & time",
    details_priority: "Priority",
    priority_low: "Low",
    priority_normal: "Normal",
    priority_high: "High",
    reminder: "Remind me",
    filter_all: "All",
    filter_active: "Active",
    filter_done: "Done",
    search_placeholder: "Search",
    stat_total: "Total",
    stat_active: "Active",
    stat_done: "Done",
    empty_title: "Nothing here yet",
    empty_text: "Add your first task — it will appear here.",
    empty_active_title: "All done",
    empty_active_text: "No active tasks. A perfect moment for a break.",
    empty_done_title: "Nothing to show",
    empty_done_text: "Completed tasks will appear here.",
    empty_search_title: "Nothing found",
    empty_search_text: "Try a different query or filter.",
    edit_title: "Edit task",
    field_title: "Task",
    save: "Save",
    cancel: "Cancel",
    delete: "Delete",
    clear: "Clear",
    toast_deleted: "Task deleted",
    toast_undo: "Undo",
    notif_enable: "Enable reminders",
    notif_on: "Reminders are on",
    notif_denied: "Notifications are blocked in browser settings",
    notif_unsupported: "This browser does not support notifications",
    footer: "Your data is stored only in this browser",
    install: "Install",
    aria_edit: "Edit",
    aria_delete: "Delete",
    aria_check: "Mark as done",
  },
};

const LANG_KEY = "nota.lang";

let current = (() => {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (saved === "ru" || saved === "en") return saved;
  } catch { /* ignore */ }
  return (navigator.language || "ru").toLowerCase().startsWith("ru") ? "ru" : "en";
})();

export function getLang() {
  return current;
}

export function setLang(lang) {
  current = lang === "en" ? "en" : "ru";
  try { localStorage.setItem(LANG_KEY, current); } catch { /* ignore */ }
}

export function t(key) {
  return (dict[current] && dict[current][key]) ?? dict.ru[key] ?? key;
}

export function applyI18n(root = document) {
  document.documentElement.lang = current;
  document.title = t("doc_title");
  root.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  root.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  root.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  root.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
}

// Format an ISO datetime string for the current locale.
export function formatDue(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const locale = current === "ru" ? "ru-RU" : "en-US";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const opts = sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  return new Intl.DateTimeFormat(locale, opts).format(date);
}
