// Предобработка строки до запуска (just-bash не умеет): ~user и физический `cd -P`.
import type { World } from "./world";
import { physicalPath } from "./path";

/** Раскрыть ~user (из passwd мира) в начале слова вне кавычек. Неизвестный пользователь остаётся как есть. */
export function fixTilde(w: World, line: string): string {
  let out = "";
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      out += c;
      if (c === "\\" && q === '"' && i + 1 < line.length) out += line[++i];
      else if (c === q) q = "";
      continue;
    }
    if (c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      out += c;
      continue;
    }
    if (c === "~" && (i === 0 || /[\s;&|(<>]/.test(line[i - 1]))) {
      const m = /^~([A-Za-z_][A-Za-z0-9_-]*)(?=$|[\s/;&|)<>])/.exec(line.slice(i));
      const u = m && w.user(m[1]);
      if (m && u) {
        out += u.home;
        i += m[0].length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** `cd -P X` в начале строки: builtin just-bash сначала сворачивает `..` текстово. Подставляем физический путь. */
export function fixCdP(line: string, cwd: string): string {
  return line.replace(/^(\s*cd\s+-P\s+(?:--\s+)?)([^\s;&|'"$`\\]+)/, (_m, pre: string, arg: string) => pre + physicalPath(cwd, arg));
}

/** Подстановка алиасов в позиции команды (вне кавычек). Рекурсивные алиасы (`alias ls='ls -l'`) раскрываются один раз, как в bash. */
export function fixAliases(aliases: Map<string, string>, line: string): string {
  if (!aliases.size) return line;
  let out = "";
  let q = "";
  let cmdPos = true;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      out += c;
      if (c === "\\" && q === '"' && i + 1 < line.length) out += line[++i];
      else if (c === q) q = "";
      continue;
    }
    if (c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
      cmdPos = false;
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      out += c;
      cmdPos = false;
      continue;
    }
    if (/[;&|(\n]/.test(c)) {
      out += c;
      cmdPos = true;
      continue;
    }
    if (/\s/.test(c)) {
      out += c;
      continue;
    }
    if (cmdPos) {
      const m = /^[A-Za-z0-9_.+-]+(?=$|[\s;&|)<>])/.exec(line.slice(i));
      if (m && aliases.has(m[0])) {
        out += aliases.get(m[0]);
        i += m[0].length - 1;
        cmdPos = false;
        continue;
      }
    }
    cmdPos = false;
    out += c;
  }
  return out;
}

/** Строка целиком — builtin alias/unalias: обработать и вернуть вывод; иначе null. */
export function aliasBuiltin(aliases: Map<string, string>, line: string): { out: string; code: number } | null {
  const q = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;
  let m = /^alias(?:\s+(.*))?$/.exec(line);
  if (m) {
    const arg = (m[1] ?? "").trim();
    if (/[;&|<>]/.test(arg.replace(/'[^']*'|"[^"]*"/g, ""))) return null;
    if (!arg || arg === "-p") return { out: [...aliases].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `alias ${k}=${q(v)}\n`).join(""), code: 0 };
    const mm = /^([A-Za-z0-9_.+-]+)=(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S*))$/.exec(arg);
    if (mm) {
      aliases.set(mm[1], mm[2] ?? mm[3] ?? mm[4] ?? "");
      return { out: "", code: 0 };
    }
    let out = "";
    let code = 0;
    for (const n of arg.split(/\s+/)) {
      if (aliases.has(n)) out += `alias ${n}=${q(aliases.get(n)!)}\n`;
      else {
        out += `bash: alias: ${n}: not found\n`;
        code = 1;
      }
    }
    return { out, code };
  }
  m = /^unalias\s+(.+)$/.exec(line);
  if (m) {
    if (/[;&|<>]/.test(m[1])) return null;
    let out = "";
    let code = 0;
    for (const n of m[1].trim().split(/\s+/)) {
      if (n === "-a") aliases.clear();
      else if (!aliases.delete(n)) {
        out += `bash: unalias: ${n}: not found\n`;
        code = 1;
      }
    }
    return { out, code };
  }
  return null;
}

/** `$0` / `${0}` вне одинарных кавычек → имя оболочки сессии (`-bash` у login shell, `bash` у остальных). */
export function fixArgv0(line: string, argv0: string): string {
  let out = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'") q = !q;
    if (!q && c === "\\") {
      out += c + (line[i + 1] ?? "");
      i++;
      continue;
    }
    if (!q && c === "$" && (line[i + 1] === "0" || line.startsWith("{0}", i + 1))) {
      out += argv0;
      i += line[i + 1] === "0" ? 1 : 3;
      continue;
    }
    out += c;
  }
  return out;
}
