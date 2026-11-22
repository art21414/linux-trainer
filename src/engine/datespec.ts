// Разбор дат в стиле GNU: `touch -d STRING`, `touch -t [[CC]YY]MMDDhhmm[.ss]`.
// Подмножество `date -d`: ISO-даты и время, @секунды, «yesterday», «2 days ago», «next monday», «Jan 5 2020» и т.п.
// Часовой пояс сервера — UTC.

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const monthIndex = (w: string): number => {
  const i = MONTH_NAMES.findIndex((m) => m === w || m.slice(0, 3) === w || (w === "sept" && m === "september"));
  return i;
};
const dayIndex = (w: string): number => DAY_NAMES.findIndex((d) => d === w || d.slice(0, 3) === w || (w === "tues" && d === "tuesday") || (w === "wednes" && d === "wednesday") || (w === "thur" && d === "thursday") || (w === "thurs" && d === "thursday"));

const UNIT = "(sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days|week|weeks|fortnight|fortnights|month|months|year|years)";
const MON = "(jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)";
const DAY = "(sun|sunday|mon|monday|tue|tues|tuesday|wed|wednes|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)";

interface Rel {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

function addUnit(rel: Rel, n: number, unit: string): void {
  if (unit.startsWith("sec")) rel.s += n;
  else if (unit.startsWith("min")) rel.mi += n;
  else if (unit.startsWith("hour")) rel.h += n;
  else if (unit.startsWith("day")) rel.d += n;
  else if (unit.startsWith("week")) rel.d += 7 * n;
  else if (unit.startsWith("fortnight")) rel.d += 14 * n;
  else if (unit.startsWith("month")) rel.mo += n;
  else if (unit.startsWith("year")) rel.y += n;
}

/** Разобрать строку даты как `date -d`. null — не получилось. */
export function parseDateSpec(input: string, now = new Date()): Date | null {
  let s = input.trim().toLowerCase().replace(/,/g, " ");
  if (!s) return null;
  const epoch = /^@(-?\d+)(?:[.,](\d+))?$/.exec(s);
  if (epoch) return new Date(Number(epoch[1]) * 1000 + (epoch[2] ? Math.floor(Number(`0.${epoch[2]}`) * 1000) : 0));

  let Y = null as number | null;
  let M = null as number | null;
  let D = null as number | null;
  let hh = null as number | null;
  let mm = 0;
  let ss = 0;
  let ms = 0;
  let tz = null as number | null; // смещение в минутах
  let weekday = null as { n: number; dir: -1 | 0 | 1 } | null;
  const rel: Rel = { y: 0, mo: 0, d: 0, h: 0, mi: 0, s: 0 };

  const setTime = (h: number, m: number, sec: number, frac?: string, ap?: string) => {
    if (ap) {
      if (h < 1 || h > 12) throw new Error("bad");
      h = (h % 12) + (ap === "pm" ? 12 : 0);
    }
    if (h > 23 || m > 59 || sec > 60) throw new Error("bad");
    hh = h;
    mm = m;
    ss = sec;
    ms = frac ? Math.floor(Number(`0.${frac}`) * 1000) : 0;
  };
  const setDate = (y: number | null, m: number, d: number) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) throw new Error("bad");
    if (y !== null) Y = y;
    M = m - 1;
    D = d;
  };

  const rules: [RegExp, (m: RegExpExecArray) => void][] = [
    [/^(\d{4})-(\d{1,2})-(\d{1,2})/, (m) => setDate(+m[1], +m[2], +m[3])],
    [/^(\d{4})\/(\d{1,2})\/(\d{1,2})/, (m) => setDate(+m[1], +m[2], +m[3])],
    [/^(\d{1,2})\/(\d{1,2})\/(\d{4})/, (m) => setDate(+m[3], +m[1], +m[2])],
    [/^(\d{1,2})\/(\d{1,2})(?![\d/])/, (m) => setDate(null, +m[1], +m[2])],
    [/^(\d{4})(\d{2})(\d{2})(?!\d)/, (m) => setDate(+m[1], +m[2], +m[3])],
    [/^t(?=\d)/, () => {}],
    [/^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:\s*(am|pm))?/, (m) => setTime(+m[1], +m[2], m[3] ? +m[3] : 0, m[4], m[5])],
    [/^(\d{1,2})\s*(am|pm)\b/, (m) => setTime(+m[1], 0, 0, undefined, m[2])],
    [new RegExp(`^([+-]?)\\s*(\\d+)\\s*${UNIT}\\b(\\s+ago\\b)?`), (m) => addUnit(rel, (m[1] === "-" ? -1 : 1) * +m[2] * (m[4] ? -1 : 1), m[3])],
    [new RegExp(`^(next|last|this)\\s+${UNIT}\\b`), (m) => addUnit(rel, m[1] === "next" ? 1 : m[1] === "last" ? -1 : 0, m[2])],
    [new RegExp(`^(next|last|this)\\s+${DAY}\\b`), (m) => (weekday = { n: dayIndex(m[2]), dir: m[1] === "next" ? 1 : m[1] === "last" ? -1 : 0 })],
    [new RegExp(`^${DAY}\\b`), (m) => (weekday = { n: dayIndex(m[1]), dir: 0 })],
    [new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?:\\s+(\\d{4})(?![\\d:]))?`), (m) => setDate(m[3] ? +m[3] : null, monthIndex(m[2]) + 1, +m[1])],
    [new RegExp(`^${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:])(?:\\s+(\\d{4})(?![\\d:]))?`), (m) => setDate(m[3] ? +m[3] : null, monthIndex(m[1]) + 1, +m[2])],
    [new RegExp(`^${MON}\\s+(\\d{4})\\b`), (m) => setDate(+m[2], monthIndex(m[1]) + 1, 1)],
    [/^yesterday\b/, () => (rel.d -= 1)],
    [/^tomorrow\b/, () => (rel.d += 1)],
    [/^(now|today)\b/, () => {}],
    [/^midnight\b/, () => ((hh = 0), (mm = 0), (ss = 0), (ms = 0))],
    [/^noon\b/, () => ((hh = 12), (mm = 0), (ss = 0), (ms = 0))],
    [/^(z|utc|gmt)\b/, () => (tz = 0)],
    [/^([+-])(\d{2}):?(\d{2})\b/, (m) => (tz = (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]))],
    [/^([+-])(\d{1,2})\b/, (m) => (tz = (m[1] === "-" ? -1 : 1) * +m[2] * 60)],
    [/^ago\b/, () => {
      for (const k of Object.keys(rel) as (keyof Rel)[]) rel[k] = -rel[k];
    }],
  ];

  try {
    while (s.length) {
      s = s.replace(/^\s+/, "");
      if (!s) break;
      let hit = false;
      for (const [re, fn] of rules) {
        const m = re.exec(s);
        if (!m) continue;
        fn(m);
        s = s.slice(m[0].length);
        hit = true;
        break;
      }
      if (!hit) return null;
    }
  } catch {
    return null;
  }

  const haveDate = M !== null;
  const haveTime = hh !== null;
  // «сегодня» в часовом поясе, который указан в строке (или UTC)
  const base = new Date(now.getTime() + (tz ?? 0) * 60000);
  const y = Y ?? base.getUTCFullYear();
  const mo = M ?? base.getUTCMonth();
  const d = D ?? base.getUTCDate();
  let h: number;
  let mi: number;
  let sec: number;
  let msec: number;
  if (haveTime) [h, mi, sec, msec] = [hh!, mm, ss, ms];
  else if (haveDate || weekday) [h, mi, sec, msec] = [0, 0, 0, 0];
  else [h, mi, sec, msec] = [base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds(), base.getUTCMilliseconds()];

  let date = new Date(Date.UTC(y, mo, d, h, mi, sec, msec));
  if (Y !== null && Y < 100) date.setUTCFullYear(Y);
  if (weekday) {
    const wd = weekday;
    const cur = date.getUTCDay();
    let diff = (wd.n - cur + 7) % 7;
    if (wd.dir === 1 && diff === 0) diff = 7;
    if (wd.dir === -1) diff = diff === 0 ? -7 : diff - 7;
    date = new Date(date.getTime() + diff * 86400000);
  }
  date = new Date(Date.UTC(date.getUTCFullYear() + rel.y, date.getUTCMonth() + rel.mo, date.getUTCDate() + rel.d, date.getUTCHours() + rel.h, date.getUTCMinutes() + rel.mi, date.getUTCSeconds() + rel.s, date.getUTCMilliseconds()));
  if (tz !== null) date = new Date(date.getTime() - tz * 60000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `touch -t [[CC]YY]MMDDhhmm[.ss]` → Date (UTC). null — неверный формат. */
export function parseTouchT(input: string, now = new Date()): Date | null {
  const m = /^(\d{8}|\d{10}|\d{12})(?:\.(\d{2}))?$/.exec(input);
  if (!m) return null;
  const digits = m[1];
  const sec = m[2] ? Number(m[2]) : 0;
  let year: number;
  let rest: string;
  if (digits.length === 12) {
    year = Number(digits.slice(0, 4));
    rest = digits.slice(4);
  } else if (digits.length === 10) {
    const yy = Number(digits.slice(0, 2));
    year = yy >= 69 ? 1900 + yy : 2000 + yy;
    rest = digits.slice(2);
  } else {
    year = now.getUTCFullYear();
    rest = digits;
  }
  const mo = Number(rest.slice(0, 2));
  const d = Number(rest.slice(2, 4));
  const h = Number(rest.slice(4, 6));
  const mi = Number(rest.slice(6, 8));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 61) return null;
  const date = new Date(Date.UTC(year, mo - 1, d, h, mi, sec));
  if (date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date;
}
