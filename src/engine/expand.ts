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
