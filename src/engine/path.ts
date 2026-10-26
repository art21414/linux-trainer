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

export function resolve(cwd: string, p: string): string {
  return normalize(p.startsWith("/") ? p : `${cwd}/${p}`);
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
