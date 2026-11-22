// Простые операции с путями (без разрешения симлинков).
export function normalize(p: string): string {
  const parts: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return "/" + parts.join("/");
}

/** Читатель симлинков (sync): путь → цель или null. Ставит World (см. activateWorldPaths). */
let linkReader: ((p: string) => string | null) | null = null;
export function setLinkReader(f: ((p: string) => string | null) | null): void {
  linkReader = f;
}

/**
 * Путь для внешних команд, как у ядра: cwd и промежуточные симлинки раскрываются, `..` — физический родитель.
 * Последний компонент остаётся как есть (lstat), кроме «.» в конце (это каталог). Логический `..` — только у builtin cd.
 */
function physical(parts: string[], forceFinal: boolean): string[] {
  const cur: string[] = [];
  let rest = parts;
  let hops = 0;
  while (rest.length) {
    const comp = rest[0];
    rest = rest.slice(1);
    if (comp === "..") {
      cur.pop();
      continue;
    }
    const t = linkReader!("/" + [...cur, comp].join("/"));
    if (t !== null && (rest.length > 0 || forceFinal) && ++hops <= 40) {
      rest = t.split("/").filter((x) => x && x !== ".").concat(rest);
      if (t.startsWith("/")) cur.length = 0;
      continue;
    }
    cur.push(comp);
  }
  return cur;
}

export function resolve(cwd: string, p: string): string {
  if (!linkReader) return normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
  const split = (x: string) => x.split("/").filter((c) => c && c !== ".");
  const base = p.startsWith("/") ? [] : physical(split(cwd), true);
  const forceFinal = /(^|\/)\.$/.test(p);
  return "/" + physical([...base, ...split(p)], forceFinal).join("/");
}

/** Физический путь целиком (все симлинки раскрыты, включая последний компонент), для `cd -P`. */
export function physicalPath(cwd: string, p: string): string {
  if (!linkReader) return resolve(cwd, p);
  const split = (x: string) => x.split("/").filter((c) => c && c !== ".");
  const base = p.startsWith("/") ? [] : split(cwd);
  return "/" + physical([...base, ...split(p)], true).join("/");
}

export function dirname(p: string): string {
  const n = normalize(p);
  if (n === "/") return "/";
  const i = n.lastIndexOf("/");
  return i <= 0 ? "/" : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalize(p);
  return n === "/" ? "/" : n.slice(n.lastIndexOf("/") + 1);
}
