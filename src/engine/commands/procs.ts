// ps, top, pgrep, pkill, pidof, kill, killall, nice, renice, uptime, jobs, sleep — поверх модели процессов (procs.ts).
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import type { Proc } from "../procs";
import { MEM_TOTAL_KB, SIGNALS, sigName, sigNumber } from "../procs";
import { fail, parseArgs } from "../util";

const pad2 = (n: number) => String(n).padStart(2, "0");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ---------- форматирование времени ----------

/** TIME в aux-формате: M:SS. */
const cpuShort = (s: number) => `${Math.floor(s / 60)}:${pad2(s % 60)}`;
/** TIME в -ef-формате: HH:MM:SS (с днями — d-HH:MM:SS). */
function cpuLong(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const base = `${pad2(h)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
  return d ? `${d}-${base}` : base;
}
function etime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (d ? `${d}-${pad2(h)}:` : h ? `${pad2(h)}:` : "") + `${pad2(m)}:${pad2(s)}`;
}
/** START/STIME: HH:MM за последние сутки, иначе MonDD. */
function startShort(ms: number): string {
  const d = new Date(ms);
  if (Date.now() - ms < 86400 * 1000) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  return `${MONTHS[d.getMonth()]}${pad2(d.getDate())}`;
}
function lstart(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${d.getFullYear()}`;
}
function startLong(ms: number): string {
  const d = new Date(ms);
  if (Date.now() - ms < 86400 * 1000) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  return ` ${MONTHS[d.getMonth()]} ${pad2(d.getDate())}`;
}

// ---------- колонки ps ----------

interface Ctx {
  w: World;
  all: Proc[];
  /** Отступ дерева для строки (forest). */
  prefix: Map<number, string>;
  dim: boolean;
}
interface Col {
  h: string;
  w: number;
  left?: boolean;
  v: (p: Proc, c: Ctx) => string;
}

const statOf = (p: Proc) =>
  p.state + (p.nice < 0 ? "<" : p.nice > 0 ? "N" : "") + (p.leader ? "s" : "") + (p.threads > 1 ? "l" : "") + (p.fg ? "+" : "");
const userOf = (p: Proc, c: Ctx) => {
  const n = c.w.procs.userName(p.uid);
  return n.length > 8 ? n.slice(0, 7) + "+" : n;
};
const memPct = (p: Proc) => ((p.rss / MEM_TOTAL_KB) * 100).toFixed(1);
const cmdOf = (p: Proc, c: Ctx) => (c.prefix.get(p.pid) ?? "") + p.cmd;
const commOf = (p: Proc, c: Ctx) => (c.prefix.get(p.pid) ?? "") + (p.kernel ? p.cmd : p.comm);

const COLS: Record<string, Col> = {
  pid: { h: "PID", w: 7, v: (p) => String(p.pid) },
  ppid: { h: "PPID", w: 7, v: (p) => String(p.ppid) },
  pgid: { h: "PGID", w: 7, v: (p) => String(p.pgid) },
  sid: { h: "SID", w: 7, v: (p) => String(p.sid) },
  lwp: { h: "LWP", w: 7, v: (p) => String(p.pid) },
  nlwp: { h: "NLWP", w: 4, v: (p) => String(p.threads) },
  uid: { h: "UID", w: 5, v: (p) => String(p.uid) },
  gid: { h: "GID", w: 5, v: (p) => String(p.gid) },
  user: { h: "USER", w: 8, left: true, v: userOf },
  group: { h: "GROUP", w: 8, left: true, v: (p, c) => c.w.groupByGid(p.gid)?.name ?? String(p.gid) },
  stat: { h: "STAT", w: 4, left: true, v: (p) => statOf(p) },
  s: { h: "S", w: 1, left: true, v: (p) => p.state },
  ni: { h: "NI", w: 3, v: (p) => String(p.nice) },
  pri: { h: "PRI", w: 3, v: (p) => String(19 - p.nice) },
  pcpu: { h: "%CPU", w: 4, v: (p) => p.cpu.toFixed(1) },
  pmem: { h: "%MEM", w: 4, v: (p) => memPct(p) },
  rss: { h: "RSS", w: 5, v: (p) => String(p.rss) },
  vsz: { h: "VSZ", w: 6, v: (p) => String(p.vsz) },
  sz: { h: "SZ", w: 5, v: (p) => String(Math.floor(p.vsz / 4)) },
  c: { h: "C", w: 2, v: (p) => String(Math.min(99, Math.round(p.cpu))) },
  psr: { h: "PSR", w: 3, v: () => "0" },
  f: { h: "F", w: 1, v: (p) => (p.kernel ? "1" : p.uid === 0 ? "4" : "0") },
  comm: { h: "COMMAND", w: 15, left: true, v: (p, c) => commOf(p, c).slice(0, 15 + (c.prefix.get(p.pid)?.length ?? 0)) },
  cmd: { h: "CMD", w: 27, left: true, v: cmdOf },
  args: { h: "COMMAND", w: 27, left: true, v: cmdOf },
  etime: { h: "ELAPSED", w: 11, v: (p) => etime(Math.floor((Date.now() - p.start) / 1000)) },
  time: { h: "TIME", w: 8, v: (p, c) => cpuLong(c.w.procs.cpuTime(p)) },
  tty: { h: "TT", w: 8, left: true, v: (p) => p.tty },
  start: { h: "STARTED", w: 8, v: (p) => startLong(p.start) },
  lstart: { h: "STARTED", w: 24, v: (p) => lstart(p.start) },
  start_time: { h: "START", w: 5, left: true, v: (p) => startShort(p.start) },
  stime: { h: "STIME", w: 5, left: true, v: (p) => startShort(p.start) },
  wchan: { h: "WCHAN", w: 6, left: true, v: (p) => (p.state === "Z" ? "-" : p.wchan.slice(0, 6)) },
  tpgid: { h: "TPGID", w: 5, v: (p) => (p.tty === "?" ? "-1" : String(p.pgid)) },
};

const ALIAS: Record<string, string> = {
  "%cpu": "pcpu", cp: "pcpu", "%mem": "pmem", pmem: "pmem", rsz: "rss", vsize: "vsz", euser: "user", uname: "user", ruser: "user",
  euid: "uid", ruid: "uid", egroup: "group", rgroup: "group", ucmd: "comm", ucomm: "comm", command: "args", nice: "ni", priority: "pri",
  tt: "tty", tname: "tty", cputime: "time", tid: "lwp", spid: "lwp", state: "s", flags: "f", egid: "gid", rgid: "gid", bsdtime: "time",
  sess: "sid", session: "sid", pgrp: "pgid", thcount: "nlwp", stime2: "stime", wchan2: "wchan", sgi_p: "psr",
};

const PS_USAGE =
  "\nUsage:\n ps [options]\n\n Try 'ps --help <simple|list|output|threads|misc|all>'\n  or 'ps --help <s|l|o|t|m|a>'\n for additional help text.\n\nFor more details see ps(1).\n";

function pad(s: string, width: number, left?: boolean): string {
  return left ? s.padEnd(width) : s.padStart(width);
}

type FormatCol = { key: string; h?: string; w?: number; left?: boolean; fn?: (p: Proc, c: Ctx) => string };
const F = (key: string, extra: Partial<FormatCol> = {}): FormatCol => ({ key, ...extra });

const FORMATS: Record<string, FormatCol[]> = {
  default: [F("pid"), F("tty", { h: "TTY" }), F("time"), F("comm", { h: "CMD", w: 0 })],
  aux: [
    F("user"), F("pid"), F("pcpu"), F("pmem"), F("vsz"), F("rss"), F("tty", { h: "TTY" }), F("stat"),
    F("start_time"), F("time", { w: 6, fn: (p, c) => cpuShort(c.w.procs.cpuTime(p)) }), F("args", { h: "COMMAND", w: 0 }),
  ],
  f: [F("user", { h: "UID" }), F("pid"), F("ppid"), F("c"), F("stime"), F("tty", { h: "TTY" }), F("time"), F("cmd", { w: 0 })],
  F: [F("user", { h: "UID" }), F("pid"), F("ppid"), F("c"), F("sz", { w: 6 }), F("rss"), F("psr"), F("stime"), F("tty", { h: "TTY" }), F("time"), F("cmd", { w: 0 })],
  l: [
    F("f"), F("s"), F("uid"), F("pid"), F("ppid"), F("c"), F("pri", { fn: (p) => String(80 + p.nice) }), F("ni"),
    F("addrsz", { h: "ADDR SZ", w: 7, fn: (p) => `- ${String(Math.floor(p.vsz / 4)).padStart(5)}` }),
    F("wchan"), F("tty", { h: "TTY" }), F("time"), F("comm", { h: "CMD", w: 0 }),
  ],
  j: [F("pid"), F("pgid"), F("sid"), F("tty", { h: "TTY" }), F("time"), F("comm", { h: "CMD", w: 0 })],
  bsdl: [
    F("f"), F("uid"), F("pid"), F("ppid"), F("pri", { fn: (p) => String(20 + p.nice) }), F("ni"), F("vsz", { w: 6 }), F("rss"), F("wchan"),
    F("stat"), F("tty", { h: "TTY" }), F("time", { w: 6, fn: (p, c) => cpuShort(c.w.procs.cpuTime(p)) }), F("args", { h: "COMMAND", w: 0 }),
  ],
  bsdj: [
    F("ppid"), F("pid"), F("pgid"), F("sid"), F("tty", { h: "TTY" }), F("tpgid"), F("stat"), F("uid"),
    F("time", { w: 6, fn: (p, c) => cpuShort(c.w.procs.cpuTime(p)) }), F("args", { h: "COMMAND", w: 0 }),
  ],
};

function sortKey(k: string, p: Proc, c: Ctx): number | string {
  switch (k) {
    case "pid": case "tid": return p.pid;
    case "ppid": return p.ppid;
    case "pcpu": case "%cpu": case "c": return p.cpu;
    case "pmem": case "%mem": return p.rss;
    case "rss": case "rsz": return p.rss;
    case "vsz": case "vsize": case "sz": return p.vsz;
    case "ni": case "nice": return p.nice;
    case "pri": case "priority": return 19 - p.nice;
    case "user": case "euser": case "uname": return c.w.procs.userName(p.uid);
    case "uid": case "euid": return p.uid;
    case "comm": case "ucmd": return p.comm;
    case "cmd": case "args": case "command": return p.cmd;
    case "stat": case "state": case "s": return p.state;
    case "time": case "cputime": return c.w.procs.cpuTime(p);
    case "start": case "start_time": case "lstart": case "stime": case "etime": return p.start;
    case "tty": case "tt": return p.tty;
    default: return NaN;
  }
}

export function procCommands(w: World, onUnsupported: (name: string) => void = () => {}): Command[] {
  const P = w.procs;
  const me = () => w.cur.uid;

  /** Процесс, соответствующий текущей команде (из пайплайна или новый). */
  const selfProc = (comm: string, line: string): { pid: number; release: () => void } => {
    const claimed = P.claimTransient(comm);
    if (claimed !== undefined) return { pid: claimed, release: () => {} };
    const pid = P.spawnTransient(line);
    return { pid, release: () => P.procs.delete(pid) };
  };

  // ---------------- ps ----------------
  const ps = defineCommand("ps", async (args) => {
    P.bump();
    const self = selfProc("ps", ["ps", ...args].join(" "));
    try {
      return psRun(args, self.pid);
    } finally {
      self.release();
    }
  });

  function psRun(args: string[], selfPid: number) {
    const err = (msg: string) => fail(`error: ${msg}\n${PS_USAGE}`, 1);
    let all = false;
    let aFlag = false;
    let xFlag = false;
    let uFmt = false;
    let fFmt = false;
    let bigF = false;
    let lFmt = false;
    let jFmt = false;
    let bsdForest = false;
    let bsdL = false;
    let bsdJ = false;
    let forest = false;
    let indentH = false;
    let noHeader = false;
    let deselect = false;
    let dashA = false; // -a
    let dashD = false; // -d
    const pidSel: number[] = [];
    let havePid = false;
    const comms: string[] = [];
    const users: number[] = [];
    const ttys: string[] = [];
    const ppids: number[] = [];
    const groups: number[] = [];
    let oFields: { key: string; label?: string }[] | null = null;
    const sorts: string[] = [];

    const parseUser = (v: string): number[] | null => {
      const r: number[] = [];
      for (const part of v.split(/[,\s]+/).filter(Boolean)) {
        if (/^\d+$/.test(part)) r.push(Number(part));
        else {
          const u = w.user(part);
          const sys = [81, 995, 998].find((id) => P.userName(id) === part);
          if (u) r.push(u.uid);
          else if (sys !== undefined) r.push(sys);
          else return null;
        }
      }
      return r;
    };
    const parsePids = (v: string): number[] | null => {
      const r: number[] = [];
      for (const part of v.split(/[,\s]+/).filter(Boolean)) {
        if (!/^\d+$/.test(part)) return null;
        r.push(Number(part));
      }
      return r;
    };
    const parseO = (v: string): string | null => {
      oFields ??= [];
      for (const raw of v.split(/[,\s]+/).filter(Boolean)) {
        const [name, ...lab] = raw.split("=");
        const key = ALIAS[name.toLowerCase()] ?? name.toLowerCase();
        const k2 = key === "pcpu" || key === "pmem" ? key : key;
        if (!COLS[k2] && !["start_time", "lstart"].includes(k2)) return name;
        oFields.push({ key: k2, label: lab.length ? lab.join("=") : undefined });
      }
      return null;
    };

    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("--")) {
        const [name, val0] = a.slice(2).split(/=(.*)/s, 2);
        const val = val0 ?? "";
        switch (name) {
          case "forest": forest = true; break;
          case "no-headers": case "no-header": noHeader = true; break;
          case "headers": break;
          case "sort": sorts.push(...val.split(",").filter(Boolean)); break;
          case "pid": { const l = parsePids(val); if (!l) return err("process ID list syntax error"); pidSel.push(...l); havePid = true; break; }
          case "ppid": { const l = parsePids(val); if (!l) return err("process ID list syntax error"); ppids.push(...l); break; }
          case "user": { const l = parseUser(val); if (!l) return err("user name does not exist"); users.push(...l); break; }
          case "deselect": deselect = true; break;
          case "columns": case "cols": case "width": break;
          case "help": return { stdout: PS_USAGE.slice(1), stderr: "", exitCode: 0 };
          case "version": return { stdout: "ps from procps-ng 3.3.17\n", stderr: "", exitCode: 0 };
          default: return err("unknown gnu long option");
        }
        continue;
      }
      if (a.startsWith("-") && a.length > 1) {
        // SysV-кластер: -ef, -eo pid,cmd, -p 1,2
        for (let j = 1; j < a.length; j++) {
          const c = a[j];
          const takeVal = (): string | undefined => {
            const rest = a.slice(j + 1);
            j = a.length;
            if (rest) return rest;
            return args[++i];
          };
          switch (c) {
            case "e": case "A": all = true; break;
            case "a": dashA = true; break;
            case "d": dashD = true; break;
            case "f": fFmt = true; break;
            case "F": bigF = true; break;
            case "l": lFmt = true; break;
            case "j": jFmt = true; break;
            case "y": break;
            case "H": forest = true; indentH = true; break;
            case "w": break;
            case "h": noHeader = true; break;
            case "N": deselect = true; break;
            case "o": {
              const v = takeVal();
              if (v === undefined) return err("improper list");
              const bad = parseO(v);
              if (bad) return err(`unknown user-defined format specifier "${bad}"`);
              break;
            }
            case "p": {
              let v = takeVal();
              if (v === undefined) return err("improper list");
              while (args[i + 1] !== undefined && /^[\d,]+$/.test(args[i + 1]) && /[\d,]$/.test(v)) v += "," + args[++i];
              const l = parsePids(v);
              if (!l) return err("process ID list syntax error");
              pidSel.push(...l);
              havePid = true;
              break;
            }
            case "u": case "U": {
              const v = takeVal();
              if (v === undefined) return err("improper list");
              const l = parseUser(v);
              if (!l) return err("user name does not exist");
              users.push(...l);
              break;
            }
            case "G": case "g": {
              const v = takeVal();
              if (v === undefined) return err("improper list");
              for (const part of v.split(",")) {
                const g = /^\d+$/.test(part) ? Number(part) : w.group(part)?.gid;
                if (g === undefined) return err("group name does not exist");
                groups.push(g);
              }
              break;
            }
            case "C": {
              const v = takeVal();
              if (v === undefined) return err("list of command names must follow -C");
              comms.push(...v.split(","));
              break;
            }
            case "t": {
              const v = takeVal();
              if (v === undefined) return err("improper list");
              ttys.push(...v.split(",").map((t) => (t.startsWith("/dev/") ? t.slice(5) : t)));
              break;
            }
            case "L": case "T": case "m": case "M": case "Z": case "c": case "n": case "s": case "V":
              onUnsupported(`ps -${c}`);
              w.unsupported.push("ps");
              return fail(`ps: ключ -${c} тренажёр пока не умеет (записал в журнал)`, 1);
            default:
              return err("unsupported SysV option");
          }
        }
        continue;
      }
      // BSD-стиль: aux, ax, auxf, -- или список pid
      if (/^[\d,]+$/.test(a)) {
        const l = parsePids(a);
        if (l) pidSel.push(...l);
        havePid = true;
        continue;
      }
      if (/^[a-zA-Z]+$/.test(a)) {
        for (const c of a) {
          switch (c) {
            case "a": aFlag = true; break;
            case "x": xFlag = true; break;
            case "u": uFmt = true; break;
            case "f": bsdForest = true; break;
            case "e": case "w": case "c": case "m": case "r": case "S": break;
            case "h": noHeader = true; break;
            case "l": bsdL = true; break;
            case "j": bsdJ = true; break;
            case "o": {
              const v = args[++i];
              if (v === undefined) return err("improper list");
              const bad = parseO(v);
              if (bad) return err(`unknown user-defined format specifier "${bad}"`);
              break;
            }
            case "p": {
              const l = parsePids(args[++i] ?? "");
              if (!l) return err("process ID list syntax error");
              pidSel.push(...l);
              havePid = true;
              break;
            }
            case "t": ttys.push(args[++i] ?? ""); break;
            case "O": case "v": case "s": case "X": case "y": case "L": case "n": case "N": case "k": case "T":
              onUnsupported(`ps ${c}`);
              w.unsupported.push("ps");
              return fail(`ps: ключ ${c} тренажёр пока не умеет (записал в журнал)`, 1);
            default:
              return err("improper list");
          }
        }
        continue;
      }
      return err("garbage option");
    }
    if (bsdForest) forest = true;

    // ---- выбор процессов ----
    const ctx: Ctx = { w, all: P.list(), prefix: new Map(), dim: false };
    const shell = P.procs.get(w.shellPid);
    const myTty = shell?.tty ?? "pts/0";
    const hasSel = all || aFlag || xFlag || dashA || dashD || havePid || comms.length || users.length || ttys.length || ppids.length || groups.length;
    const matches = (p: Proc): boolean => {
      if (!hasSel) return p.uid === me() && p.tty === myTty;
      if (all) return true;
      if (xFlag && aFlag) return true;
      if (xFlag && p.uid === me()) return true;
      if (aFlag && p.tty !== "?") return true;
      if (dashA && p.tty !== "?" && !p.leader) return true;
      if (dashD && !p.leader) return true;
      if (havePid && pidSel.includes(p.pid)) return true;
      if (comms.includes(p.comm)) return true;
      if (users.includes(p.uid)) return true;
      if (ttys.includes(p.tty)) return true;
      if (ppids.includes(p.ppid)) return true;
      if (groups.includes(p.gid)) return true;
      return false;
    };
    let rows = ctx.all.filter((p) => {
      let m = matches(p);
      // ps не показывает завершённые, но показывает себя
      if (p.pid === selfPid && !hasSel) m = true;
      return deselect ? !m : m;
    });
    if (!rows.some((p) => p.pid === selfPid) && !hasSel) rows.push(P.procs.get(selfPid)!);

    // ---- сортировка ----
    if (sorts.length) {
      for (const sk of sorts.slice().reverse()) {
        const desc = sk.startsWith("-");
        const key = sk.replace(/^[-+]/, "");
        if (Number.isNaN(sortKey(key, rows[0] ?? ({} as Proc), ctx)) && rows.length) {
          return err("unknown gnu long option");
        }
        rows = [...rows].sort((a, b) => {
          const x = sortKey(key, a, ctx);
          const y = sortKey(key, b, ctx);
          const r = typeof x === "number" && typeof y === "number" ? x - y : String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
          return desc ? -r : r;
        });
      }
    }

    // ---- дерево ----
    if (forest) {
      const ids = new Set(rows.map((p) => p.pid));
      const kids = new Map<number, Proc[]>();
      const roots: Proc[] = [];
      for (const p of rows) {
        if (ids.has(p.ppid) && p.ppid !== p.pid) {
          const l = kids.get(p.ppid) ?? [];
          l.push(p);
          kids.set(p.ppid, l);
        } else roots.push(p);
      }
      const ordered: Proc[] = [];
      const walk = (p: Proc, anc: boolean[], depth: number) => {
        ordered.push(p);
        if (indentH) ctx.prefix.set(p.pid, "  ".repeat(depth));
        else if (depth > 0) ctx.prefix.set(p.pid, anc.slice(0, -1).map((more) => (more ? " |  " : "    ")).join("") + " \\_ ");
        const ch = (kids.get(p.pid) ?? []).sort((a, b) => a.pid - b.pid);
        ch.forEach((c, idx) => walk(c, [...anc, idx < ch.length - 1], depth + 1));
      };
      roots.sort((a, b) => a.pid - b.pid).forEach((r) => walk(r, [], 0));
      rows = ordered;
    }

    // ---- формат ----
    let fmt: FormatCol[];
    if (oFields) {
      fmt = (oFields as { key: string; label?: string }[]).map((o) => ({ key: o.key, h: o.label ?? (o.key === "tty" ? "TT" : COLS[o.key].h) }));
    } else if (bsdL) fmt = FORMATS.bsdl;
    else if (bsdJ) fmt = FORMATS.bsdj;
    else if (uFmt) fmt = FORMATS.aux;
    else if (bigF) fmt = FORMATS.F;
    else if (lFmt) fmt = FORMATS.l;
    else if (jFmt) fmt = FORMATS.j;
    else if (fFmt) fmt = FORMATS.f;
    else fmt = FORMATS.default;
    const cols = fmt.map((fc, idx) => {
      const base = COLS[fc.key] ?? { h: fc.h ?? fc.key, w: fc.w ?? 8, v: () => "" };
      const last = idx === fmt.length - 1;
      const isCmd = fc.key === "cmd" || fc.key === "args" || fc.key === "comm";
      let width = fc.w ?? base.w;
      if (oFields && (fc.key === "tty")) width = 8;
      if (isCmd && last) width = 0;
      else if (isCmd && fc.w === 0) width = base.w;
      return { h: fc.h ?? base.h, width, left: base.left, fn: fc.fn ?? base.v };
    });
    const lineKeep = (cells: string[]) => cells.map((c, i) => (cols[i].width === 0 ? c : pad(c, cols[i].width, cols[i].left))).join(" ");
    const out: string[] = [];
    const allHeadersEmpty = oFields ? (oFields as { label?: string }[]).every((o) => o.label === "") : false;
    if (!noHeader && !allHeadersEmpty) out.push(lineKeep(cols.map((c) => c.h)).replace(/\s+$/, ""));
    for (const p of rows) out.push(lineKeep(cols.map((c) => c.fn(p, ctx))).replace(/\s+$/, ""));
    return { stdout: out.join("\n") + (out.length ? "\n" : ""), stderr: "", exitCode: rows.length || !hasSel ? 0 : 1 };
  }

  // ---------------- pgrep / pkill ----------------
  const matcher = (name: "pgrep" | "pkill") =>
    defineCommand(name, async (args) => {
      P.bump();
      const usage = (msg: string) => fail(`${name}: ${msg}\nTry \`${name} --help' for more information.`, 2);
      const opt = { full: false, list: false, listFull: false, count: false, exact: false, inverse: false, icase: false, newest: false, oldest: false, echo: false };
      let delim = "\n";
      let sig = 15;
      const users: number[] = [];
      const ppids: number[] = [];
      const ttys: string[] = [];
      const runstates: string[] = [];
      const sessions: number[] = [];
      const pgroups: number[] = [];
      let older: number | undefined;
      const rest: string[] = [];
      const longs: Record<string, string> = {
        full: "f", "list-name": "l", "list-full": "a", count: "c", exact: "x", inverse: "v", "ignore-case": "i", newest: "n", oldest: "o", echo: "e",
      };
      const wantVal = new Set(["u", "U", "P", "t", "d", "s", "g", "G", "O", "r", "F", "signal"]);
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--") {
          rest.push(...args.slice(i + 1));
          break;
        }
        if (a.startsWith("--")) {
          const [n, v0] = a.slice(2).split(/=(.*)/s, 2);
          const short = longs[n];
          const valMap: Record<string, string> = { euid: "u", uid: "U", parent: "P", terminal: "t", delimiter: "d", session: "s", pgroup: "g", group: "G", older: "O", runstates: "r", signal: "signal" };
          if (short) {
            applyFlag(short);
            continue;
          }
          if (valMap[n]) {
            applyVal(valMap[n], v0 ?? args[++i] ?? "");
            continue;
          }
          return fail(`${name}: unrecognized option '${a}'\n\nUsage:\n ${name} [options] <pattern>\n\nFor more details see pgrep(1).`, 2);
        }
        if (a.startsWith("-") && a.length > 1) {
          // pkill -9 / -KILL / -SIGKILL
          if (name === "pkill" && /^-(\d+|[A-Za-z][A-Za-z0-9+-]*)$/.test(a) && sigNumber(a.slice(1)) !== undefined && !/^-[a-zA-Z]$/.test(a)) {
            sig = sigNumber(a.slice(1))!;
            continue;
          }
          for (let j = 1; j < a.length; j++) {
            const c = a[j];
            if (wantVal.has(c)) {
              const v = a.slice(j + 1) || args[++i] || "";
              const bad = applyVal(c, v);
              if (bad) return usage(bad);
              break;
            }
            if (!"flacxvinoeqw".includes(c)) return fail(`${name}: invalid option -- '${c}'\n\nUsage:\n ${name} [options] <pattern>\n\nFor more details see pgrep(1).`, 2);
            applyFlag(c);
          }
          continue;
        }
        rest.push(a);
      }
      function applyFlag(c: string) {
        if (c === "f") opt.full = true;
        else if (c === "l") opt.list = true;
        else if (c === "a") opt.listFull = true;
        else if (c === "c") opt.count = true;
        else if (c === "x") opt.exact = true;
        else if (c === "v") opt.inverse = true;
        else if (c === "i") opt.icase = true;
        else if (c === "n") opt.newest = true;
        else if (c === "o") opt.oldest = true;
        else if (c === "e") opt.echo = true;
      }
      function applyVal(c: string, v: string): string | null {
        if (c === "d") delim = v;
        else if (c === "signal") {
          const n = sigNumber(v);
          if (n === undefined) return `invalid signal`;
          sig = n;
        } else if (c === "u" || c === "U") {
          for (const part of v.split(",")) {
            const u = /^\d+$/.test(part) ? Number(part) : w.user(part)?.uid;
            if (u === undefined) return `invalid user name: ${part}`;
            users.push(u);
          }
        } else if (c === "P") ppids.push(...v.split(",").map(Number));
        else if (c === "t") ttys.push(...v.split(","));
        else if (c === "s") sessions.push(...v.split(",").map(Number));
        else if (c === "g") pgroups.push(...v.split(",").map(Number));
        else if (c === "r") runstates.push(...v.split(","));
        else if (c === "O") older = Number(v);
        return null;
      }
      const pattern = rest[0];
      const hasCrit = users.length || ppids.length || ttys.length || runstates.length || sessions.length || pgroups.length || older !== undefined;
      if (pattern === undefined && !hasCrit) return usage("no matching criteria specified");
      let re: RegExp | null = null;
      if (pattern !== undefined) {
        try {
          re = new RegExp(opt.exact ? `^(?:${pattern})$` : pattern, opt.icase ? "i" : "");
        } catch {
          return fail(`${name}: regular expression error`, 2);
        }
      }
      const self = P.claimTransient(name);
      let found = P.list().filter((p) => {
        if (p.pid === self || p.transient && p.comm === name) return false;
        if (p.kernel && !opt.full ? false : false) return false;
        if (re) {
          const text = opt.full ? p.cmd : p.comm;
          if (!re.test(text)) return false;
        }
        if (users.length && !users.includes(p.uid)) return false;
        if (ppids.length && !ppids.includes(p.ppid)) return false;
        if (ttys.length && !ttys.includes(p.tty)) return false;
        if (sessions.length && !sessions.includes(p.sid)) return false;
        if (pgroups.length && !pgroups.includes(p.pgid)) return false;
        if (runstates.length && !runstates.includes(p.state)) return false;
        if (older !== undefined && (Date.now() - p.start) / 1000 < older) return false;
        return true;
      });
      if (opt.inverse) {
        const ids = new Set(found.map((p) => p.pid));
        found = P.list().filter((p) => !ids.has(p.pid) && !p.transient);
      }
      if (found.length && (opt.newest || opt.oldest)) {
        const sorted = [...found].sort((a, b) => a.start - b.start || a.pid - b.pid);
        found = [opt.newest ? sorted[sorted.length - 1] : sorted[0]];
      }
      if (name === "pgrep") {
        if (opt.count) return { stdout: found.length + "\n", stderr: "", exitCode: found.length ? 0 : 1 };
        const items = found.map((p) => (opt.listFull ? `${p.pid} ${p.cmd}` : opt.list ? `${p.pid} ${p.comm}` : String(p.pid)));
        return { stdout: items.length ? items.join(delim) + "\n" : "", stderr: "", exitCode: found.length ? 0 : 1 };
      }
      // pkill
      let err = "";
      let out = "";
      let n = 0;
      for (const p of found) {
        const r = P.kill(p.pid, sig, me());
        if (!r.ok) {
          err += `pkill: killing pid ${p.pid} failed: ${r.err === "EPERM" ? "Operation not permitted" : "No such process"}\n`;
          continue;
        }
        n++;
        if (opt.echo) out += `${p.comm} killed (pid ${p.pid})\n`;
      }
      if (opt.count) out += n + "\n";
      return { stdout: out, stderr: err, exitCode: found.length ? (err && !n ? 1 : 0) : 1 };
    });

  // ---------------- pidof ----------------
  const pidof = defineCommand("pidof", async (args) => {
    P.bump();
    const p = parseArgs(args, { short: "scqxzSn", withValue: ["o", "d"] });
    if (p.bad) return fail(`pidof: invalid option -- '${p.bad}'\nUsage: pidof [options] [program [...]]`, 1);
    const omit = (p.values.get("o") ?? "").split(",");
    const selfPid = P.claimTransient("pidof");
    const pids: number[] = [];
    for (const name of p.rest) {
      const base = name.replace(/^.*\//, "");
      for (const pr of P.list()) {
        if (pr.pid === selfPid || pr.state === "Z" || pr.kernel) continue;
        if (omit.includes(String(pr.pid)) || (omit.includes("%PPID") && pr.pid === w.shellPid)) continue;
        const hit = pr.comm === base || pr.cmd.split(" ")[0].replace(/^.*\//, "") === base || (p.flags.has("x") && pr.cmd.split(/\s+/).some((t) => t.replace(/^.*\//, "") === base));
        if (hit) pids.push(pr.pid);
      }
    }
    pids.sort((a, b) => b - a);
    const list = p.flags.has("s") ? pids.slice(0, 1) : pids;
    if (!list.length) return { stdout: "", stderr: "", exitCode: 1 };
    return { stdout: p.flags.has("q") ? "" : list.join(" ") + "\n", stderr: "", exitCode: 0 };
  });

  // ---------------- kill ----------------
  const KILL_USAGE = "kill: usage: kill [-s sigspec | -n signum | -sigspec] pid | jobspec ... or kill -l [sigspec]";
  const sigTable = () => {
    let out = "";
    SIGNALS.forEach(([n, name], i) => {
      out += `${String(n).padStart(2)}) SIG${name}` + ((i + 1) % 5 === 0 ? "\n" : "\t");
    });
    if (SIGNALS.length % 5) out += "\n";
    return out;
  };
  const jobPid = (spec: string): number | undefined => {
    const jobs = P.jobs;
    const s = spec.slice(1);
    if (s === "" || s === "%" || s === "+") return jobs[jobs.length - 1]?.pid;
    if (s === "-") return jobs[jobs.length - 2]?.pid;
    if (/^\d+$/.test(s)) return jobs.find((j) => j.id === Number(s))?.pid;
    return jobs.find((j) => j.cmd.startsWith(s.replace(/^\?/, "")) || (s.startsWith("?") && j.cmd.includes(s.slice(1))))?.pid;
  };
  const kill = defineCommand("kill", async (args) => {
    if (!args.length) return fail(KILL_USAGE, 2);
    let sig = 15;
    let i = 0;
    const a0 = args[0];
    if (a0 === "-l" || a0 === "-L" || a0 === "--list") {
      if (args.length === 1) return { stdout: sigTable(), stderr: "", exitCode: 0 };
      let out = "";
      let err = "";
      let code = 0;
      for (const s of args.slice(1)) {
        if (/^\d+$/.test(s)) {
          let n = Number(s);
          if (n > 128) n -= 128;
          const nm = sigName(n);
          if (nm) out += nm + "\n";
          else {
            err += `bash: kill: ${s}: invalid signal specification\n`;
            code = 1;
          }
        } else {
          const n = sigNumber(s);
          if (n !== undefined && n !== 0) out += n + "\n";
          else {
            err += `bash: kill: ${s}: invalid signal specification\n`;
            code = 1;
          }
        }
      }
      return { stdout: out, stderr: err, exitCode: code };
    }
    if (a0 === "-s" || a0 === "-n") {
      if (args.length < 2) return fail(KILL_USAGE, 2);
      const n = sigNumber(args[1]);
      if (n === undefined) return fail(`bash: kill: ${args[1]}: invalid signal specification`, 1);
      sig = n;
      i = 2;
    } else if (/^-[0-9A-Za-z][\w+-]*$/.test(a0) && a0 !== "--") {
      const n = sigNumber(a0.slice(1));
      if (n === undefined) return fail(`bash: kill: ${a0.slice(1)}: invalid signal specification`, 1);
      sig = n;
      i = 1;
    }
    if (args[i] === "--") i++;
    const targets = args.slice(i);
    if (!targets.length) return fail(KILL_USAGE, 2);
    let err = "";
    let code = 0;
    for (const t of targets) {
      let pids: number[];
      if (t.startsWith("%")) {
        const jp = jobPid(t);
        if (jp === undefined) {
          err += `bash: kill: ${t}: no such job\n`;
          code = 1;
          continue;
        }
        pids = [jp];
      } else if (/^-?\d+$/.test(t)) {
        const n = Number(t);
        if (n < 0) pids = P.list().filter((p) => p.pgid === -n).map((p) => p.pid);
        else pids = [n];
        if (n < 0 && !pids.length) {
          err += `bash: kill: (${t}) - No such process\n`;
          code = 1;
          continue;
        }
      } else {
        err += `bash: kill: ${t}: arguments must be process or job IDs\n`;
        code = 1;
        continue;
      }
      for (const pid of pids) {
        if (pid === w.shellPid && sig !== 0) continue; // оболочка пользователя не убиваем: сессия ssh закрылась бы
        const r = P.kill(pid, sig, me());
        if (!r.ok) {
          err += `bash: kill: (${pid}) - ${r.err === "EPERM" ? "Operation not permitted" : "No such process"}\n`;
          code = 1;
        }
      }
    }
    return { stdout: "", stderr: err, exitCode: code };
  });

  // ---------------- killall ----------------
  const killall = defineCommand("killall", async (args) => {
    P.bump();
    const usage =
      "Usage: killall [OPTION]... [--] NAME...\n       killall -l, --list\n       killall -V, --version\n\n  -e,--exact          require exact match for very long names\n  -I,--ignore-case    case insensitive process name match\n  -g,--process-group  kill process group instead of process\n  -y,--younger-than   kill processes younger than TIME\n  -o,--older-than     kill processes older than TIME\n  -i,--interactive    ask for confirmation before killing\n  -l,--list           list all known signal names\n  -q,--quiet          don't print complaints\n  -r,--regexp         interpret NAME as an extended regular expression\n  -s,--signal SIGNAL  send this signal instead of SIGTERM\n  -u,--user USER      kill only process(es) running as USER\n  -v,--verbose        report if the signal was successfully sent\n  -V,--version        display version information\n  -w,--wait           wait for processes to die\n  -n,--ns PID         match processes that belong to the same namespaces\n                      as PID\n  -Z,--context REGEXP kill only process(es) having context\n                      (must precede other arguments)\n";
    let sig = 15;
    let quiet = false;
    let verbose = false;
    let regexp = false;
    let icase = false;
    let user: number | undefined;
    const names: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-l" || a === "--list") return { stdout: SIGNALS.filter(([n]) => n < 32).map(([, nm]) => nm).join(" ") + "\n", stderr: "", exitCode: 0 };
      if (a === "-V" || a === "--version") return { stdout: "killall (PSmisc) 23.4\n", stderr: "", exitCode: 0 };
      if (a === "-s" || a === "--signal") {
        const n = sigNumber(args[++i] ?? "");
        if (n === undefined) return fail(`killall: Unknown signal ${args[i] ?? ""}`, 1);
        sig = n;
      } else if (a === "-u" || a === "--user") {
        const v = args[++i] ?? "";
        const u = /^\d+$/.test(v) ? Number(v) : w.user(v)?.uid;
        if (u === undefined) return fail(`killall: Invalid user name: ${v}`, 1);
        user = u;
      } else if (a === "-q" || a === "--quiet") quiet = true;
      else if (a === "-v" || a === "--verbose") verbose = true;
      else if (a === "-r" || a === "--regexp") regexp = true;
      else if (a === "-I" || a === "--ignore-case") icase = true;
      else if (["-e", "--exact", "-w", "--wait", "-i", "--interactive", "-g", "--process-group"].includes(a)) continue;
      else if (a.startsWith("-") && a.length > 1) {
        const n = sigNumber(a.slice(1));
        if (n === undefined) return fail(`killall: Unknown signal ${a.slice(1)}`, 1);
        sig = n;
      } else names.push(a);
    }
    if (!names.length) return fail(usage, 1);
    let out = "";
    let err = "";
    let code = 0;
    const self = P.claimTransient("killall");
    for (const name of names) {
      const re = regexp ? new RegExp(name, icase ? "i" : "") : null;
      const hits = P.list().filter((p) => {
        if (p.pid === self || p.kernel || p.state === "Z" && false) return false;
        if (user !== undefined && p.uid !== user) return false;
        if (re) return re.test(p.comm);
        return icase ? p.comm.toLowerCase() === name.slice(0, 15).toLowerCase() : p.comm === name.slice(0, 15);
      });
      if (!hits.length) {
        if (!quiet) err += `killall: ${name}: no process found\n`;
        code = 1;
        continue;
      }
      for (const p of hits) {
        if (p.pid === w.shellPid) continue;
        const r = P.kill(p.pid, sig, me());
        if (!r.ok) {
          if (!quiet) err += `killall: Cannot kill process ${p.pid}: ${r.err === "EPERM" ? "Operation not permitted" : "No such process"}\n`;
          code = 1;
        } else if (verbose) out += `Killed ${p.comm}(${p.pid}) with signal ${sig}\n`;
      }
    }
    return { stdout: out, stderr: err, exitCode: code };
  });

  // ---------------- nice / renice ----------------
  const niceCmd = defineCommand("nice", async (args, ctx) => {
    const shellNice = P.procs.get(w.shellPid)?.nice ?? 0;
    const hint = "Try 'nice --help' for more information.";
    let adj: number | undefined;
    let i = 0;
    const parseAdj = (v: string): number | string => {
      if (!/^[-+]?\d+$/.test(v)) return `nice: invalid adjustment '${v}'`;
      return Number(v);
    };
    while (i < args.length) {
      const a = args[i];
      if (a === "--") { i++; break; }
      if (a === "-n" || a === "--adjustment") {
        if (i + 1 >= args.length) return fail(`nice: option requires an argument -- 'n'\n${hint}`, 125);
        const r = parseAdj(args[i + 1]);
        if (typeof r === "string") return fail(r, 125);
        adj = r;
        i += 2;
      } else if (a.startsWith("--adjustment=")) {
        const r = parseAdj(a.slice(13));
        if (typeof r === "string") return fail(r, 125);
        adj = r;
        i++;
      } else if (/^-n[-+]?\d+$/.test(a)) {
        adj = Number(a.slice(2));
        i++;
      } else if (/^-\d+$/.test(a)) {
        adj = Number(a.slice(1)); // nice -5 cmd = +5
        i++;
      } else if (/^--\d+$/.test(a)) {
        adj = -Number(a.slice(2));
        i++;
      } else if (a.startsWith("--")) return fail(`nice: unrecognized option '${a}'\n${hint}`, 125);
      else if (a.startsWith("-") && a.length > 1) return fail(`nice: invalid option -- '${a.slice(1)}'\n${hint}`, 125);
      else break;
    }
    const cmd = args.slice(i);
    if (!cmd.length) {
      if (adj !== undefined) return fail(`nice: a command must be given with an adjustment\n${hint}`, 125);
      return { stdout: shellNice + "\n", stderr: "", exitCode: 0 };
    }
    const want = Math.max(-20, Math.min(19, shellNice + (adj ?? 10)));
    let err = "";
    let nv = want;
    if (w.cur.uid !== 0 && want < shellNice) {
      err = "nice: cannot set niceness: Permission denied\n";
      nv = shellNice;
    }
    const prev = w.niceFor;
    w.niceFor = nv;
    try {
      const r = await ctx.exec!(cmd.map(quoteArg).join(" "), { cwd: ctx.cwd, env: ctx.env });
      return { stdout: r.stdout, stderr: err + r.stderr, exitCode: r.exitCode };
    } finally {
      w.niceFor = prev;
    }
  });

  const renice = defineCommand("renice", async (args) => {
    const hint = "Try 'renice --help' for more information.";
    let prio: number | undefined;
    let kind: "p" | "g" | "u" = "p";
    const targets: { kind: "p" | "g" | "u"; id: string }[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-n" || a === "--priority") {
        const v = args[++i];
        if (v === undefined || !/^[-+]?\d+$/.test(v)) return fail(`renice: invalid priority '${v ?? ""}'\n${hint}`, 1);
        prio = Number(v);
      } else if (a === "-p" || a === "--pid") kind = "p";
      else if (a === "-g" || a === "--pgrp") kind = "g";
      else if (a === "-u" || a === "--user") kind = "u";
      else if (a.startsWith("-") && a.length > 1 && !/^-\d+$/.test(a)) return fail(`renice: unrecognized option '${a}'\n${hint}`, 1);
      else if (prio === undefined && /^[-+]?\d+$/.test(a) && !targets.length) prio = Number(a);
      else targets.push({ kind, id: a });
    }
    if (prio === undefined || !targets.length) return fail(`renice: not enough arguments\n${hint}`, 1);
    let out = "";
    let err = "";
    let code = 0;
    for (const t of targets) {
      const label = t.kind === "p" ? "process ID" : t.kind === "g" ? "process group ID" : "user ID";
      let pids: number[] = [];
      let idText = t.id;
      if (t.kind === "u") {
        const u = /^\d+$/.test(t.id) ? { uid: Number(t.id) } : w.user(t.id);
        if (!u) { err += `renice: unknown user ${t.id}\n`; code = 1; continue; }
        idText = String(u.uid);
        pids = P.list().filter((p) => p.uid === u.uid && !p.transient).map((p) => p.pid);
      } else if (!/^\d+$/.test(t.id)) {
        err += `renice: invalid value\n${hint}\n`;
        code = 1;
        continue;
      } else if (t.kind === "g") pids = P.list().filter((p) => p.pgid === Number(t.id)).map((p) => p.pid);
      else pids = [Number(t.id)];
      if (!pids.length) {
        err += `renice: failed to get priority for ${idText} (${label}): No such process\n`;
        code = 1;
        continue;
      }
      for (const pid of pids) {
        const p = P.proc(pid);
        const old = p?.nice ?? 0;
        const r = P.setNice(pid, prio, me());
        if (r === "ok") out += `${t.kind === "u" ? idText : pid} (${label}) old priority ${old}, new priority ${Math.max(-20, Math.min(19, prio))}\n`;
        else {
          err += r === "ESRCH" ? `renice: failed to get priority for ${pid} (${label}): No such process\n` : `renice: failed to set priority for ${t.kind === "u" ? idText : pid} (${label}): Permission denied\n`;
          code = 1;
          if (t.kind === "u") break;
        }
      }
    }
    return { stdout: out, stderr: err, exitCode: code };
  });

  // ---------------- uptime ----------------
  const sessionsCount = () => P.list().filter((p) => p.comm === "bash" && p.cmd === "-bash" && p.tty.startsWith("pts")).length;
  const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const upText = (): string => {
    const s = P.uptimeSec();
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d) return `${d} day${d > 1 ? "s" : ""}, ${String(h).padStart(2)}:${pad2(m)}`;
    if (h) return `${String(h).padStart(2)}:${pad2(m)}`;
    return `${m} min`;
  };
  const la = () => P.loadavg().map((x) => x.toFixed(2)).join(", ");
  const uptime = defineCommand("uptime", async (args) => {
    P.bump();
    const p = parseArgs(args, { short: "psV", long: { pretty: "p", since: "s", version: "V" } });
    if (p.bad) return fail(`uptime: invalid option -- '${p.bad.replace(/^-+/, "")}'\nUsage:\n uptime [options]\n\nOptions:\n -p, --pretty   show uptime in pretty format\n -h, --help     display this help and exit\n -s, --since    system up since\n -V, --version  output version information and exit\n\nFor more details see uptime(1).`, 1);
    if (p.flags.has("V")) return { stdout: "uptime from procps-ng 3.3.17\n", stderr: "", exitCode: 0 };
    if (p.flags.has("s")) {
      const d = new Date(P.bootAt);
      return { stdout: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clock(d)}\n`, stderr: "", exitCode: 0 };
    }
    if (p.flags.has("p")) {
      const s = P.uptimeSec();
      const parts: string[] = [];
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d) parts.push(`${d} day${d > 1 ? "s" : ""}`);
      if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
      parts.push(`${m} minute${m === 1 ? "" : "s"}`);
      return { stdout: `up ${parts.join(", ")}\n`, stderr: "", exitCode: 0 };
    }
    const n = sessionsCount();
    return { stdout: ` ${clock(new Date())} up ${upText()},  ${n} user${n === 1 ? "" : "s"},  load average: ${la()}\n`, stderr: "", exitCode: 0 };
  });

  // ---------------- top ----------------
  const top = defineCommand("top", async (args) => {
    P.bump();
    const hint = "\nUsage:\n top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]";
    let iterations = 1;
    let sortBy = "%CPU";
    let users: number[] = [];
    let pidList: number[] | null = null;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      const val = (): string => args[++i] ?? "";
      if (a === "-b" || a === "-c" || a === "-H" || a === "-i" || a === "-S" || a === "-E" || a === "-e" || a === "-1" || a === "-bn1") {
        if (a === "-bn1") iterations = 1;
        continue;
      }
      if (/^-b?n\d+$/.test(a)) { iterations = Number(a.replace(/^-b?n/, "")); continue; }
      if (a === "-bn") { iterations = Number(val()) || 1; continue; }
      if (a === "-n") { iterations = Number(val()); if (!(iterations > 0)) return fail(`top: bad iterations argument '${args[i]}'${hint}`, 1); continue; }
      if (a === "-d" || a === "-w") { val(); continue; }
      if (/^-[dw]\S+$/.test(a)) continue;
      if (a === "-o") { sortBy = val().toUpperCase(); continue; }
      if (a === "-u" || a === "-U") {
        const v = val();
        const u = /^\d+$/.test(v) ? Number(v) : w.user(v)?.uid;
        if (u === undefined) return fail(`top: unknown user name '${v}'${hint}`, 1);
        users = [u];
        continue;
      }
      if (a === "-p") { pidList = val().split(",").map(Number); continue; }
      if (a === "-h" || a === "-v") return { stdout: "  procps-ng 3.3.17\nUsage:\n  top -hv | -bcEeHiOSs1 -d secs -n max -u|U user -p pid(s) -o field -w [cols]\n", stderr: "", exitCode: 0 };
      if (/^-b[A-Za-z]*$/.test(a)) continue;
      return fail(`top: unknown option '${a.replace(/^-/, "")}'${hint}`, 1);
    }
    const self = P.claimTransient("top") ?? P.spawnTransient("top -b -n 1");
    const procs = P.list();
    const running = procs.filter((p) => p.state === "R").length;
    const sleeping = procs.filter((p) => p.state === "S" || p.state === "I" || p.state === "D").length;
    const stopped = procs.filter((p) => p.state === "T").length;
    const zombies = procs.filter((p) => p.state === "Z").length;
    const us = Math.min(100, procs.reduce((s, p) => s + (p.kernel ? 0 : p.cpu), 0));
    const f1 = (n: number) => n.toFixed(1).padStart(5);
    const totalMiB = MEM_TOTAL_KB / 1024;
    const usedKb = procs.reduce((s, p) => s + p.rss, 0) + 214_000;
    const freeKb = Math.max(0, MEM_TOTAL_KB - usedKb - 842_000);
    const lines: string[] = [];
    const snap = () => {
      const now = new Date();
      lines.push(`top - ${clock(now)} up ${upText()},  ${sessionsCount()} user${sessionsCount() === 1 ? "" : "s"},  load average: ${la()}`);
      lines.push(`Tasks: ${String(procs.length).padStart(3)} total,  ${String(running).padStart(2)} running, ${String(sleeping).padStart(3)} sleeping,  ${String(stopped).padStart(2)} stopped,  ${String(zombies).padStart(2)} zombie`);
      lines.push(`%Cpu(s):${f1(us)} us,${f1(us > 0 ? 0.3 : 0.2)} sy,${f1(0)} ni,${f1(Math.max(0, 99.8 - us))} id,${f1(0)} wa,${f1(0)} hi,${f1(0)} si,${f1(0)} st`);
      lines.push(`MiB Mem : ${totalMiB.toFixed(1).padStart(8)} total, ${(freeKb / 1024).toFixed(1).padStart(8)} free, ${(usedKb / 1024).toFixed(1).padStart(8)} used, ${(842_000 / 1024).toFixed(1).padStart(8)} buff/cache`);
      lines.push(`MiB Swap: ${"2048.0".padStart(8)} total, ${"2048.0".padStart(8)} free, ${"0.0".padStart(8)} used. ${((freeKb + 700_000) / 1024).toFixed(1).padStart(8)} avail Mem `);
      lines.push("");
      lines.push("    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND");
      const sel = procs
        .filter((p) => (users.length ? users.includes(p.uid) : true) && (pidList ? pidList.includes(p.pid) : true))
        .sort((a, b) => {
          const key = (p: Proc): number =>
            sortBy === "%MEM" || sortBy === "RES" ? p.rss : sortBy === "PID" ? -p.pid : sortBy === "TIME+" ? P.cpuTime(p) : sortBy === "VIRT" ? p.vsz : p.cpu;
          return key(b) - key(a) || a.pid - b.pid;
        });
      for (const p of sel) {
        const u = P.userName(p.uid);
        const mem = (v: number) => (v > 999_999 ? (v / 1024 / 1024).toFixed(1) + "g" : v > 99_999 ? Math.round(v / 1024) + "m" : String(v));
        const t = P.cpuTime(p);
        const tm = `${Math.floor(t / 60)}:${pad2(t % 60)}.00`;
        const pr = p.nice === -20 && p.kernel ? "0" : String(20 + p.nice);
        const st = p.pid === self ? "R" : p.state;
        lines.push(
          `${String(p.pid).padStart(7)} ${(u.length > 8 ? u.slice(0, 7) + "+" : u).padEnd(8)} ${pr.padStart(3)} ${String(p.nice).padStart(3)} ${mem(p.vsz).padStart(7)} ${mem(p.rss).padStart(6)} ${mem(Math.floor(p.rss * 0.7)).padStart(6)} ${st} ${p.cpu.toFixed(1).padStart(5)} ${((p.rss / MEM_TOTAL_KB) * 100).toFixed(1).padStart(5)} ${tm.padStart(9)} ${p.kernel ? p.comm : p.cmd.split(/\s+/)[0].replace(/^.*\//, "").replace(/^-/, "") || p.comm}`,
        );
      }
    };
    for (let n = 0; n < iterations; n++) {
      snap();
      if (n < iterations - 1) lines.push("");
    }
    return { stdout: lines.join("\n") + "\n", stderr: "", exitCode: 0 };
  });

  // ---------------- sleep, jobs, __bg ----------------
  const parseDuration = (s: string): number | null => {
    const m = /^(\d*\.?\d+)([smhd]?)$/.exec(s);
    if (!m) return null;
    const mult = { "": 1, s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "" | "s" | "m" | "h" | "d"];
    return Number(m[1]) * mult;
  };
  const sleep = defineCommand("sleep", async (args) => {
    P.bump();
    if (!args.length) return fail("sleep: missing operand\nTry 'sleep --help' for more information.", 1);
    for (const a of args) if (parseDuration(a) === null) return fail(`sleep: invalid time interval '${a}'\nTry 'sleep --help' for more information.`, 1);
    return { stdout: "", stderr: "", exitCode: 0 }; // в тренажёре foreground sleep не блокирует
  });

  const jobs = defineCommand("jobs", async (args) => {
    const p = parseArgs(args, { short: "lpnrs" });
    if (p.bad) return fail(`bash: jobs: -${p.bad}: invalid option\njobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]`, 2);
    P.tick();
    const list = P.jobs.filter((j) => (p.flags.has("r") ? j.status === "Running" : p.flags.has("s") ? j.status === "Stopped" : true));
    if (p.flags.has("p")) return { stdout: list.map((j) => j.pid).join("\n") + (list.length ? "\n" : ""), stderr: "", exitCode: 0 };
    const out = list.map((j) => P.jobLine(j, p.flags.has("l"))).join("\n");
    for (const j of list) if (j.status !== "Running" && j.status !== "Stopped") P.jobs = P.jobs.filter((x) => x !== j);
    return { stdout: out ? out + "\n" : "", stderr: "", exitCode: 0 };
  });

  const bg = defineCommand("bg", async (args) => {
    const spec = args[0] ?? "%+";
    const pid = jobPid(spec.startsWith("%") ? spec : "%" + spec);
    const j = P.jobs.find((x) => x.pid === pid);
    if (!j) return fail(`bash: bg: ${args[0] ? spec : "current"}: no such job`, 1);
    if (j.status !== "Stopped") return fail(`bash: bg: job ${j.id} already in background`, 0);
    P.kill(j.pid, 18, me());
    j.status = "Running";
    return { stdout: `[${j.id}]+ ${j.cmd} &\n`, stderr: "", exitCode: 0 };
  });

  const disown = defineCommand("disown", async (args) => {
    const spec = args.find((a) => !a.startsWith("-")) ?? "%+";
    const pid = jobPid(spec.startsWith("%") ? spec : "%" + spec);
    const j = P.jobs.find((x) => x.pid === pid);
    if (!j) return fail(`bash: disown: ${args[0] ? spec : "current"}: no such job`, 1);
    P.jobs = P.jobs.filter((x) => x !== j);
    return { stdout: "", stderr: "", exitCode: 0 };
  });

  const stubs = ["fg", "wait"].map((name) =>
    defineCommand(name, async () => {
      onUnsupported(name);
      w.unsupported.push(name);
      return fail(`${name}: тренажёр такую встроенную команду пока не умеет (записал в журнал)`, 1);
    }),
  );

  // Фоновый запуск: Shell превращает «cmd &» в «__bg cmd».
  const bgCmd = defineCommand("__bg", async (args, ctx) => {
    if (!args.length) return { stdout: "", stderr: "", exitCode: 0 };
    let argv = [...args];
    let nice = P.procs.get(w.shellPid)?.nice ?? 0;
    let user: string | undefined;
    // обёртки: sudo [-u user], nohup, nice -n N, time
    for (let guard = 0; guard < 6; guard++) {
      const h = argv[0];
      if (h === "nice") {
        let j = 1;
        let adj = 10;
        if (argv[j] === "-n") { adj = Number(argv[j + 1]); j += 2; } else if (/^-n\S+$/.test(argv[j] ?? "")) { adj = Number(argv[j].slice(2)); j++; } else if (/^-\d+$/.test(argv[j] ?? "")) { adj = Number(argv[j].slice(1)); j++; } else if ((argv[j] ?? "").startsWith("--adjustment=")) { adj = Number(argv[j].slice(13)); j++; }
        nice += Number.isFinite(adj) ? adj : 0;
        argv = argv.slice(j);
      } else if (h === "sudo") {
        let j = 1;
        if (argv[j] === "-u") { user = argv[j + 1]; j += 2; } else user = "root";
        argv = argv.slice(j);
      } else if (h === "nohup" || h === "time" || h === "exec") argv = argv.slice(1);
      else break;
    }
    const cmdline = argv.join(" ");
    const first = (argv[0] ?? "").replace(/^.*\//, "");
    const longRunning =
      ["sleep", "ping", "top", "watch", "yes", "nc", "stress", "stress-ng", "tailf", "python3", "python", "journalctl", "vmstat", "iostat", "dd"].includes(first) ||
      (first === "tail" && argv.some((a) => /^-[a-zA-Z]*[fF]/.test(a) || a === "--follow")) ||
      (first === "cat" && argv.length === 1);
    if (longRunning) {
      let lifetime: number | undefined;
      if (first === "sleep") {
        const d = parseDuration(argv[1] ?? "");
        if (d === null || argv.length < 2) return fail(argv.length < 2 ? "sleep: missing operand\nTry 'sleep --help' for more information." : `sleep: invalid time interval '${argv[1]}'\nTry 'sleep --help' for more information.`, 1);
        lifetime = argv.slice(1).reduce((s, a) => s + (parseDuration(a) ?? 0), 0);
      }
      const runUser = user ?? w.cur.name;
      P.bump();
      const busy = first === "yes" || first === "stress" || first === "stress-ng" || first === "dd";
      const pid = P.spawn({
        cmd: cmdline, user: runUser, ppid: w.shellPid, tty: "pts/0", nice: nice, lifetime,
        state: busy ? "R" : "S", cpu: busy ? 99.6 : 0, wchan: first === "sleep" ? "hrtime" : busy ? "-" : "do_epo",
      });
      const job = P.addJob(pid, [...args].join(" "));
      return { stdout: `[${job.id}] ${pid}\n`, stderr: "", exitCode: 0 };
    }
    // короткая команда: выполняем сразу, «задание» сразу завершено
    P.bump();
    const fakePid = P.nextPid++;
    const job = P.addJob(fakePid, args.join(" "));
    job.status = "Done";
    job.notified = false;
    let r;
    try {
      r = await ctx.exec!(args.map(quoteArg).join(" "), { cwd: ctx.cwd, env: ctx.env });
    } catch {
      r = { stdout: "", stderr: "", exitCode: 1 };
    }
    return { stdout: `[${job.id}] ${fakePid}\n` + r.stdout, stderr: r.stderr, exitCode: 0 };
  });

  return [
    ps, matcher("pgrep"), matcher("pkill"), pidof, kill, killall, niceCmd, renice, uptime, top, sleep, jobs, bg, disown, bgCmd, ...stubs,
  ];
}

function quoteArg(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
