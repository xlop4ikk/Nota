// Task storage backed by localStorage.

const TASKS_KEY = "nota.tasks.v1";

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function normalize(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.title !== "string") return null;
  return {
    id: String(raw.id || uid()),
    title: raw.title.slice(0, 200),
    done: Boolean(raw.done),
    due: raw.due || null,
    priority: ["low", "normal", "high"].includes(raw.priority) ? raw.priority : "normal",
    reminder: Boolean(raw.reminder),
    notified: Boolean(raw.notified),
    createdAt: Number(raw.createdAt) || Date.now(),
  };
}

export function loadTasks() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASKS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalize).filter(Boolean);
  } catch {
    return [];
  }
}

export function saveTasks(tasks) {
  try {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  } catch { /* storage may be unavailable in private mode */ }
}

export function createTask({ title, due = null, priority = "normal", reminder = false }) {
  return normalize({
    id: uid(),
    title: title.trim(),
    done: false,
    due,
    priority,
    reminder,
    notified: false,
    createdAt: Date.now(),
  });
}
