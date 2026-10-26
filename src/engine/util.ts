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
  opts: { short?: string; withValue?: string[]; long?: Record<string, string> } = {},
): Parsed {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const rest: string[] = [];
  const withValue = new Set(opts.withValue ?? []);
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
      if (!(name in long) && !withValue.has(name)) bad ??= a;
      if (withValue.has(key)) values.set(key, val ?? args[++i] ?? "");
      else flags.add(key);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !/^-\d/.test(a)) {
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

/** Дата как в ls -l: «Oct 26 21:55» или «Oct 26  2025» для старых файлов. */
export function lsDate(d: Date, now = new Date()): string {
  const day = String(d.getDate()).padStart(2, " ");
  const recent = Math.abs(now.getTime() - d.getTime()) < 182 * 24 * 3600 * 1000;
  const tail = recent
    ? `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${day} ${tail}`;
}

/** Shell-экранирование одного аргумента. */
export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
