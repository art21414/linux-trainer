// «Мир» — модель сервера поверх виртуальной ФС just-bash.
// just-bash хранит только содержимое и права (mode). Владельцев, группы,
// пользователей, umask и проверку доступа держим здесь.
import { InMemoryFs } from "just-bash";
import type { IFileSystem } from "just-bash";
import { normalize, dirname } from "./path";

export interface User {
  name: string;
  uid: number;
  gid: number; // основная группа
  groups: string[]; // дополнительные группы (имена)
  home: string;
  shell: string;
  comment: string;
}

export interface Group {
  name: string;
  gid: number;
}

export interface Owner {
  uid: number;
  gid: number;
}

export interface NodeInfo {
  path: string;
  mode: number; // только биты прав (включая suid/sgid/sticky)
  uid: number;
  gid: number;
  isDir: boolean;
  isFile: boolean;
  isLink: boolean;
  size: number;
  mtime: Date;
}

export type Perm = "r" | "w" | "x";

export class FsError extends Error {
  code: string;
  constructor(code: string, op: string, path: string) {
    const text: Record<string, string> = {
      EACCES: "permission denied",
      EPERM: "operation not permitted",
      ENOENT: "no such file or directory",
    };
    super(`${code}: ${text[code] ?? code}, ${op} '${path}'`);
    this.code = code;
  }
}

export interface PendingSu {
  user: string;
  login: boolean;
}

export class World {
  readonly base = new InMemoryFs();
  readonly fs: IFileSystem;
  users = new Map<string, User>();
  groups = new Map<string, Group>();
  owners = new Map<string, Owner>();
  umask = 0o022;
  hostname = "server1.example.com";
  /** Текущий (эффективный) пользователь, от имени которого выполняются команды. */
  current = "root";
  /** Ширина терминала в символах (для ls в колонках). */
  cols = 40;
  /** Вывод идёт прямо на экран (нет пайпа/перенаправления) — для цветов и колонок ls. */
  tty = true;
  /** Запрос на смену пользователя от su/sudo -i; обрабатывает Shell. */
  pendingSu: PendingSu | null = null;
  /** Последняя «нереализованная» команда (для журнала). */
  unsupported: string[] = [];

  constructor() {
    this.fs = this.makeGuardedFs();
  }

  // ---------- пользователи и группы ----------

  get cur(): User {
    return this.users.get(this.current)!;
  }

  user(name: string): User | undefined {
    return this.users.get(name);
  }

  userByUid(uid: number): User | undefined {
    for (const u of this.users.values()) if (u.uid === uid) return u;
    return undefined;
  }

  group(name: string): Group | undefined {
    return this.groups.get(name);
  }

  groupByGid(gid: number): Group | undefined {
    for (const g of this.groups.values()) if (g.gid === gid) return g;
    return undefined;
  }

  /** Все gid пользователя: основная + дополнительные. */
  gidsOf(u: User): Set<number> {
    const s = new Set<number>([u.gid]);
    for (const name of u.groups) {
      const g = this.groups.get(name);
      if (g) s.add(g.gid);
    }
    return s;
  }

  /** Члены группы (дополнительные + у кого она основная). */
  membersOf(groupName: string): string[] {
    const g = this.groups.get(groupName);
    if (!g) return [];
    return [...this.users.values()].filter((u) => u.gid === g.gid || u.groups.includes(groupName)).map((u) => u.name);
  }

  addGroup(name: string, gid?: number): Group {
    const g = { name, gid: gid ?? this.nextId([...this.groups.values()].map((x) => x.gid)) };
    this.groups.set(name, g);
    return g;
  }

  async addUser(
    name: string,
    opts: { uid?: number; gid?: number; groups?: string[]; home?: string; shell?: string; comment?: string; createHome?: boolean } = {},
  ): Promise<User> {
    const uid = opts.uid ?? this.nextId([...this.users.values()].map((u) => u.uid));
    let gid = opts.gid;
    if (gid === undefined) {
      const g = this.groups.get(name) ?? this.addGroup(name, this.groupByGid(uid) ? undefined : uid);
      gid = g.gid;
    }
    const u: User = {
      name,
      uid,
      gid,
      groups: opts.groups ?? [],
      home: opts.home ?? `/home/${name}`,
      shell: opts.shell ?? "/bin/bash",
      comment: opts.comment ?? "",
    };
    this.users.set(name, u);
    if (opts.createHome !== false) {
      await this.mkdir(u.home, 0o700, uid, gid);
      for (const f of [".bash_logout", ".bash_profile", ".bashrc"]) {
        await this.write(`${u.home}/${f}`, `# ${f}\n`, 0o644, uid, gid);
      }
    }
    await this.syncEtc();
    return u;
  }

  private nextId(used: number[]): number {
    let id = 1000;
    while (used.includes(id)) id++;
    return id;
  }

  /** Перегенерировать /etc/passwd и /etc/group из модели. */
  async syncEtc(): Promise<void> {
    const passwd = [...this.users.values()]
      .sort((a, b) => a.uid - b.uid)
      .map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.comment}:${u.home}:${u.shell}`)
      .join("\n");
    const group = [...this.groups.values()]
      .sort((a, b) => a.gid - b.gid)
      .map((g) => {
        const members = [...this.users.values()].filter((u) => u.groups.includes(g.name)).map((u) => u.name);
        return `${g.name}:x:${g.gid}:${members.join(",")}`;
      })
      .join("\n");
    await this.write("/etc/passwd", passwd + "\n", 0o644, 0, 0);
    await this.write("/etc/group", group + "\n", 0o644, 0, 0);
  }

  // ---------- метаданные и привилегированные операции (без проверок) ----------

  owner(path: string): Owner {
    return this.owners.get(normalize(path)) ?? { uid: 0, gid: 0 };
  }

  async info(path: string, follow = false): Promise<NodeInfo | null> {
    const p = normalize(path);
    try {
      const s = follow ? await this.base.stat(p) : await this.base.lstat(p);
      const o = this.owner(p);
      return {
        path: p,
        mode: s.mode & 0o7777,
        uid: o.uid,
        gid: o.gid,
        isDir: s.isDirectory,
        isFile: s.isFile,
        isLink: s.isSymbolicLink,
        size: s.size,
        mtime: s.mtime,
      };
    } catch {
      return null;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.base.exists(normalize(path));
  }

  async mkdir(path: string, mode = 0o755, uid = 0, gid = 0): Promise<void> {
    const p = normalize(path);
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (const part of parts) {
      cur += "/" + part;
      if (!(await this.base.exists(cur))) {
        await this.base.mkdir(cur);
        await this.base.chmod(cur, mode);
        this.owners.set(cur, { uid, gid });
      }
    }
    await this.base.chmod(p, mode);
    this.owners.set(p, { uid, gid });
  }

  async write(path: string, content: string, mode = 0o644, uid = 0, gid = 0): Promise<void> {
    const p = normalize(path);
    const dir = dirname(p);
    if (!(await this.base.exists(dir))) await this.mkdir(dir);
    await this.base.writeFile(p, content);
    await this.base.chmod(p, mode);
    this.owners.set(p, { uid, gid });
  }

  async read(path: string): Promise<string | null> {
    try {
      return await this.base.readFile(normalize(path));
    } catch {
      return null;
    }
  }

  async setMode(path: string, mode: number): Promise<void> {
    await this.base.chmod(normalize(path), mode);
  }

  setOwner(path: string, uid: number, gid: number): void {
    this.owners.set(normalize(path), { uid, gid });
  }

  /** Все пути внутри каталога (включая сам каталог). */
  subtree(path: string): string[] {
    const p = normalize(path);
    const prefix = p === "/" ? "/" : p + "/";
    return this.base.getAllPaths().filter((x) => x === p || x.startsWith(prefix));
  }

  // ---------- проверка доступа ----------

  /** Есть ли у пользователя право perm на сам объект (без проверки родителей). */
  permOn(info: NodeInfo, perm: Perm, u: User = this.cur): boolean {
    const bit = perm === "r" ? 4 : perm === "w" ? 2 : 1;
    if (u.uid === 0) {
      if (perm !== "x") return true;
      return info.isDir || (info.mode & 0o111) !== 0;
    }
    let cls: number;
    if (u.uid === info.uid) cls = (info.mode >> 6) & 7;
    else if (this.gidsOf(u).has(info.gid)) cls = (info.mode >> 3) & 7;
    else cls = info.mode & 7;
    return (cls & bit) !== 0;
  }

  /** Можно ли «пройти» до пути: x на всех каталогах-предках. */
  async canTraverse(path: string, u: User = this.cur): Promise<boolean> {
    if (u.uid === 0) return true;
    const parts = normalize(path).split("/").filter(Boolean);
    let cur = "/";
    // x нужен на каждом предке (сам объект не проверяем)
    for (let i = 0; i < parts.length; i++) {
      const inf = await this.info(cur, true);
      if (!inf) return true; // несуществующее — разберётся сама команда
      if (!this.permOn(inf, "x", u)) return false;
      cur = cur === "/" ? "/" + parts[i] : cur + "/" + parts[i];
    }
    return true;
  }

  /** Полная проверка доступа: путь проходим + право на сам объект. */
  async canAccess(path: string, perm: Perm, u: User = this.cur): Promise<boolean> {
    if (!(await this.canTraverse(path, u))) return false;
    const inf = await this.info(path, true);
    if (!inf) return false;
    return this.permOn(inf, perm, u);
  }

  /** Может ли пользователь создать/удалить запись в каталоге dir. */
  async canModifyDir(dir: string, u: User = this.cur): Promise<boolean> {
    return (await this.canAccess(dir, "w", u)) && (await this.canAccess(dir, "x", u));
  }

  // ---------- «охраняемая» ФС: её видят команды just-bash ----------

  private makeGuardedFs(): IFileSystem {
    const base = this.base;
    const w = this;
    const deny = (op: string, p: string): never => {
      throw new FsError("EACCES", op, p);
    };
    const isRoot = () => w.cur.uid === 0;

    const guardRead = async (p: string, op = "open") => {
      if (isRoot()) return;
      if (!(await base.exists(p))) return;
      const inf = await w.info(p, true);
      if (inf?.isDir) return; // ошибку «Is a directory» отдаст сама ФС
      if (!(await w.canAccess(p, "r"))) deny(op, p);
    };
    const guardCreate = async (p: string, op = "open") => {
      if (isRoot()) return;
      const dir = dirname(p);
      if (!(await base.exists(dir))) return;
      if (!(await w.canModifyDir(dir))) deny(op, p);
    };
    const guardWriteOrCreate = async (p: string) => {
      if (isRoot()) return;
      if (await base.exists(p)) {
        if (!(await w.canAccess(p, "w"))) deny("open", p);
      } else await guardCreate(p);
    };
    const guardDelete = async (p: string, op = "unlink") => {
      if (isRoot()) return;
      const dir = dirname(p);
      if (!(await w.canModifyDir(dir))) deny(op, p);
      const di = await w.info(dir, true);
      const fi = await w.info(p);
      // sticky bit: удалять может только владелец файла/каталога
      if (di && fi && di.mode & 0o1000 && w.cur.uid !== fi.uid && w.cur.uid !== di.uid) deny(op, p);
    };
    const onCreate = async (p: string, kind: "file" | "dir" | "link") => {
      const dir = dirname(p);
      const di = await w.info(dir, true);
      const setgid = !!di && (di.mode & 0o2000) !== 0;
      const gid = setgid && di ? di.gid : w.cur.gid;
      w.owners.set(p, { uid: w.cur.uid, gid });
      if (kind === "file") await base.chmod(p, 0o666 & ~w.umask);
      if (kind === "dir") await base.chmod(p, (0o777 & ~w.umask) | (setgid ? 0o2000 : 0));
    };
    const dropTree = (p: string) => {
      const prefix = p === "/" ? "/" : p + "/";
      for (const k of [...w.owners.keys()]) if (k === p || k.startsWith(prefix)) w.owners.delete(k);
    };

    const hooks: Record<string, (...a: any[]) => Promise<unknown>> = {
      async readFile(p: string, o?: unknown) {
        await guardRead(normalize(p));
        return base.readFile(p, o as never);
      },
      async readFileBytes(p: string) {
        await guardRead(normalize(p));
        return base.readFileBytes(p);
      },
      async readFileBuffer(p: string) {
        await guardRead(normalize(p));
        return base.readFileBuffer(p);
      },
      async writeFile(p: string, c: unknown, o?: unknown) {
        const n = normalize(p);
        const existed = await base.exists(n);
        await guardWriteOrCreate(n);
        await base.writeFile(p, c as never, o as never);
        if (!existed) await onCreate(n, "file");
      },
      async appendFile(p: string, c: unknown, o?: unknown) {
        const n = normalize(p);
        const existed = await base.exists(n);
        await guardWriteOrCreate(n);
        await base.appendFile(p, c as never, o as never);
        if (!existed) await onCreate(n, "file");
      },
      async createExclusive(p: string, o: { mode: number; directory?: boolean }) {
        const n = normalize(p);
        await guardCreate(n);
        await base.createExclusive(p, o);
        await onCreate(n, o.directory ? "dir" : "file");
        await base.chmod(n, o.mode & ~w.umask);
      },
      async mkdir(p: string, o?: { recursive?: boolean }) {
        const n = normalize(p);
        const parts = n.split("/").filter(Boolean);
        const missing: string[] = [];
        let cur = "";
        for (const part of parts) {
          cur += "/" + part;
          if (!(await base.exists(cur))) missing.push(cur);
        }
        if (missing.length) await guardCreate(missing[0], "mkdir");
        await base.mkdir(p, o as never);
        for (const m of missing) if (await base.exists(m)) await onCreate(m, "dir");
      },
      async readdir(p: string) {
        const n = normalize(p);
        if (!isRoot() && (await base.exists(n)) && !(await w.canAccess(n, "r"))) deny("scandir", n);
        return base.readdir(p);
      },
      async readdirWithFileTypes(p: string) {
        const n = normalize(p);
        if (!isRoot() && (await base.exists(n)) && !(await w.canAccess(n, "r"))) deny("scandir", n);
        return base.readdirWithFileTypes(p);
      },
      async rm(p: string, o?: { recursive?: boolean; force?: boolean }) {
        const n = normalize(p);
        if (n === "/") deny("rm", n);
        await guardDelete(n);
        await base.rm(p, o as never);
        dropTree(n);
      },
      async cp(src: string, dest: string, o?: { recursive?: boolean }) {
        const s = normalize(src);
        const d = normalize(dest);
        await guardRead(s);
        await guardWriteOrCreate(d);
        const before = new Set(base.getAllPaths());
        await base.cp(src, dest, o as never);
        for (const x of base.getAllPaths()) {
          if (!before.has(x) || x === d) w.owners.set(x, { uid: w.cur.uid, gid: w.cur.gid });
        }
      },
      async mv(src: string, dest: string) {
        const s = normalize(src);
        let d = normalize(dest);
        await guardDelete(s, "rename");
        const dInfo = await w.info(d, true);
        if (dInfo?.isDir) d = (d === "/" ? "" : d) + "/" + s.split("/").pop();
        await guardCreate(d, "rename");
        const moved: [string, Owner][] = [];
        const prefix = s + "/";
        for (const [k, v] of w.owners) if (k === s || k.startsWith(prefix)) moved.push([k, v]);
        await base.mv(src, dest);
        for (const [k] of moved) w.owners.delete(k);
        const finalDest = (await base.exists(d)) ? d : normalize(dest);
        for (const [k, v] of moved) w.owners.set(finalDest + k.slice(s.length), v);
      },
      async chmod(p: string, mode: number) {
        const n = normalize(p);
        const inf = await w.info(n, true);
        if (inf && !isRoot() && inf.uid !== w.cur.uid) throw new FsError("EPERM", "chmod", n);
        return base.chmod(p, mode);
      },
      async symlink(target: string, link: string) {
        const n = normalize(link);
        await guardCreate(n, "symlink");
        await base.symlink(target, link);
        await onCreate(n, "link");
      },
      async link(existing: string, np: string) {
        const n = normalize(np);
        await guardCreate(n, "link");
        await base.link(existing, np);
        const o = w.owner(existing);
        w.owners.set(n, o);
      },
      async utimes(p: string, a: Date, m: Date) {
        const n = normalize(p);
        if (!isRoot()) {
          const inf = await w.info(n, true);
          if (inf && inf.uid !== w.cur.uid && !(await w.canAccess(n, "w"))) deny("utime", n);
        }
        return base.utimes(p, a, m);
      },
      async stat(p: string) {
        const n = normalize(p);
        if (!isRoot() && !(await w.canTraverse(n))) deny("stat", n);
        return base.stat(p);
      },
      async lstat(p: string) {
        const n = normalize(p);
        if (!isRoot() && !(await w.canTraverse(n))) deny("lstat", n);
        return base.lstat(p);
      },
    };

    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop in hooks) return hooks[prop];
        const v = Reflect.get(target, prop, receiver);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as IFileSystem;
  }
}
