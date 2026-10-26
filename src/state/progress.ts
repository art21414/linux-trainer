// Прогресс хранится локально (localStorage). Есть экспорт/импорт в JSON.
const KEY = "linux-trainer:progress";
const VERSION = 1;

export interface LessonResult {
  best: number; // лучшая точность, 0..1
  times: number;
}

export interface Progress {
  v: number;
  xp: number;
  lessons: Record<string, LessonResult>;
  streak: { count: number; last: string | null };
  daily: { day: string; xp: number };
  /** Ошибки для интервального повторения: lessonId#index → сколько раз ошибся. */
  mistakes: Record<string, number>;
  /** Журнал неизвестных/неподдерживаемых команд — отправлять разработчику. */
  unknown: { cmd: string; line: string; at: string; kind: "notfound" | "unsupported" }[];
  settings: { sound: boolean; dailyGoal: number };
}

export const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function fresh(): Progress {
  return {
    v: VERSION,
    xp: 0,
    lessons: {},
    streak: { count: 0, last: null },
    daily: { day: today(), xp: 0 },
    mistakes: {},
    unknown: [],
    settings: { sound: true, dailyGoal: 20 },
  };
}

function load(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return fresh();
    return { ...fresh(), ...JSON.parse(raw) };
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

/** Засчитать урок. Возвращает, вырос ли стрик. */
export function completeLesson(id: string, accuracy: number, xp: number): { streakUp: boolean } {
  const t = today();
  const r = progress.lessons[id] ?? { best: 0, times: 0 };
  progress.lessons[id] = { best: Math.max(r.best, accuracy), times: r.times + 1 };
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
  save();
  return { streakUp };
}

export function noteMistake(key: string): void {
  progress.mistakes[key] = (progress.mistakes[key] ?? 0) + 1;
  save();
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
    Object.assign(progress, fresh(), data);
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
