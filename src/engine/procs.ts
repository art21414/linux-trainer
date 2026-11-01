// Таблица процессов: модель «свежего Rocky 9 сервера» + поведение сигналов.
// Вывод ps/top/pgrep и файлы /proc вычисляются из этой модели (commands/procs.ts).
import type { World } from "./world";

export type PState = "R" | "S" | "D" | "T" | "Z" | "I";

/** Сигналы Linux x86_64 (номер → имя без SIG). */
export const SIGNALS: [number, string][] = [
  [1, "HUP"], [2, "INT"], [3, "QUIT"], [4, "ILL"], [5, "TRAP"], [6, "ABRT"], [7, "BUS"], [8, "FPE"], [9, "KILL"],
  [10, "USR1"], [11, "SEGV"], [12, "USR2"], [13, "PIPE"], [14, "ALRM"], [15, "TERM"], [16, "STKFLT"], [17, "CHLD"],
  [18, "CONT"], [19, "STOP"], [20, "TSTP"], [21, "TTIN"], [22, "TTOU"], [23, "URG"], [24, "XCPU"], [25, "XFSZ"],
  [26, "VTALRM"], [27, "PROF"], [28, "WINCH"], [29, "IO"], [30, "PWR"], [31, "SYS"],
  ...Array.from({ length: 15 }, (_, i): [number, string] => [34 + i, `RTMIN${i ? "+" + i : ""}`]),
  ...Array.from({ length: 15 }, (_, i): [number, string] => [49 + i, `RTMAX-${14 - i}`]),
  [64, "RTMAX"],
];

export function sigName(n: number): string | undefined {
  return SIGNALS.find(([k]) => k === n)?.[1];
}

/** «TERM», «SIGTERM», «15», «term» → номер сигнала; 0 допустим; иначе undefined. */
export function sigNumber(spec: string | number): number | undefined {
  if (typeof spec === "number") return spec === 0 || sigName(spec) ? spec : undefined;
  if (/^\d+$/.test(spec)) {
    const n = Number(spec);
    return n === 0 || sigName(n) ? n : undefined;
  }
  const up = spec.toUpperCase().replace(/^SIG/, "");
  return SIGNALS.find(([, name]) => name === up)?.[0];
}

type SigAction = "term" | "stop" | "cont" | "ign";
function defaultAction(sig: number): SigAction {
  if ([19, 20, 21, 22].includes(sig)) return "stop";
  if (sig === 18) return "cont";
  if ([17, 23, 28].includes(sig)) return "ign";
  return "term";
}

export interface Proc {
  pid: number;
  ppid: number;
  uid: number;
  gid: number;
  /** Полная командная строка, как в /proc/PID/cmdline (для kernel-потоков — «[kthreadd]»). */
  cmd: string;
  comm: string;
  state: PState;
  nice: number;
  /** %CPU (число, как показывает ps). */
  cpu: number;
  /** Физическая память, КиБ. */
  rss: number;
  /** Виртуальная память, КиБ. */
  vsz: number;
  tty: string;
  start: number; // мс, Date.now()-эпоха
  /** Накопленное процессорное время, секунд (без учёта %CPU × время жизни). */
  cpuSec: number;
  kernel: boolean;
  /** Лидер сессии (s в STAT). */
  leader: boolean;
  threads: number;
  /** В foreground-группе терминала (+ в STAT). */
  fg: boolean;
  wchan: string;
  pgid: number;
  sid: number;
  /** Сигналы, которые процесс игнорирует (кроме KILL/STOP). */
  ignored: Set<number>;
  /** HUP перечитывает конфиг (демон), а не убивает. */
  handlesHup: boolean;
  /** Сколько раз процесс «перечитал конфиг» по HUP. */
  reloads: number;
  /** Получал ли сигналы (по номерам) — для тестов и заданий. */
  received: number[];
  /** Сигналы, отложенные, пока процесс остановлен (T). */
  pending: number[];
  /** Зомби будет убран, если родитель получит SIGCHLD (родитель «умеет wait»). */
  reapsOnChld: boolean;
  /** Секунд до естественного завершения (sleep N); undefined = работает вечно. */
  expiresAt?: number;
  /** Временный процесс (ps, grep из пайплайна) — удаляется после команды. */
  transient: boolean;
  env: Record<string, string>;
  cwd: string;
  /** Путь к исполняемому файлу (/proc/PID/exe). */
  exe: string;
  /** Временный процесс уже занят командой (ps в пайплайне). */
  claimed?: boolean;
}

export interface SpawnOpts {
  cmd: string;
  /** Имя или uid владельца; по умолчанию — текущий пользователь мира. */
  user?: string | number;
  ppid?: number;
  nice?: number;
  state?: PState;
  /** Игнорирует SIGTERM (убивается только -9). */
  ignoreTerm?: boolean;
  /** Игнорируемые сигналы (имена или номера). */
  ignore?: (string | number)[];
  /** SIGHUP = перечитать конфиг (как у sshd, crond…). */
  handlesHup?: boolean;
  cpu?: number;
  /** %MEM (от всей памяти). */
  mem?: number;
  rss?: number;
  vsz?: number;
  tty?: string;
  comm?: string;
  /** Создать зомби (state Z, cmd «[name] <defunct>»). */
  zombie?: boolean;
  reapsOnChld?: boolean;
  start?: number | Date;
  cpuSec?: number;
  /** Секунд до самозавершения. */
  lifetime?: number;
  fg?: boolean;
  wchan?: string;
  transient?: boolean;
  threads?: number;
  kernel?: boolean;
  leader?: boolean;
  cwd?: string;
}

export const MEM_TOTAL_KB = 3_724_228;

export interface KillResult {
  ok: boolean;
  /** "ESRCH" — нет такого процесса, "EPERM" — нельзя. */
  err?: "ESRCH" | "EPERM";
}

export interface Job {
  id: number;
  pid: number;
  cmd: string;
  /** Running | Stopped | Done | Terminated | Killed | ... */
  status: string;
  notified: boolean;
}

const SYS_NAMES: Record<number, string> = { 81: "dbus", 995: "chrony", 998: "polkitd", 74: "sshd", 65534: "nobody" };

export class ProcTable {
  readonly procs = new Map<number, Proc>();
  nextPid = 1480;
  bootAt = Date.now() - (2 * 86400 + 3 * 3600 + 17 * 60) * 1000;
  jobs: Job[] = [];
  /** Изменялась ли таблица (для пересборки /proc). */
  version = 0;
  /** Журнал завершённых процессов: pid → номер сигнала (0 — штатно). */
  exited = new Map<number, number>();
  private bgLast = 0;

  constructor(private w: World) {
    this.boot();
  }

  // ---------- загрузка «свежего сервера» ----------

  private boot() {
    const t = this.bootAt;
    const k = (pid: number, name: string, extra: Partial<SpawnOpts> = {}) =>
      this.add({ cmd: `[${name}]`, comm: name, ppid: pid === 2 ? 0 : 2, user: 0, kernel: true, rss: 0, vsz: 0, start: t, nice: 0, state: "S", ...extra }, pid);
    this.add(
      { cmd: "/usr/lib/systemd/systemd --switched-root --system --deserialize 31", comm: "systemd", ppid: 0, user: 0, rss: 14188, vsz: 174532, start: t + 2000, state: "S", leader: true, wchan: "ep_pol", cpuSec: 8 },
      1,
    );
    k(2, "kthreadd", { wchan: "kthread" });
    k(3, "rcu_gp", { state: "I", nice: -20 });
    k(4, "rcu_par_gp", { state: "I", nice: -20 });
    k(5, "slub_flushwq", { state: "I", nice: -20 });
    k(6, "netns", { state: "I", nice: -20 });
    k(8, "kworker/0:0H-events_highpri", { state: "I", nice: -20 });
    k(10, "mm_percpu_wq", { state: "I", nice: -20 });
    k(13, "ksoftirqd/0", { cpuSec: 3 });
    k(14, "rcu_preempt", { state: "I", cpuSec: 11 });
    k(15, "migration/0");
    k(16, "cpuhp/0");
    k(25, "kdevtmpfs");
    k(49, "kauditd");
    k(78, "kswapd0");
    k(158, "kworker/0:2-events", { state: "I" });
    k(205, "kworker/0:1H-kblockd", { state: "I", nice: -20 });
    const sys = (pid: number, cmd: string, user: number, extra: Partial<SpawnOpts> = {}) =>
      this.add({ cmd, user, ppid: 1, start: t + 9000 + pid * 12, state: "S", handlesHup: false, ...extra }, pid);
    sys(589, "/usr/lib/systemd/systemd-journald", 0, { rss: 17860, vsz: 41404, cpuSec: 21, handlesHup: true, leader: true });
    sys(622, "/usr/lib/systemd/systemd-udevd", 0, { rss: 12628, vsz: 33560, cpuSec: 2, handlesHup: true, leader: true });
    sys(679, "/sbin/auditd", 0, { rss: 5520, vsz: 14396, threads: 2, cpuSec: 4, handlesHup: true, leader: true });
    sys(727, "/usr/sbin/rsyslogd -n", 0, { rss: 7704, vsz: 222896, threads: 3, cpuSec: 1, handlesHup: true, leader: true });
    sys(731, "/usr/lib/systemd/systemd-logind", 0, { rss: 8744, vsz: 21084, leader: true, cpuSec: 1 });
    sys(733, "/usr/bin/dbus-broker-launch --scope system --audit", 81, { rss: 4320, vsz: 8692, leader: true });
    sys(738, "dbus-broker --log 4 --controller 9 --machine-id 1a2b3c4d5e6f47a8b9c0d1e2f3a4b5c6 --max-bytes 536870912 --max-fds 4096 --max-matches 131072 --audit", 81, { ppid: 733, rss: 3072, vsz: 7716 });
    sys(745, "/usr/sbin/NetworkManager --no-daemon", 0, { rss: 19740, vsz: 337700, threads: 3, cpuSec: 9, handlesHup: true, leader: true });
    sys(751, "/usr/sbin/chronyd -F 2", 995, { rss: 3892, vsz: 82340, handlesHup: false, leader: true });
    sys(760, "/usr/lib/polkit-1/polkitd --no-debug", 998, { rss: 14836, vsz: 2222292, threads: 3, leader: true });
    sys(764, "/usr/sbin/crond -n", 0, { rss: 3392, vsz: 224764, handlesHup: true, leader: true });
    sys(768, "/usr/sbin/sshd -D [listener] 0 of 10-100 startups", 0, { comm: "sshd", rss: 7060, vsz: 16228, handlesHup: true, leader: true, wchan: "do_sel" });
    sys(772, "/sbin/agetty -o -p -- \\u --noclear - linux", 0, { comm: "agetty", tty: "tty1", rss: 1912, vsz: 5628, leader: true, fg: true });
    sys(776, "/usr/sbin/tuned -Es /usr/sbin/tuned -l -P", 0, { comm: "tuned", rss: 28812, vsz: 424948, threads: 4, cpuSec: 5, leader: true });
    this.version++;
  }

  // ---------- создание процессов ----------

  /** Порядковый PID без процесса (каждый запуск команды в Linux «съедает» PID). */
  bump(n = 1): void {
    this.nextPid += n;
  }

  private add(o: SpawnOpts, forcePid?: number): number {
    const w = this.w;
    const pid = forcePid ?? this.nextPid++;
    let uid = 0;
    if (typeof o.user === "number") uid = o.user;
    else if (typeof o.user === "string") uid = w.user(o.user)?.uid ?? 0;
    else uid = w.users.size ? w.cur.uid : 0;
    const gid = w.userByUid(uid)?.gid ?? uid;
    const first = o.cmd.split(/\s+/)[0] ?? "";
    let comm = o.comm ?? first.replace(/^.*\//, "").replace(/^-/, "");
    if (o.zombie) comm = comm.replace(/^\[|\]$/g, "");
    comm = comm.slice(0, 15);
    const mem = o.mem !== undefined ? Math.round((o.mem / 100) * MEM_TOTAL_KB) : undefined;
    const prog = comm === "bash" || o.cmd.startsWith("-bash") ? { rss: 4872, vsz: 232676 } : comm === "sleep" ? { rss: 1112, vsz: 5632 } : { rss: 1900, vsz: 6200 };
    const p: Proc = {
      pid,
      ppid: o.ppid ?? (w.shellPid || 1),
      uid,
      gid,
      cmd: o.zombie ? `[${comm}] <defunct>` : o.cmd,
      comm,
      state: o.zombie ? "Z" : (o.state ?? "S"),
      nice: o.nice ?? 0,
      cpu: o.cpu ?? 0,
      rss: o.zombie ? 0 : (o.rss ?? mem ?? prog.rss),
      vsz: o.zombie ? 0 : (o.vsz ?? Math.max(prog.vsz, (o.rss ?? mem ?? 0) * 2)),
      tty: o.tty ?? "?",
      start: o.start instanceof Date ? o.start.getTime() : (o.start ?? Date.now()),
      cpuSec: o.cpuSec ?? 0,
      kernel: !!o.kernel,
      leader: !!o.leader,
      threads: o.threads ?? 1,
      fg: !!o.fg,
      wchan: o.wchan ?? (o.state === "R" ? "-" : comm === "sleep" ? "hrtime" : o.kernel ? "-" : "do_epo"),
      pgid: pid,
      sid: o.leader ? pid : (this.procs.get(o.ppid ?? w.shellPid)?.sid ?? 1),
      ignored: new Set((o.ignore ?? []).map((s) => sigNumber(s)).filter((x): x is number => x !== undefined)),
      handlesHup: !!o.handlesHup,
      reloads: 0,
      received: [],
      pending: [],
      reapsOnChld: !!o.reapsOnChld,
      expiresAt: o.lifetime !== undefined ? Date.now() + o.lifetime * 1000 : undefined,
      transient: !!o.transient,
      env: {},
      cwd: o.cwd ?? "/",
      exe: first.startsWith("/") ? first : first.startsWith("[") ? "" : `/usr/bin/${comm}`,
    };
    if (o.ignoreTerm) p.ignored.add(15);
    this.procs.set(pid, p);
    this.version++;
    return pid;
  }

  /** Создать процесс; возвращает pid. Для заданий (`setup`) и команд (`sleep &`, `nice`). */
  spawn(o: SpawnOpts): number {
    return this.add(o);
  }

  // ---------- чтение ----------

  /** Убрать процессы, у которых вышло время (sleep N). */
  tick(): void {
    const now = Date.now();
    for (const p of [...this.procs.values()]) if (p.expiresAt !== undefined && p.expiresAt <= now) this.exit(p.pid, 0);
  }

  proc(pid: number): Proc | undefined {
    this.tick();
    return this.procs.get(pid);
  }

  /** Все процессы по возрастанию PID. */
  list(): Proc[] {
    this.tick();
    return [...this.procs.values()].sort((a, b) => a.pid - b.pid);
  }

  isAlive(pid: number): boolean {
    const p = this.proc(pid);
    return !!p && p.state !== "Z";
  }

  /** Живые дети процесса. */
  children(pid: number): Proc[] {
    return this.list().filter((p) => p.ppid === pid);
  }

  /** Найти по имени (comm) или точной командной строке. */
  byName(comm: string): Proc[] {
    return this.list().filter((p) => p.comm === comm);
  }

  stateOf(pid: number): PState | undefined {
    return this.proc(pid)?.state;
  }

  // ---------- сигналы ----------

  /** Отправить сигнал от имени пользователя с uid `from`. */
  kill(pid: number, sig: number, from: number = this.w.cur.uid): KillResult {
    const p = this.proc(pid);
    if (!p) return { ok: false, err: "ESRCH" };
    if (from !== 0 && from !== p.uid) return { ok: false, err: "EPERM" };
    if (sig === 0) return { ok: true };
    this.deliver(p, sig);
    return { ok: true };
  }

  private deliver(p: Proc, sig: number): void {
    p.received.push(sig);
    this.version++;
    if (p.state === "Z") return; // зомби уже мёртв — сигналы бесполезны
    if (p.kernel) return; // kernel-потоки не реагируют на сигналы из userspace
    if (p.state === "D" && sig !== 0) {
      p.pending.push(sig); // uninterruptible sleep: сигнал ждёт выхода из D
      return;
    }
    if (p.pid === 1) {
      if (sig === 1) p.reloads++; // systemctl daemon-reexec-подобная реакция
      return; // init не умирает от неперехваченных сигналов (в т.ч. kill -9 от root)
    }
    const act = defaultAction(sig);
    if (sig !== 9 && sig !== 19 && p.ignored.has(sig)) return;
    if (sig === 18) {
      if (p.state === "T") {
        p.state = "S";
        const queued = p.pending.splice(0);
        for (const s of queued) this.deliver(p, s);
      }
      this.markJob(p.pid, "Running");
      return;
    }
    if (p.state === "T" && sig !== 9 && act !== "ign" && act !== "stop") {
      p.pending.push(sig);
      return;
    }
    if (sig === 1 && p.handlesHup) {
      p.reloads++;
      return;
    }
    if (act === "ign") {
      if (sig === 17) this.reapZombies(p);
      return;
    }
    if (act === "stop") {
      p.state = "T";
      this.markJob(p.pid, "Stopped");
      return;
    }
    this.exit(p.pid, sig);
  }

  /** SIGCHLD родителю: «умеющий wait» родитель убирает зомби-детей. */
  private reapZombies(parent: Proc): void {
    if (!parent.reapsOnChld) return;
    for (const c of this.children(parent.pid)) if (c.state === "Z") this.procs.delete(c.pid);
    this.version++;
  }

  /** Завершить процесс: дети переходят к PID 1, зомби-дети исчезают. */
  exit(pid: number, sig = 0): void {
    const p = this.procs.get(pid);
    if (!p) return;
    this.procs.delete(pid);
    this.exited.set(pid, sig);
    for (const c of [...this.procs.values()]) {
      if (c.ppid !== pid) continue;
      if (c.state === "Z") this.procs.delete(c.pid);
      else c.ppid = 1;
    }
    // сам процесс мог быть зомби-ребёнком — родитель не нужен
    const job = this.jobs.find((j) => j.pid === pid);
    if (job) {
      const names: Record<number, string> = { 1: "Hangup", 2: "Interrupt", 3: "Quit", 9: "Killed", 15: "Terminated" };
      job.status = sig === 0 ? "Done" : (names[sig] ?? "Terminated");
      job.notified = false;
    }
    this.version++;
  }

  // ---------- nice ----------

  /** Установить nice. Возвращает ошибку EPERM, если не хватает прав. */
  setNice(pid: number, value: number, from: number = this.w.cur.uid): "ok" | "ESRCH" | "EPERM" {
    const p = this.proc(pid);
    if (!p) return "ESRCH";
    const v = Math.max(-20, Math.min(19, value));
    if (from !== 0) {
      if (from !== p.uid) return "EPERM";
      if (v < p.nice) return "EPERM"; // обычный пользователь может только увеличивать nice
    }
    p.nice = v;
    this.version++;
    return "ok";
  }

  // ---------- задания (jobs) ----------

  private markJob(pid: number, status: string): void {
    const j = this.jobs.find((x) => x.pid === pid);
    if (j) {
      j.status = status;
      j.notified = status === "Running" || j.notified;
      if (status === "Stopped") j.notified = false;
    }
  }

  addJob(pid: number, cmd: string): Job {
    let id = 1;
    while (this.jobs.some((j) => j.id === id)) id++;
    const j: Job = { id, pid, cmd, status: "Running", notified: true };
    this.jobs.push(j);
    this.bgLast = pid;
    return j;
  }

  /** $! — pid последнего фонового процесса. */
  get lastBg(): number {
    return this.bgLast;
  }

  /** Строка jobs: «[1]+  Running                 sleep 1000 &». */
  jobLine(j: Job, long = false): string {
    this.tick();
    const cur = this.jobs.filter((x) => x.status !== "Done").slice(-2);
    const mark = cur.length && cur[cur.length - 1] === j ? "+" : cur.length > 1 && cur[0] === j ? "-" : " ";
    const bg = j.status === "Running" ? " &" : "";
    const pid = long ? ` ${j.pid}` : "";
    return `[${j.id}]${mark}${pid} ${long ? "" : " "}${j.status.padEnd(23)} ${j.cmd}${bg}`;
  }

  /** Сообщения о завершённых фоновых заданиях (печатаются перед следующим приглашением). */
  collectNotices(): string {
    this.tick();
    let out = "";
    for (const j of [...this.jobs]) {
      if (j.notified || j.status === "Running") continue;
      j.notified = true;
      if (j.status === "Stopped") out += this.jobLine(j) + "\n";
      else {
        out += this.jobLine(j) + "\n";
        this.jobs = this.jobs.filter((x) => x !== j);
      }
    }
    return out;
  }

  // ---------- временные процессы (ps, grep…) ----------

  /** Временный процесс на время команды. */
  spawnTransient(cmd: string, user?: string | number): number {
    return this.add({ cmd, user, state: "R", tty: "pts/0", fg: true, transient: true, wchan: "-" });
  }

  /** Взять заранее созданный процесс этапа пайплайна (ps в `ps | grep`). */
  claimTransient(comm: string): number | undefined {
    for (const p of this.procs.values()) {
      if (p.transient && p.comm === comm && !p.claimed) {
        p.claimed = true;
        return p.pid;
      }
    }
    return undefined;
  }

  clearTransient(): void {
    for (const p of [...this.procs.values()]) if (p.transient) this.procs.delete(p.pid);
    this.version++;
  }

  // ---------- имена и время ----------

  userName(uid: number): string {
    return this.w.userByUid(uid)?.name ?? SYS_NAMES[uid] ?? String(uid);
  }

  /** Секунд процессорного времени (с учётом %CPU за время жизни). */
  cpuTime(p: Proc): number {
    return Math.floor(p.cpuSec + (p.cpu / 100) * Math.max(0, (Date.now() - p.start) / 1000));
  }

  uptimeSec(): number {
    return Math.floor((Date.now() - this.bootAt) / 1000);
  }

  /** load average 1/5/15 минут: небольшой фон + загрузка процессами. */
  loadavg(): [number, number, number] {
    const busy = this.list()
      .filter((p) => !p.transient && !p.kernel && p.state !== "Z" && p.state !== "T")
      .reduce((s, p) => s + p.cpu / 100, 0);
    const f = (base: number) => Math.round((base + busy) * 100) / 100;
    return [f(0.02), f(0.04), f(0.05)];
  }
}
