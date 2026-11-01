// Прогресс хранится локально (localStorage). Есть экспорт/импорт в JSON.
const KEY = "linux-trainer:progress";
const VERSION = 2;

export interface SetResult {
  best: number; // лучшая точность, 0..1
  times: number;
}

export interface MistakeInfo {
  count: number;
  last: string; // дата YYYY-MM-DD
}

export interface Progress {
  v: number;
  xp: number;
  /** Пройденные наборы: `topicId/setId` (зачёт — `topicId/exam`). */
  sets: Record<string, SetResult>;
  /** Зачёт темы сдан: topicId → дата. */
  exams: Record<string, string>;
  /** Подтемы: `topicId#anchor` → «знаю» / «прочитано». */
  known: Record<string, true>;
  read: Record<string, true>;
  /** Ошибки для повторения: `topicId/exerciseId`. */
  mistakes: Record<string, MistakeInfo>;
  /** Текущая/последняя тема. */
  lastTopic: string | null;
  streak: { count: number; last: string | null };
  daily: { day: string; xp: number };
  /** Журнал неизвестных/неподдерживаемых команд — отправлять разработчику. */
  unknown: { cmd: string; line: string; at: string; kind: "notfound" | "unsupported" }[];
  settings: { sound: boolean; dailyGoal: number };
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function fresh(): Progress {
  return {
    v: VERSION,
    xp: 0,
    sets: {},
    exams: {},
    known: {},
    read: {},
    streak: { count: 0, last: null },
    daily: { day: today(), xp: 0 },
    mistakes: {},
    lastTopic: null,
    unknown: [],
    settings: { sound: true, dailyGoal: 20 },
  };
}

/** Миграция любой сохранённой версии к текущей. v1: сохраняем xp, streak, daily, unknown, settings; уроки и ошибки отбрасываем. */
export function migrate(data: any): Progress {
  const f = fresh();
  if (!data || typeof data !== "object") return f;
  const keep = {
    xp: typeof data.xp === "number" ? data.xp : 0,
    streak: data.streak ?? f.streak,
    daily: data.daily ?? f.daily,
    unknown: Array.isArray(data.unknown) ? data.unknown : [],
    settings: { ...f.settings, ...(data.settings ?? {}) },
  };
  if (data.v === VERSION) return { ...f, ...data, ...keep, v: VERSION };
  return { ...f, ...keep };
}

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    return migrate(JSON.parse(raw));
  } catch {
    return fresh();
  }
}

export const progress: Progress = load();

export function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(progress));
  } catch {
    /* приватный режим и т.п. */
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

/** Стрик «живой», если занимался сегодня или вчера. */
export function currentStreak(): number {
  const s = progress.streak;
  if (!s.last) return 0;
  return daysBetween(s.last, today()) <= 1 ? s.count : 0;
}

export function doneToday(): boolean {
  return progress.streak.last === today();
}

export function dailyXp(): number {
  return progress.daily.day === today() ? progress.daily.xp : 0;
}

/** Добавить XP и обновить стрик. Возвращает, вырос ли стрик. */
function addXp(xp: number): { streakUp: boolean } {
  const t = today();
  progress.xp += xp;
  if (progress.daily.day !== t) progress.daily = { day: t, xp: 0 };
  progress.daily.xp += xp;
  let streakUp = false;
  const s = progress.streak;
  if (s.last !== t) {
    s.count = s.last && daysBetween(s.last, t) === 1 ? s.count + 1 : 1;
    s.last = t;
    streakUp = true;
  }
  return { streakUp };
}

/** Засчитать набор практики (или зачёт: setId = "exam"). Зачёт засчитывается только при accuracy === 1. */
export function completeSet(topicId: string, setId: string, accuracy: number, xp: number): { streakUp: boolean } {
  const key = `${topicId}/${setId}`;
  const r = progress.sets[key] ?? { best: 0, times: 0 };
  progress.sets[key] = { best: Math.max(r.best, accuracy), times: r.times + 1 };
  if (setId === "exam" && accuracy >= 1 && !progress.exams[topicId]) progress.exams[topicId] = today();
  progress.lastTopic = topicId;
  const res = addXp(xp);
  save();
  return res;
}

/** Повторение ошибок: только XP и стрик (в «наборы» не пишется). */
export function completeReview(xp: number): { streakUp: boolean } {
  const res = addXp(xp);
  save();
  return res;
}

export function noteMistake(topicId: string, exId: string): void {
  const k = `${topicId}/${exId}`;
  const m = progress.mistakes[k];
  progress.mistakes[k] = { count: (m?.count ?? 0) + 1, last: today() };
  save();
}

/** Задание решено правильно при повторении — убираем из списка ошибок. */
export function clearMistake(topicId: string, exId: string): void {
  if (delete progress.mistakes[`${topicId}/${exId}`]) save();
}

export function markKnown(topicId: string, anchor: string, on = true): void {
  if (on) progress.known[`${topicId}#${anchor}`] = true;
  else delete progress.known[`${topicId}#${anchor}`];
  save();
}

export function markRead(topicId: string, anchor: string): void {
  progress.read[`${topicId}#${anchor}`] = true;
  progress.lastTopic = topicId;
  save();
}

export const isKnown = (topicId: string, anchor: string) => !!progress.known[`${topicId}#${anchor}`];
export const isRead = (topicId: string, anchor: string) => !!progress.read[`${topicId}#${anchor}`];

export function setTopic(topicId: string): void {
  progress.lastTopic = topicId;
  save();
}

// ---------- производные: прогресс темы ----------

export type TopicStatus = "new" | "in-progress" | "closed-by-exam" | "mastered";

/** Минимальное описание темы для подсчётов (подходит и Topic). */
export interface TopicLike {
  id: string;
  sets: { id: string; exercises: { id: string }[] }[];
  exam: { exercises: { id: string }[] };
}

/** Доля пройденных наборов (без зачёта), 0..1. */
export function topicSetsDone(t: TopicLike): { done: number; total: number } {
  const done = t.sets.filter((s) => progress.sets[`${t.id}/${s.id}`]).length;
  return { done, total: t.sets.length };
}

/** Доля заданий в пройденных наборах, 0..1. Сданный зачёт = 1. */
export function topicProgress(t: TopicLike): number {
  if (progress.exams[t.id]) return 1;
  let all = 0;
  let done = 0;
  for (const s of t.sets) {
    all += s.exercises.length;
    if (progress.sets[`${t.id}/${s.id}`]) done += s.exercises.length;
  }
  return all ? done / all : 0;
}

/**
 * new — ничего не делали; in-progress — есть пройденные наборы/прочитанные подтемы, зачёта нет;
 * closed-by-exam — зачёт сдан, наборы не все пройдены; mastered — зачёт сдан и все наборы пройдены.
 */
export function topicStatus(t: TopicLike): TopicStatus {
  const { done, total } = topicSetsDone(t);
  if (progress.exams[t.id]) return done >= total ? "mastered" : "closed-by-exam";
  const touched = done > 0 || !!progress.sets[`${t.id}/exam`] || Object.keys(progress.read).some((k) => k.startsWith(`${t.id}#`)) || Object.keys(progress.known).some((k) => k.startsWith(`${t.id}#`));
  return touched ? "in-progress" : "new";
}

export interface ContinueTarget {
  topicId: string;
  /** Следующий набор; "exam" — зачёт; null — тема закрыта. */
  setId: string | null;
}

/**
 * Куда продолжить: последняя тема, если она не закрыта; иначе первая незакрытая тема по порядку.
 * Внутри темы — первый непройденный набор, потом зачёт.
 */
export function continueTarget(topics: TopicLike[]): ContinueTarget | null {
  const open = (t: TopicLike) => !progress.exams[t.id];
  const next = (t: TopicLike): string | null => t.sets.find((s) => !progress.sets[`${t.id}/${s.id}`])?.id ?? (progress.exams[t.id] ? null : "exam");
  const last = topics.find((t) => t.id === progress.lastTopic && open(t));
  const t = last ?? topics.find(open);
  return t ? { topicId: t.id, setId: next(t) } : null;
}

/** Ошибки, отсортированные от старых к новым (для повторения). */
export function mistakesDue(): { topicId: string; exId: string; info: MistakeInfo }[] {
  return Object.entries(progress.mistakes)
    .map(([k, info]) => {
      const i = k.indexOf("/");
      return { topicId: k.slice(0, i), exId: k.slice(i + 1), info };
    })
    .sort((a, b) => a.info.last.localeCompare(b.info.last));
}

export function logUnknown(cmd: string, line: string, kind: "notfound" | "unsupported"): void {
  progress.unknown.push({ cmd, line, at: new Date().toISOString(), kind });
  if (progress.unknown.length > 300) progress.unknown.splice(0, progress.unknown.length - 300);
  save();
}

export function exportProgress(): string {
  return JSON.stringify(progress, null, 2);
}

export function importProgress(json: string): boolean {
  try {
    const data = JSON.parse(json);
    if (typeof data !== "object" || data === null || typeof data.xp !== "number") return false;
    Object.assign(progress, migrate(data));
    save();
    return true;
  } catch {
    return false;
  }
}

export function resetProgress(): void {
  Object.assign(progress, fresh());
  save();
}
