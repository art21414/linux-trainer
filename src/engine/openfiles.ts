// Открытые файлы процессов и «удалённые, но открытые» файлы.
//
// Процесс может держать файл открытым (fd). Если имя файла удалить (rm), inode живёт, пока есть дескриптор:
// df считает занятое место, du (ходит по именам) — нет. Модель: при rm последней ссылки на файл, открытый
// процессом, данные переезжают в служебный каталог /proc/.held/<inode> (имя исчезает из дерева, место остаётся
// записанным за исходной ФС). Дескрипторы видны как /proc/PID/fd/N -> /путь (deleted); через них файл можно
// читать, обнулять (`: > /proc/PID/fd/N` освобождает место) и копировать обратно (`cp /proc/PID/fd/N /путь`).
// Процесс завершился (kill, systemctl restart) — дескрипторы закрыты, место освобождено.
import type { World } from "./world";
import { dirname, normalize } from "./path";

export type FdMode = "r" | "w" | "a" | "rw";

export interface FdEntry {
  fd: number;
  /** Путь файла на момент открытия. */
  path: string;
  mode: FdMode;
  ino: number;
  /** После rm: служебный путь, где лежат данные. */
  held?: string;
  /** SIGHUP заставляет демон переоткрыть файл (как rsyslog/nginx при logrotate). */
  reopenOnHup: boolean;
}

export interface HeldFile {
  ino: number;
  hidden: string;
  /** Где файл лежал до удаления. */
  orig: string;
  /** id монтирования исходной ФС: на него записывается занятое место. */
  mountId: number;
}

export const HELD_DIR = "/proc/.held";

export interface HoldOpts {
  fd?: number;
  mode?: FdMode;
  /** По умолчанию true: SIGHUP заставит процесс переоткрыть файл (см. FdEntry.reopenOnHup). */
  reopenOnHup?: boolean;
}

export type HoldWho = number | string | { service: string; cmd?: string; user?: string };

export class OpenFiles {
  private fds = new Map<number, FdEntry[]>();
  readonly held = new Map<number, HeldFile>();

  constructor(private w: World) {}

  /** Дескрипторы процесса (кроме 0–2). */
  list(pid: number): FdEntry[] {
    return this.fds.get(pid) ?? [];
  }

  allPids(): number[] {
    return [...this.fds.keys()];
  }

  heldByPath(hidden: string): HeldFile | undefined {
    for (const h of this.held.values()) if (h.hidden === hidden) return h;
    return undefined;
  }

  /**
   * Процесс открыл файл. who: pid, имя службы/процесса (создаётся, если нет) или { service, cmd, user }.
   * Для заданий: `await w.holdOpen("rsyslogd", "/var/log/big.log")`.
   */
  async hold(who: HoldWho, path: string, opts: HoldOpts = {}): Promise<{ pid: number; fd: number }> {
    const w = this.w;
    const p = normalize(path);
    const inf = await w.info(p, true);
    if (!inf || !inf.isFile) throw new Error(`holdOpen: ${path} — нет такого обычного файла`);
    const pid = this.resolvePid(who);
    const list = this.fds.get(pid) ?? [];
    let fd = opts.fd ?? 3;
    if (opts.fd === undefined) while (list.some((e) => e.fd === fd)) fd++;
    else if (list.some((e) => e.fd === fd)) throw new Error(`holdOpen: fd ${fd} уже занят у pid ${pid}`);
    list.push({ fd, path: p, mode: opts.mode ?? "w", ino: w.inodes.ino(p), reopenOnHup: opts.reopenOnHup ?? true });
    list.sort((a, b) => a.fd - b.fd);
    this.fds.set(pid, list);
    w.procs.version++;
    return { pid, fd };
  }

  private resolvePid(who: HoldWho): number {
    const w = this.w;
    if (typeof who === "number") {
      if (!w.procs.isAlive(who)) throw new Error(`holdOpen: нет процесса ${who}`);
      return who;
    }
    const spec = typeof who === "string" ? { service: who, cmd: undefined, user: undefined } : who;
    const known = w.services.get(spec.service);
    if (known && w.procs.isAlive(known.pid)) return known.pid;
    const byComm = typeof who === "string" ? w.procs.byName(who)[0] : undefined;
    if (byComm) return byComm.pid;
    const cmd = spec.cmd ?? `/usr/sbin/${spec.service} -n`;
    const user = spec.user ?? "root";
    const pid = w.procs.spawn({ cmd, user, ppid: 1, handlesHup: true, leader: true });
    w.services.set(spec.service, { unit: spec.service, cmd, user, pid });
    return pid;
  }

  /** Есть ли у файла (по inode) открытые дескрипторы. */
  private holders(ino: number): FdEntry[] {
    const r: FdEntry[] = [];
    for (const list of this.fds.values()) for (const e of list) if (e.ino === ino && !e.held) r.push(e);
    return r;
  }

  /**
   * Перед удалением имени файла: если это последняя ссылка и файл открыт процессом — переносим данные в служебный каталог.
   * true — файл «ушёл» из дерева, rm делать не нужно.
   */
  async onUnlink(path: string): Promise<boolean> {
    if (!this.fds.size) return false;
    const w = this.w;
    const p = normalize(path);
    const inf = await w.info(p);
    if (!inf || inf.isDir || inf.isLink) return false;
    const ino = w.inodes.ino(p);
    const holders = this.holders(ino);
    if (!holders.length || w.inodes.names(p).length > 1) return false;
    const hidden = `${HELD_DIR}/${ino}`;
    const mountId = w.storage.mountFor(p).id;
    if (!(await w.base.exists(HELD_DIR))) await w.mkdir(HELD_DIR, 0o700);
    await w.base.mv(p, hidden);
    const owner = w.owner(p);
    w.owners.delete(p);
    w.owners.set(hidden, owner);
    const v = w.storage.virt.get(p);
    if (v) {
      w.storage.virt.delete(p);
      w.storage.virt.set(hidden, v);
    }
    w.inodes.rename(p, hidden);
    this.held.set(ino, { ino, hidden, orig: p, mountId });
    for (const e of holders) e.held = hidden;
    w.procs.version++;
    return true;
  }

  /** Целиком удаляемое дерево: перенести открытые файлы из него. */
  async onUnlinkTree(path: string): Promise<void> {
    if (!this.fds.size) return;
    for (const p of this.w.subtree(path)) await this.onUnlink(p);
  }

  /** Закрыть дескрипторы процесса (процесс завершился). Освободившиеся «удалённые» файлы исчезают. */
  release(pid: number): void {
    const list = this.fds.get(pid);
    if (!list) return;
    this.fds.delete(pid);
    for (const e of list) this.dropIfUnused(e);
    this.w.procs.version++;
  }

  private dropIfUnused(e: FdEntry): void {
    if (!e.held) return;
    for (const l of this.fds.values()) if (l.some((x) => x.ino === e.ino && x.held)) return;
    const h = this.held.get(e.ino);
    if (!h) return;
    this.held.delete(e.ino);
    const w = this.w;
    // место освобождается сразу (accounting смотрит на this.held), сами данные убираем следом
    void w.base.rm(h.hidden, { force: true }).then(() => {
      w.storage.virt.delete(h.hidden);
      w.owners.delete(h.hidden);
      w.inodes.forget(h.hidden);
    });
  }

  /** SIGHUP: демон переоткрывает файлы. Удалённые закрываются, исходный путь создаётся заново, как у rsyslog после logrotate. */
  async onHup(pid: number): Promise<void> {
    const list = this.fds.get(pid);
    if (!list) return;
    const w = this.w;
    const proc = w.procs.proc(pid);
    for (let k = 0; k < list.length; k++) {
      const e = list[k];
      if (!e.reopenOnHup || !e.held) continue;
      const old = { ...e };
      const orig = e.path;
      if (!(await w.exists(orig)) && (await w.exists(dirname(orig)))) {
        await w.write(orig, "", 0o600, proc?.uid ?? 0, proc?.gid ?? 0);
        w.stampCreate(orig);
      }
      list[k] = { fd: e.fd, path: orig, mode: e.mode, ino: w.inodes.ino(orig), reopenOnHup: true };
      this.dropIfUnused(old);
    }
    w.procs.version++;
  }

  /** Целевой путь символической ссылки в /proc/PID/fd: для удалённых файлов — «путь (deleted)». */
  displayTarget(target: string): string {
    if (!target.startsWith(HELD_DIR + "/")) return target;
    const h = this.heldByPath(target);
    return h ? `${h.orig} (deleted)` : target;
  }

  /** Обратное: путь из вывода «… (deleted)» → служебный путь (для readlink -f). */
  isHeld(target: string): boolean {
    return target.startsWith(HELD_DIR + "/");
  }
}
