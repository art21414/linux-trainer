// POSIX ACL: модель (по inode), разбор записей setfacl, вывод getfacl, проверка доступа.
export interface DefAcl {
  user: number;
  group: number;
  other: number;
  users: Map<number, number>;
  groups: Map<number, number>;
  mask: number;
}

/** Расширенный ACL файла. Базовые user::/other:: живут в mode, group:: — в groupObj, группа в mode = mask. */
export interface Acl {
  users: Map<number, number>;
  groups: Map<number, number>;
  mask: number;
  groupObj: number;
  def?: DefAcl;
}

export const extended = (a: Acl | undefined): boolean => !!a && (a.users.size > 0 || a.groups.size > 0);

export function cloneAcl(a: Acl): Acl {
  return {
    users: new Map(a.users),
    groups: new Map(a.groups),
    mask: a.mask,
    groupObj: a.groupObj,
    def: a.def ? { ...a.def, users: new Map(a.def.users), groups: new Map(a.def.groups) } : undefined,
  };
}

export const permStr = (p: number) => (p & 4 ? "r" : "-") + (p & 2 ? "w" : "-") + (p & 1 ? "x" : "-");

export interface Entry {
  def: boolean;
  kind: "user" | "group" | "mask" | "other";
  name: string; // "" — безымянная запись (user::, group::)
  id?: number;
  perm: number | null; // null — без прав (для -x)
}

/** Разобрать одну запись `[d:]u:alice:rwx`. Ошибка — «Invalid argument near character N». */
export function parseEntry(
  spec: string,
  forRemove: boolean,
  lookup: (kind: "user" | "group", name: string) => number | undefined,
): Entry | { err: number } {
  let rest = spec;
  let pos = 0;
  let def = false;
  const dm = /^(d|default):/.exec(rest);
  if (dm) {
    def = true;
    rest = rest.slice(dm[0].length);
    pos += dm[0].length;
  }
  const parts = rest.split(":");
  const kinds: Record<string, Entry["kind"]> = { u: "user", user: "user", g: "group", group: "group", m: "mask", mask: "mask", o: "other", other: "other" };
  const kind = kinds[parts[0]];
  if (!kind) return { err: pos + 1 };
  let name = "";
  let permText: string | undefined;
  if (kind === "user" || kind === "group") {
    if (parts.length < 2) return { err: pos + parts[0].length + 1 };
    name = parts[1];
    permText = parts[2];
  } else {
    if (parts.length < 2) return { err: pos + parts[0].length + 1 };
    if (parts[1] !== "") return { err: pos + parts[0].length + 2 };
    permText = parts[2];
  }
  let id: number | undefined;
  if (name) {
    id = /^\d+$/.test(name) ? Number(name) : lookup(kind as "user" | "group", name);
    if (id === undefined) return { err: pos + parts[0].length + 2 };
  }
  let perm: number | null = null;
  if (permText === undefined || permText === "") {
    if (!forRemove) return { err: pos + parts[0].length + (kind === "user" || kind === "group" ? parts[1].length + 3 : 2) + 1 };
  } else {
    const at = pos + parts[0].length + 1 + (kind === "user" || kind === "group" ? parts[1].length + 1 : 1) + 1;
    if (/^[0-7]$/.test(permText)) perm = Number(permText);
    else if (/^[rwx-]{1,3}$/.test(permText) || /^[rwxst-]+$/.test(permText)) {
      if (!/^[r-]?[w-]?[x-]?$/.test(permText)) return { err: at };
      perm = (permText.includes("r") ? 4 : 0) | (permText.includes("w") ? 2 : 0) | (permText.includes("x") ? 1 : 0);
    } else return { err: at };
  }
  return { def, kind, name, id, perm };
}

/** Права по ACL. cls — права (r/w/x) пользователя, или null, если ACL не определяет (тогда обычные биты). */
export function aclPerms(a: Acl, mode: number, fileUid: number, fileGid: number, uid: number, gids: Set<number>): number | null {
  if (!extended(a)) return null;
  if (uid === fileUid) return (mode >> 6) & 7;
  const nu = a.users.get(uid);
  if (nu !== undefined) return nu & a.mask;
  let matched = false;
  let acc = 0;
  if (gids.has(fileGid)) {
    matched = true;
    acc |= a.groupObj;
  }
  for (const [g, p] of a.groups) {
    if (gids.has(g)) {
      matched = true;
      acc |= p;
    }
  }
  if (matched) return acc & a.mask;
  return mode & 7;
}

/** getfacl: строки одного ACL (access + default). */
export function formatAcl(
  a: Acl | undefined,
  mode: number,
  isDir: boolean,
  names: { user: (id: number) => string; group: (id: number) => string },
  ownerName: string,
  groupName: string,
  opts: { access: boolean; defaults: boolean },
): string {
  let out = "";
  const eff = (perm: number, mask: number) => (perm & ~mask & 7 ? `\t#effective:${permStr(perm & mask)}` : "");
  if (opts.access) {
    const ext = extended(a);
    out += `user::${permStr((mode >> 6) & 7)}\n`;
    if (ext) for (const [id, p] of [...a!.users].sort((x, y) => x[0] - y[0])) out += `user:${names.user(id)}:${permStr(p)}${eff(p, a!.mask)}\n`;
    out += `group::${permStr(ext ? a!.groupObj : (mode >> 3) & 7)}${ext ? eff(a!.groupObj, a!.mask) : ""}\n`;
    if (ext) {
      for (const [id, p] of [...a!.groups].sort((x, y) => x[0] - y[0])) out += `group:${names.group(id)}:${permStr(p)}${eff(p, a!.mask)}\n`;
      out += `mask::${permStr(a!.mask)}\n`;
    }
    out += `other::${permStr(mode & 7)}\n`;
  }
  if (opts.defaults && isDir && a?.def) {
    const d = a.def;
    out += `default:user::${permStr(d.user)}\n`;
    for (const [id, p] of [...d.users].sort((x, y) => x[0] - y[0])) out += `default:user:${names.user(id)}:${permStr(p)}${eff(p, d.mask)}\n`;
    out += `default:group::${permStr(d.group)}${d.users.size || d.groups.size ? eff(d.group, d.mask) : ""}\n`;
    for (const [id, p] of [...d.groups].sort((x, y) => x[0] - y[0])) out += `default:group:${names.group(id)}:${permStr(p)}${eff(p, d.mask)}\n`;
    out += `default:mask::${permStr(d.mask)}\n`;
    out += `default:other::${permStr(d.other)}\n`;
  }
  void ownerName;
  void groupName;
  return out;
}
