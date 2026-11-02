// Раскрытие шаблонов имён там, где just-bash ошибается: `*/` (только каталоги), `*` при существующем файле с именем `*`
// (just-bash в этом случае оставляет шаблон как есть), `.*` (в bash 5.1 это ещё и «.» с «..»). Остальные шаблоны раскрывает сам just-bash.
// Раскрытие статическое — до выполнения всей строки: `mkdir d; ls -d */` в одной строке увидит каталоги, какие были до неё.
// Работает над текстом команды: находит «голые» слова-шаблоны, раскрывает их по ФС мира и подставляет результат в кавычках.
import type { World } from "./world";
import { resolve } from "./path";
import { shq } from "./util";

const POSIX_CLASSES: Record<string, string> = {
  alpha: "A-Za-z", digit: "0-9", alnum: "A-Za-z0-9", upper: "A-Z", lower: "a-z", space: " \\t\\n\\r\\f\\v", punct: "!-\\/:-@\\[-`{-~", xdigit: "0-9A-Fa-f", blank: " \\t",
};

/** Шаблон одного сегмента пути → RegExp (`*`, `?`, `[...]`, `[!...]`, `[[:alpha:]]`). */
export function segmentRegex(pat: string): RegExp {
  let re = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      if (pat[j] === "!" || pat[j] === "^") j++;
      if (pat[j] === "]") j++;
      while (j < pat.length && pat[j] !== "]") {
        if (pat[j] === "[" && pat[j + 1] === ":") {
          const end = pat.indexOf(":]", j + 2);
          if (end > 0) {
            j = end + 2;
            continue;
          }
        }
        j++;
      }
      if (j >= pat.length) {
        re += "\\[";
        continue;
      }
      let body = pat.slice(i + 1, j);
      let neg = "";
      if (body[0] === "!" || body[0] === "^") {
        neg = "^";
        body = body.slice(1);
      }
      body = body.replace(/\[:(\w+):\]/g, (_m, n: string) => POSIX_CLASSES[n] ?? "").replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
      re += `[${neg}${body}]`;
      i = j;
    } else re += c.replace(/[.+^${}()|\\/]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "s");
}

/** Раскрыть шаблон; dirsOnly — шаблон оканчивался на «/». Пусто — нет совпадений. */
async function expandPattern(w: World, cwd: string, pattern: string, dirsOnly: boolean): Promise<string[]> {
  const abs = pattern.startsWith("/");
  const segs = pattern.split("/").filter((x) => x !== "");
  let results: string[] = [abs ? "/" : ""];
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    const last = si === segs.length - 1;
    const next: string[] = [];
    for (const prefix of results) {
      const dirPath = resolve(cwd, prefix || ".");
      if (!/[*?[]/.test(seg)) {
        const cand = prefix + seg + (last ? "" : "/");
        const inf = await w.info(resolve(cwd, cand), true);
        if (inf && (last ? !dirsOnly || inf.isDir : inf.isDir)) next.push(prefix + seg + (last ? "" : "/"));
        continue;
      }
      let names: string[] = [];
      try {
        names = await w.base.readdir(dirPath);
      } catch {
        continue;
      }
      if (seg.startsWith(".")) names = [".", "..", ...names];
      const re = segmentRegex(seg);
      for (const n of names.sort()) {
        if (n.startsWith(".") && !seg.startsWith(".")) continue;
        if (!re.test(n)) continue;
        const inf = await w.info(resolve(cwd, prefix + n), true);
        if (!inf) continue;
        if (!last && !inf.isDir) continue;
        if (last && dirsOnly && !inf.isDir) continue;
        next.push(prefix + n + (last ? "" : "/"));
      }
    }
    results = next;
    if (!results.length) return [];
  }
  return results.map((r) => (dirsOnly ? r.replace(/\/*$/, "") + "/" : r));
}

/**
 * Подставить раскрытие в слова, которые just-bash раскрывает неверно. Слова с кавычками, `$`, `~`, `{}`, `\` и
 * команды с `case`/`[[` не трогаем. Если совпадений нет — слово остаётся (bash передаст шаблон как есть).
 */
export async function fixGlobs(w: World, cwd: string, line: string): Promise<string> {
  if (!/[*?[]/.test(line) || /\[\[|\bcase\b/.test(line)) return line;
  let out = "";
  let i = 0;
  let wordStart = -1;
  let word = "";
  let dirty = false; // слово содержит кавычки/спецсимволы — не трогаем
  const flush = async () => {
    if (wordStart < 0) return;
    let rep = word;
    if (!dirty && /[*?[]/.test(word) && !/^[A-Za-z_]\w*=/.test(word)) {
      const dirsOnly = word.length > 1 && word.endsWith("/");
      const literalExists = !dirsOnly && !!(await w.info(resolve(cwd, word)));
      // `.*` в bash 5.1 (RHEL 9) раскрывается и в «.», «..» — классическая ловушка с `rm -r .*`
      const dotPattern = /(^|\/)\.[^/]*[*?[]/.test(word);
      if (dirsOnly || literalExists || dotPattern) {
        const found = await expandPattern(w, cwd, word, dirsOnly);
        if (found.length) rep = found.map(shq).join(" ");
      }
    }
    out += rep;
    wordStart = -1;
    word = "";
    dirty = false;
  };
  while (i < line.length) {
    const c = line[i];
    if (c === "'" || c === '"' || c === "`" || c === "\\" || c === "$" || c === "~" || c === "{") {
      // слово со «сложным» синтаксисом: копируем его до конца как есть
      if (wordStart < 0) wordStart = i;
      dirty = true;
      word += c;
      i++;
      if (c === "'" || c === '"' || c === "`") {
        const end = line.indexOf(c, i);
        const stop = end < 0 ? line.length : end + 1;
        word += line.slice(i, stop);
        i = stop;
      } else if (c === "\\" && i < line.length) {
        word += line[i++];
      } else if (c === "$" && line[i] === "(") {
        let depth = 0;
        while (i < line.length) {
          const d = line[i];
          word += d;
          i++;
          if (d === "(") depth++;
          else if (d === ")" && --depth === 0) break;
        }
      } else if ((c === "$" || c === "{") && line[i] === "{") {
        const end = line.indexOf("}", i);
        const stop = end < 0 ? line.length : end + 1;
        word += line.slice(i, stop);
        i = stop;
      }
      continue;
    }
    if (/[\s|&;()<>]/.test(c)) {
      await flush();
      out += c;
      i++;
      continue;
    }
    if (c === "#" && wordStart < 0) {
      out += line.slice(i); // комментарий до конца строки
      i = line.length;
      break;
    }
    if (wordStart < 0) wordStart = i;
    word += c;
    i++;
  }
  await flush();
  return out;
}
