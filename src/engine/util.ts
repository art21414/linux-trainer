import type { ExecResult } from "just-bash";

export const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
export const fail = (stderr: string, exitCode = 1, stdout = ""): ExecResult => ({
  stdout,
  stderr: stderr.endsWith("\n") || !stderr ? stderr : stderr + "\n",
  exitCode,
});

/** ByteString (latin1) из just-bash → нормальная UTF-8 строка. */
export function bytesToText(input: unknown): string {
  const s = String(input ?? "");
  if (!s) return "";
  if (!/[\u0080-ÿ]/.test(s)) return s;
  const bytes = Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  return new TextDecoder().decode(bytes);
}

export interface Parsed {
  flags: Set<string>;
  values: Map<string, string>;
  rest: string[];
  bad?: string;
}

/**
 * Разбор опций в стиле GNU: -abc, --long, -o VALUE, --long=VALUE, "--" завершает опции.
 * withValue — короткие/длинные опции, которые принимают аргумент.
 * alias — длинные имена → короткие (например all → a).
 */
export function parseArgs(
  args: string[],
  opts: { short?: string; withValue?: string[]; long?: Record<string, string>; digits?: boolean; optValue?: string[] } = {},
): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const withValue = new Set(opts.withValue ?? []);
  const optValue = new Set(opts.optValue ?? []);
  const known = new Set((opts.short ?? "").split(""));
  const long = opts.long ?? {};
  let bad: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const [name, val] = a.slice(2).split(/=(.*)/s, 2);
      const key = long[name] ?? name;
      if (!(name in long) && !withValue.has(name) && !optValue.has(name)) bad ??= a;
      if (optValue.has(key)) {
        flags.add(key);
        if (val !== undefined) values.set(key, val);
      } else if (withValue.has(key)) values.set(key, val ?? args[++i] ?? "");
      else flags.add(key);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && (opts.digits || !/^-\d/.test(a))) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (withValue.has(c)) {
          values.set(c, a.slice(j + 1) || args[++i] || "");
          break;
        }
        if (!known.has(c)) bad ??= c;
        flags.add(c);
      }
      continue;
    }
    rest.push(a);
  }
  return { flags, values, rest, bad };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_FULL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAYS_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Часовой пояс сервера — UTC (как у облачных образов); все даты в тренажёре показываются в UTC. */
const p2 = (n: number, l = 2) => String(n).padStart(l, "0");

/** strftime (подмножество GNU date/ls): %Y %m %d %e %H %M %S %N %y %b %B %a %A %j %Z %z %s %F %T %D %R %I %p %n %t %%. */
export function strftime(fmt: string, d: Date): string {
  return fmt.replace(/%([-_0^#]?)([A-Za-z%])/g, (_m, flag: string, c: string) => {
    const pad = (n: number, l = 2, ch = "0") => (flag === "-" ? String(n) : flag === "_" ? String(n).padStart(l, " ") : String(n).padStart(l, flag === "0" ? "0" : ch));
    let r: string;
    switch (c) {
      case "Y": r = String(d.getUTCFullYear()); break;
      case "y": r = pad(d.getUTCFullYear() % 100); break;
      case "m": r = pad(d.getUTCMonth() + 1); break;
      case "d": r = pad(d.getUTCDate()); break;
      case "e": r = pad(d.getUTCDate(), 2, " "); break;
      case "H": r = pad(d.getUTCHours()); break;
      case "I": r = pad(d.getUTCHours() % 12 || 12); break;
      case "k": r = pad(d.getUTCHours(), 2, " "); break;
      case "l": r = pad(d.getUTCHours() % 12 || 12, 2, " "); break;
      case "M": r = pad(d.getUTCMinutes()); break;
      case "S": r = pad(d.getUTCSeconds()); break;
      case "N": r = p2(d.getUTCMilliseconds(), 3) + "000000"; break;
      case "p": r = d.getUTCHours() < 12 ? "AM" : "PM"; break;
      case "b": case "h": r = MONTHS[d.getUTCMonth()]; break;
      case "B": r = MONTHS_FULL[d.getUTCMonth()]; break;
      case "a": r = DAYS[d.getUTCDay()]; break;
      case "A": r = DAYS_FULL[d.getUTCDay()]; break;
      case "u": r = String(d.getUTCDay() || 7); break;
      case "w": r = String(d.getUTCDay()); break;
      case "j": r = pad(Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 864e5), 3); break;
      case "Z": r = "UTC"; break;
      case "z": r = "+0000"; break;
      case "s": r = String(Math.floor(d.getTime() / 1000)); break;
      case "F": r = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`; break;
      case "T": r = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`; break;
      case "R": r = `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`; break;
      case "D": r = `${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())}/${p2(d.getUTCFullYear() % 100)}`; break;
      case "n": r = "\n"; break;
      case "t": r = "\t"; break;
      case "%": r = "%"; break;
      default: return `%${flag}${c}`;
    }
    return flag === "^" ? r.toUpperCase() : r;
  });
}

/** Старше полугода (или из будущего) — GNU ls показывает год вместо времени. */
const SIX_MONTHS_MS = 15778476 * 1000;
export function isRecent(d: Date, now = new Date()): boolean {
  const t = d.getTime();
  return t >= now.getTime() - SIX_MONTHS_MS && t <= now.getTime();
}

/** Дата как в ls -l: «Oct 26 21:55» или «Oct 26  2025» для старых файлов. */
export function lsDate(d: Date, now = new Date()): string {
  const day = String(d.getUTCDate()).padStart(2, " ");
  const tail = isRecent(d, now) ? `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}` : ` ${d.getUTCFullYear()}`;
  return `${MONTHS[d.getUTCMonth()]} ${day} ${tail}`;
}

/** Текст errno из сообщения ошибки ФС (`EACCES: permission denied, open '/x'` → `Permission denied`). */
export function errnoText(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (m.startsWith("EACCES")) return "Permission denied";
  if (m.startsWith("EPERM")) return "Operation not permitted";
  if (m.startsWith("ENOENT")) return "No such file or directory";
  if (m.startsWith("EEXIST")) return "File exists";
  if (m.startsWith("EISDIR")) return "Is a directory";
  if (m.startsWith("ENOTDIR")) return "Not a directory";
  if (m.startsWith("ENOTEMPTY")) return "Directory not empty";
  if (m.startsWith("EROFS")) return "Read-only file system";
  if (m.startsWith("ENOSPC")) return "No space left on device";
  return m;
}

/** Текст ошибки неизвестной опции + подсказка (как у coreutils). */
export function invalidOpt(cmd: string, bad: string, extra = ""): string {
  const head = bad.startsWith("--") ? `${cmd}: unrecognized option '${bad}'` : `${cmd}: invalid option -- '${bad}'`;
  return `${head}\n${extra}Try '${cmd} --help' for more information.`;
}

/** Shell-экранирование одного аргумента. */
export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
