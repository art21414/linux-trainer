// Диски и монтирование: lsblk, blkid, df, du, mount, umount, findmnt, mkfs.*, swapon, free,
// truncate, fallocate, dd и systemctl daemon-reload. Вывод — как в Rocky Linux 9.
import { serviceAction } from "./services";
import { defineCommand } from "just-bash";
import type { Command, ExecResult } from "just-bash";
import type { World } from "../world";
import { basename, normalize, resolve } from "../path";
import { ok } from "../util";
import {
  BLOCK, GiB, KiB, MiB, ext4Inodes, ext4Journal, fullOpts, fstabLine, humanCeil, humanFree, humanLsblk, newFs, parseSize, xfsInodes,
} from "../storage";
import type { BlockDev, Mount, Usage } from "../storage";

const res = (stdout: string, stderr = "", exitCode = 0): ExecResult => ({ stdout, stderr: stderr && !stderr.endsWith("\n") ? stderr + "\n" : stderr, exitCode });

// ---------- разбор опций в стиле GNU ----------

interface ArgSpec {
  /** Короткие флаги без значения. */
  flags?: string;
  /** Короткие опции со значением. */
  vals?: string;
  /** Длинные: имя → [ключ, none|req|opt]. */
  long?: Record<string, [string, "none" | "req" | "opt"]>;
}

class Args {
  opts: [string, string | undefined][] = [];
  rest: string[] = [];
  bad?: string;
  missing?: string;
  has(k: string): boolean {
    return this.opts.some(([x]) => x === k);
  }
  last(k: string): string | undefined {
    for (let i = this.opts.length - 1; i >= 0; i--) if (this.opts[i][0] === k) return this.opts[i][1];
    return undefined;
  }
  all(k: string): string[] {
    return this.opts.filter(([x]) => x === k).map(([, v]) => v ?? "");
  }
}

function gnuArgs(args: string[], spec: ArgSpec): Args {
  const r = new Args();
  const flags = spec.flags ?? "";
  const vals = spec.vals ?? "";
  const long = spec.long ?? {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      r.rest.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--") && a.length > 2) {
      const eq = a.indexOf("=");
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      let key = Object.keys(long).find((k) => k === name);
      if (!key) {
        const cands = Object.keys(long).filter((k) => k.startsWith(name));
        if (cands.length === 1 || (cands.length > 1 && new Set(cands.map((c) => long[c][0])).size === 1)) key = cands[0];
      }
      if (!key) {
        r.bad ??= a;
        continue;
      }
      const [k, kind] = long[key];
      if (kind === "none") r.opts.push([k, undefined]);
      else if (kind === "opt") r.opts.push([k, eq >= 0 ? a.slice(eq + 1) : undefined]);
      else if (eq >= 0) r.opts.push([k, a.slice(eq + 1)]);
      else if (i + 1 < args.length) r.opts.push([k, args[++i]]);
      else r.missing ??= `--${key}`;
      continue;
    }
    if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (vals.includes(c)) {
          const v = a.slice(j + 1);
          if (v) r.opts.push([c, v]);
          else if (i + 1 < args.length) r.opts.push([c, args[++i]]);
          else r.missing ??= c;
          break;
        }
        if (flags.includes(c)) r.opts.push([c, undefined]);
        else {
          r.bad ??= c;
          break;
        }
      }
      continue;
    }
    r.rest.push(a);
  }
  return r;
}

function optError(cmd: string, a: Args): ExecResult | null {
  if (a.bad) {
    const m = a.bad.startsWith("--") ? `unrecognized option '${a.bad}'` : `invalid option -- '${a.bad}'`;
    return res("", `${cmd}: ${m}\nTry '${cmd} --help' for more information.`, 1);
  }
  if (a.missing) {
    const m = a.missing.startsWith("--") ? `option '${a.missing}' requires an argument` : `option requires an argument -- '${a.missing}'`;
    return res("", `${cmd}: ${m}\nTry '${cmd} --help' for more information.`, 1);
  }
  return null;
}

/** Ключи, которые есть у настоящей команды, но не реализованы тренажёром. */
function notYet(cmd: string, a: Args, keys: string[]): ExecResult | null {
  for (const k of keys) if (a.has(k)) return res("", `${cmd}: тренажёр пока не умеет ключ ${k.length > 1 ? "--" : "-"}${k}`, 1);
  return null;
}

// ---------- таблицы ----------

function table(rows: string[][], right: boolean[], minW: number[] = []): string[] {
  const cols = rows[0].length;
  const w = Array.from({ length: cols }, (_, c) => Math.max(minW[c] ?? 0, ...rows.map((r) => r[c].length)));
  return rows.map((r) =>
    r
      .map((cell, c) => (c === cols - 1 && !right[c] ? cell : right[c] ? cell.padStart(w[c]) : cell.padEnd(w[c])))
      .join(" "),
  );
}

const isRoot = (w: World) => w.cur.uid === 0;

// =====================================================================
// lsblk
// =====================================================================

const LSBLK_COLS = [
  "NAME", "KNAME", "PATH", "MAJ:MIN", "MAJ", "MIN", "RM", "SIZE", "RO", "TYPE", "MOUNTPOINT", "MOUNTPOINTS", "FSTYPE", "FSVER", "LABEL", "UUID",
  "PARTUUID", "PARTLABEL", "FSAVAIL", "FSSIZE", "FSUSED", "FSUSE%", "PKNAME", "MODEL", "SERIAL", "ROTA", "STATE", "OWNER", "GROUP", "MODE", "PTTYPE", "HCTL",
];
const LSBLK_RIGHT = new Set(["RM", "SIZE", "RO", "ROTA", "FSAVAIL", "FSSIZE", "FSUSED", "FSUSE%", "MAJ", "MIN"]);

function lsblkCommand(w: World): Command {
  return defineCommand("lsblk", async (args) => {
    const a = gnuArgs(args, {
      flags: "abdfilnprJtmDOsVhSzPx",
      vals: "oeEIx",
      long: {
        all: ["a", "none"], bytes: ["b", "none"], nodeps: ["d", "none"], fs: ["f", "none"], list: ["l", "none"], noheadings: ["n", "none"],
        paths: ["p", "none"], raw: ["r", "none"], output: ["o", "req"], pairs: ["P", "none"], json: ["J", "none"], ascii: ["i", "none"],
        exclude: ["e", "req"], include: ["I", "req"], topology: ["t", "none"], perms: ["m", "none"], inverse: ["s", "none"], version: ["V", "none"],
        "output-all": ["O", "none"], sort: ["x", "req"], help: ["h", "none"],
      },
    });
    const e = optError("lsblk", a) ?? notYet("lsblk", a, ["J", "t", "m", "D", "O", "s", "S", "z", "e", "E", "I", "x"]);
    if (e) return e;
    if (a.has("V")) return ok("lsblk from util-linux 2.37.4\n");
    const st = w.storage;
    const paths = a.has("p");
    const fsMode = a.has("f");
    let cols = fsMode
      ? ["NAME", "FSTYPE", "FSVER", "LABEL", "UUID", "FSAVAIL", "FSUSE%", "MOUNTPOINTS"]
      : ["NAME", "MAJ:MIN", "RM", "SIZE", "RO", "TYPE", "MOUNTPOINTS"];
    const o = a.last("o");
    if (o !== undefined) {
      const req = o.replace(/^\+/, "").split(",").filter(Boolean).map((c) => c.toUpperCase());
      for (const c of req) if (!LSBLK_COLS.includes(c)) return res("", `lsblk: unknown column: ${c}`, 1);
      cols = o.startsWith("+") ? [...cols, ...req] : req;
    }
    // корни
    let roots: BlockDev[];
    if (a.rest.length) {
      roots = [];
      for (const r of a.rest) {
        const d = st.resolveDev(r);
        if (!d) return res("", `lsblk: ${r}: not a block device`, 32);
        roots.push(d);
      }
    } else roots = st.devs.filter((d) => d.type === "disk").sort((x, y) => x.minor - y.minor);

    const scan = await st.scan();
    const rows: { dev: BlockDev; prefix: string }[] = [];
    const walk = (d: BlockDev, prefix: string, childPrefix: string) => {
      rows.push({ dev: d, prefix });
      if (a.has("d")) return;
      const kids = st.children(d.name);
      kids.forEach((k, i) => {
        const last = i === kids.length - 1;
        walk(k, childPrefix + (last ? "└─" : "├─"), childPrefix + (last ? "  " : "│ "));
      });
    };
    for (const r of roots) walk(r, "", "");
    const tree = !a.has("l") && !a.has("r") && !a.has("P");

    const bytes = a.has("b");
    const size = (n: number) => (bytes ? String(n) : humanLsblk(n));
    const cell = (c: string, d: BlockDev, prefix: string): string[] => {
      const mnts = st.mountsOf(d.name);
      const first = mnts[0];
      const fs = d.fs;
      const us = first ? st.usageOf(first, scan) : null;
      const path = st.devPath(d);
      switch (c) {
        case "NAME": return [(tree ? prefix : "") + (paths ? path : d.name)];
        case "KNAME": return [paths ? `/dev/${d.kname}` : d.kname];
        case "PATH": return [path];
        case "MAJ:MIN": return [`${String(d.major).padStart(3)}:${d.minor}`];
        case "MAJ": return [String(d.major)];
        case "MIN": return [String(d.minor)];
        case "RM": return ["0"];
        case "SIZE": return [size(d.size)];
        case "RO": return ["0"];
        case "TYPE": return [d.type === "lvm" ? "lvm" : d.type];
        case "MOUNTPOINT": return [st.mountpointsOf(d)[0] ?? ""];
        case "MOUNTPOINTS": {
          const m = st.mountpointsOf(d);
          return m.length ? m : [""];
        }
        case "FSTYPE": return [fs?.type ?? ""];
        case "FSVER": return [fs ? { xfs: "", ext4: "1.0", swap: "1", LVM2_member: "LVM2 001" }[fs.type] : ""];
        case "LABEL": return [fs?.label ?? ""];
        case "UUID": return [fs?.uuid ?? ""];
        case "PARTUUID": return [d.partuuid ?? ""];
        case "PARTLABEL": return [""];
        case "FSAVAIL": return [us ? size(us.avail) : ""];
        case "FSSIZE": return [us ? size(us.size) : ""];
        case "FSUSED": return [us ? size(us.used) : ""];
        case "FSUSE%": return [us ? `${us.avail + us.used ? Math.round((us.used * 100) / (us.used + us.avail)) : 0}%` : ""];
        case "PKNAME": return [d.parent ? (paths ? `/dev/${st.dev(d.parent)!.kname}` : st.dev(d.parent)!.kname) : ""];
        case "MODEL": return [""];
        case "SERIAL": return [""];
        case "ROTA": return [d.type === "disk" ? "1" : "1"];
        case "STATE": return [d.type === "part" ? "" : "running"];
        case "OWNER": return ["root"];
        case "GROUP": return ["disk"];
        case "MODE": return ["brw-rw----"];
        case "PTTYPE": return [d.type === "disk" ? (st.children(d.name).length ? "dos" : "") : ""];
        case "HCTL": return [""];
        default: return [""];
      }
    };
    const data = rows.map((r) => cols.map((c) => cell(c, r.dev, r.prefix)));

    if (a.has("P")) {
      const lines = data.map((r) => cols.map((c, i) => `${c.replace(":", "_").replace("%", "")}="${r[i].join(" ")}"`).join(" "));
      return ok(lines.join("\n") + "\n");
    }
    if (a.has("r")) {
      const lines = data.map((r) => r.map((cl) => cl.join(" ").replace(/ /g, "\\x20")).join(" "));
      const head = a.has("n") ? [] : [cols.join(" ")];
      return ok([...head, ...lines].join("\n") + "\n");
    }
    // многострочные ячейки (несколько точек монтирования)
    const w0 = cols.map((c, i) => Math.max(c.length, ...data.map((r) => Math.max(...r[i].map((s) => s.length)))));
    const right = cols.map((c) => LSBLK_RIGHT.has(c));
    const fmt = (cells: string[]) =>
      cells.map((s, i) => (i === cols.length - 1 && !right[i] ? s : right[i] ? s.padStart(w0[i]) : s.padEnd(w0[i]))).join(" ");
    const lines: string[] = [];
    if (!a.has("n")) lines.push(fmt(cols));
    for (const r of data) {
      const h = Math.max(...r.map((c) => c.length));
      for (let i = 0; i < h; i++) lines.push(fmt(r.map((c) => c[i] ?? "")));
    }
    return ok(lines.join("\n") + "\n");
  });
}

// =====================================================================
// blkid
// =====================================================================

function blkidCommand(w: World): Command {
  return defineCommand("blkid", async (args) => {
    const a = gnuArgs(args, {
      flags: "pcgdhV",
      vals: "osLUtn",
      long: { output: ["o", "req"], match: ["s", "req"], "match-tag": ["s", "req"], label: ["L", "req"], uuid: ["U", "req"], probe: ["p", "none"], "match-token": ["t", "req"], version: ["V", "none"] },
    });
    const e = optError("blkid", a) ?? notYet("blkid", a, ["g", "d", "n"]);
    if (e) return e;
    const st = w.storage;
    if (!isRoot(w)) return res("", "", 2);
    const tagsWanted = a.all("s").map((t) => t.toUpperCase());
    const mode = a.last("o") ?? "full";
    if (!["full", "value", "list", "device", "udev", "export"].includes(mode)) return res("", `blkid: unsupported output format ${mode}`, 4);

    const L = a.last("L");
    const U = a.last("U");
    if (L !== undefined || U !== undefined) {
      const d = st.resolveDev(L !== undefined ? `LABEL=${L}` : `UUID=${U}`);
      return d ? ok(st.devPath(d) + "\n") : res("", "", 2);
    }
    let devs: BlockDev[];
    if (a.rest.length) {
      devs = [];
      for (const r of a.rest) {
        const d = st.resolveDev(r);
        if (d?.fs) devs.push(d);
      }
    } else devs = st.devs.filter((d) => d.fs);
    const t = a.last("t");
    if (t) {
      const [k, v] = t.split("=");
      devs = devs.filter((d) => (k === "TYPE" ? d.fs!.type === v : k === "UUID" ? d.fs!.uuid === v : k === "LABEL" ? d.fs!.label === v : false));
    }
    const out: string[] = [];
    for (const d of devs) {
      const f = d.fs!;
      const tags: [string, string][] = [];
      if (f.label) tags.push(["LABEL", f.label]);
      tags.push(["UUID", f.uuid]);
      if (f.type === "xfs") tags.push(["BLOCK_SIZE", "512"]);
      if (f.type === "ext4") tags.push(["BLOCK_SIZE", "4096"]);
      tags.push(["TYPE", f.type]);
      if (d.partuuid) tags.push(["PARTUUID", d.partuuid]);
      const sel = tagsWanted.length ? tags.filter(([k]) => tagsWanted.includes(k)) : tags;
      const path = st.devPath(d);
      if (mode === "value") for (const [, v] of sel) out.push(v);
      else if (mode === "device") out.push(path);
      else if (mode === "export" || mode === "udev") {
        out.push(`DEVNAME=${path}`, ...sel.map(([k, v]) => `${k}=${v}`), "");
      } else if (sel.length) out.push(`${path}: ${sel.map(([k, v]) => `${k}="${v}"`).join(" ")}`);
    }
    if (!devs.length) return res("", "", 2);
    return ok(out.length ? out.join("\n") + "\n" : "");
  });
}

// =====================================================================
// df
// =====================================================================

const DF_HEADERS: Record<string, string> = {
  source: "Filesystem", fstype: "Type", itotal: "Inodes", iused: "IUsed", iavail: "IFree", ipcent: "IUse%", size: "1K-blocks", used: "Used",
  avail: "Avail", pcent: "Use%", file: "File", target: "Mounted on",
};

interface DfRow {
  source: string; fstype: string; usage: Usage; file: string; target: string; hidden: boolean;
}

function parseBlockSize(s: string): { n: number; label: string } | null {
  const m = /^(\d*)([KMGTP]?)(B?)$/i.exec(s);
  if (!m || (!m[1] && !m[2])) return null;
  const mult: Record<string, number> = { "": 1, K: 1024, M: MiB, G: GiB, T: GiB * 1024, P: GiB * 1024 ** 2 };
  const base = (m[1] ? parseInt(m[1], 10) : 1) * mult[m[2].toUpperCase()] * (m[3].toUpperCase() === "B" && m[2] ? 1 : 1);
  return base > 0 ? { n: base, label: `${m[1] || ""}${m[2].toUpperCase()}${m[3]}` || "1" } : null;
}

function dfCommand(w: World): Command {
  return defineCommand("df", async (args, ctx) => {
    const a = gnuArgs(args, {
      flags: "ahHiklmPTv",
      vals: "BtxO",
      long: {
        all: ["a", "none"], "block-size": ["B", "req"], "human-readable": ["h", "none"], si: ["H", "none"], inodes: ["i", "none"], local: ["l", "none"],
        "portability": ["P", "none"], "print-type": ["T", "none"], "type": ["t", "req"], "exclude-type": ["x", "req"], total: ["total", "none"],
        output: ["output", "opt"], sync: ["sync", "none"], "no-sync": ["no-sync", "none"], help: ["help", "none"], version: ["version", "none"],
      },
    });
    const e = optError("df", a);
    if (e) return e;
    if (a.has("version")) return ok("df (GNU coreutils) 8.32\n");
    const st = w.storage;
    const scan = await st.scan();
    const rows: DfRow[] = [];
    const mkRow = (m: Mount, file = "-"): DfRow => ({
      source: m.source, fstype: m.fstype, usage: st.usageOf(m, scan), file, target: m.target, hidden: !!m.dfHidden,
    });
    let code = 0;
    let err = "";
    const inodeMode = a.has("i");
    if (a.rest.length) {
      for (const r of a.rest) {
        const p = resolve(ctx.cwd, r);
        if (!(await w.base.exists(p))) {
          err += `df: ${r}: No such file or directory\n`;
          code = 1;
          continue;
        }
        if (!(await w.canTraverse(p))) {
          err += `df: ${r}: Permission denied\n`;
          code = 1;
          continue;
        }
        rows.push(mkRow(st.mountFor(p), r));
      }
    } else for (const m of st.mounts) rows.push(mkRow(m));

    const inc = a.all("t").flatMap((x) => x.split(","));
    const exc = a.all("x").flatMap((x) => x.split(","));
    let sel = rows.filter((r) => (!inc.length || inc.includes(r.fstype)) && !exc.includes(r.fstype));
    if (!a.rest.length && !a.has("a")) sel = sel.filter((r) => !r.hidden && (r.usage.size > 0 || inodeMode));
    if (!sel.length && !err) return res("", "df: no file systems processed", 1);
    if (!sel.length) return res("", err, code);

    // что показывать
    const human = a.has("h") ? 1024 : a.has("H") ? 1000 : 0;
    const bs = a.last("B") !== undefined ? parseBlockSize(a.last("B")!) : null;
    if (a.last("B") !== undefined && !bs) return res("", `df: invalid --block-size argument '${a.last("B")}'`, 1);
    let unit = 1024;
    let unitLabel = "1K-blocks";
    if (a.has("m")) {
      unit = MiB;
      unitLabel = "1M-blocks";
    } else if (a.has("k")) {
      unit = 1024;
    }
    if (bs) {
      unit = bs.n;
      unitLabel = `${bs.label}-blocks`;
    }
    if (a.has("P")) unitLabel = `${unit === 1024 ? "1024" : unitLabel.replace("-blocks", "")}-blocks`;
    const num = (n: number) => (human ? humanCeil(n, human) : String(Math.ceil(n / unit)));
    const inum = (n: number) => (human ? humanCeil(n, human) : String(n));
    const pct = (used: number, avail: number) => (used + avail > 0 ? `${Math.ceil((used * 100 - 1e-9) / (used + avail))}%` : "-");

    let fields: string[];
    if (a.has("output")) {
      const v = a.last("output");
      fields = v === undefined ? ["source", "fstype", "itotal", "iused", "iavail", "ipcent", "size", "used", "avail", "pcent", "file", "target"] : v.split(",").filter(Boolean);
      for (const f of fields) if (!(f in DF_HEADERS)) return res("", `df: option --output: field '${f}' unknown\nTry 'df --help' for more information.`, 1);
    } else if (inodeMode) fields = a.has("T") ? ["source", "fstype", "itotal", "iused", "iavail", "ipcent", "target"] : ["source", "itotal", "iused", "iavail", "ipcent", "target"];
    else fields = a.has("T") ? ["source", "fstype", "size", "used", "avail", "pcent", "target"] : ["source", "size", "used", "avail", "pcent", "target"];

    if (a.has("total")) {
      const t = sel.reduce(
        (acc, r) => ({
          size: acc.size + r.usage.size, used: acc.used + r.usage.used, avail: acc.avail + r.usage.avail, itotal: acc.itotal + r.usage.itotal,
          iused: acc.iused + r.usage.iused, ifree: acc.ifree + r.usage.ifree,
        }),
        { size: 0, used: 0, avail: 0, itotal: 0, iused: 0, ifree: 0 },
      );
      sel = [...sel, { source: "total", fstype: "-", usage: t, file: "-", target: "-", hidden: false }];
    }
    const header = (f: string) => {
      if (f === "size") return human ? "Size" : unitLabel;
      if (f === "avail") return human || a.has("output") ? "Avail" : a.has("P") ? "Available" : "Available";
      if (f === "pcent") return a.has("P") ? "Capacity" : "Use%";
      return DF_HEADERS[f];
    };
    const cellOf = (f: string, r: DfRow): string => {
      const u = r.usage;
      const zero = u.size === 0 && r.source !== "total" && !u.itotal;
      switch (f) {
        case "source": return r.source;
        case "fstype": return r.fstype;
        case "itotal": return inum(u.itotal);
        case "iused": return inum(u.iused);
        case "iavail": return inum(u.ifree);
        case "ipcent": return u.itotal ? `${Math.ceil((u.iused * 100 - 1e-9) / u.itotal)}%` : "-";
        case "size": return num(u.size);
        case "used": return num(u.used);
        case "avail": return num(u.avail);
        case "pcent": return zero ? "-" : pct(u.used, u.avail);
        case "file": return r.file;
        default: return r.target;
      }
    };
    const leftCols = new Set(["source", "fstype", "file", "target"]);
    const minW = fields.map((f) =>
      f === "source" ? 14 : (f === "size" || f === "used" || f === "avail") && human ? 5 : f === "pcent" || f === "ipcent" ? 4 : 0,
    );
    const lines = table(
      [fields.map(header), ...sel.map((r) => fields.map((f) => cellOf(f, r)))],
      fields.map((f) => !leftCols.has(f)),
      minW,
    );
    return res(lines.join("\n") + "\n", err, code);
  });
}

// =====================================================================
// du
// =====================================================================

function globToRe(g: string): RegExp {
  return new RegExp("^" + g.replace(/[.+^${}()|\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$");
}

function duCommand(w: World): Command {
  return defineCommand("du", async (args, ctx) => {
    const pre = args.map((x) => (x === "--time" ? "--time=mtime" : x));
    const a = gnuArgs(pre, {
      flags: "abchkmsxSLDlP0HV",
      vals: "dBtX",
      long: {
        all: ["a", "none"], "apparent-size": ["apparent-size", "none"], bytes: ["b", "none"], total: ["c", "none"], "max-depth": ["d", "req"],
        "human-readable": ["h", "none"], si: ["si", "none"], summarize: ["s", "none"], "one-file-system": ["x", "none"], exclude: ["exclude", "req"],
        time: ["time", "opt"], "block-size": ["B", "req"], "separate-dirs": ["S", "none"], dereference: ["L", "none"], version: ["V", "none"],
        "count-links": ["l", "none"], "null": ["0", "none"], "threshold": ["t", "req"], "dereference-args": ["D", "none"], "files0-from": ["files0-from", "req"],
        "exclude-from": ["X", "req"], help: ["help", "none"], inodes: ["inodes", "none"],
      },
    });
    const e = optError("du", a) ?? notYet("du", a, ["S", "L", "D", "l", "P", "0", "t", "files0-from", "X", "H"]);
    if (e) return e;
    if (a.has("V")) return ok("du (GNU coreutils) 8.32\n");
    const st = w.storage;
    const apparent = a.has("apparent-size") || a.has("b");
    let maxDepth = Infinity;
    if (a.has("d")) {
      const n = a.last("d")!;
      if (!/^\d+$/.test(n)) return res("", `du: invalid maximum depth '${n}'`, 1);
      maxDepth = parseInt(n, 10);
    }
    if (a.has("s")) {
      if (a.has("d") && maxDepth !== 0) return res("", "du: warning: summarizing conflicts with --max-depth=" + maxDepth + "\nTry 'du --help' for more information.", 1);
      maxDepth = 0;
    }
    let unit = 1024;
    let human = 0;
    if (a.has("h")) human = 1024;
    else if (a.has("si")) human = 1000;
    else if (a.has("b")) unit = 1;
    else if (a.has("m")) unit = MiB;
    else if (a.has("k")) unit = 1024;
    else if (a.has("B")) {
      const b = parseBlockSize(a.last("B")!);
      if (!b) return res("", `du: invalid --block-size argument '${a.last("B")}'`, 1);
      unit = b.n;
    }
    const byInodes = a.has("inodes");
    const fmt = (n: number) => (byInodes ? String(n) : human ? humanCeil(n, human) : String(n === 0 ? 0 : Math.ceil(n / unit)));
    const excludes = a.all("exclude").map(globToRe);
    const showTime = a.has("time");
    const timeFmt = (d: Date) => {
      const p = (x: number) => String(x).padStart(2, "0");
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    let stdout = "";
    let stderr = "";
    let code = 0;
    let grand = 0;
    const targets = a.rest.length ? a.rest : ["."];
    const seen = new Set<string>();

    const emit = (bytes: number, display: string, mtime: Date) => {
      stdout += `${fmt(bytes)}\t${showTime ? timeFmt(mtime) + "\t" : ""}${display}\n`;
    };

    const walk = async (abs: string, display: string, depth: number, startMount: Mount, top: boolean): Promise<number | null> => {
      if (abs === "/proc/.held") return null; // служебный каталог удалённых-но-открытых файлов
      const inf = await w.info(abs);
      if (!inf) return null;
      const m = st.mountFor(abs);
      if (a.has("x") && m.id !== startMount.id && !top) return null;
      const virt = st.virt.get(abs);
      let total = 0;
      let entries = 0;
      let nameBytes = 0;
      if (inf.isDir) {
        if (!isRoot(w) && !(await w.canAccess(abs, "r"))) {
          stderr += `du: cannot read directory '${display}': Permission denied\n`;
          code = 1;
        } else {
          const names = await w.base.readdir(abs);
          const canX = isRoot(w) || (await w.canAccess(abs, "x"));
          for (const n of names) {
            if (excludes.some((re) => re.test(n))) continue;
            const cabs = abs === "/" ? "/" + n : `${abs}/${n}`;
            const cdisp = display.endsWith("/") ? display + n : `${display}/${n}`;
            entries++;
            nameBytes += n.length;
            if (!canX) {
              stderr += `du: cannot access '${cdisp}': Permission denied\n`;
              code = 1;
              continue;
            }
            const sub = await walk(cabs, cdisp, depth + 1, startMount, false);
            if (sub !== null) total += sub;
          }
        }
      }
      let own: number;
      if (byInodes) own = 1;
      else if (apparent) own = virt ? virt.apparent : inf.isDir ? st.dirApparent(m.fstype, entries, nameBytes) : inf.size;
      else own = st.allocOf(m.fstype, inf.isLink ? "link" : inf.isDir ? "dir" : "file", inf.size, virt);
      total += own;
      if (depth <= maxDepth && (inf.isDir || a.has("a") || depth === 0)) emit(total, display, inf.mtime);
      return total;
    };

    for (const t of targets) {
      const abs = resolve(ctx.cwd, t);
      if (seen.has(abs)) continue;
      seen.add(abs);
      const inf = await w.info(abs);
      if (!inf || (!isRoot(w) && !(await w.canTraverse(abs)))) {
        const denied = inf !== null;
        stderr += `du: cannot access '${t}': ${denied ? "Permission denied" : "No such file or directory"}\n`;
        code = 1;
        continue;
      }
      const total = await walk(abs, t, 0, st.mountFor(abs), true);
      if (total !== null) grand += total;
    }
    if (a.has("c")) emit(grand, "total", new Date());
    return res(stdout, stderr, code);
  });
}

// =====================================================================
// mount / umount
// =====================================================================

const DMESG = "\n       dmesg(1) may have more information after failed mount system call.";

function listMounts(w: World, filter: string | undefined, labels: boolean): string {
  const st = w.storage;
  const inc: string[] = [];
  const exc: string[] = [];
  if (filter) for (const t of filter.split(",")) (t.startsWith("no") ? exc : inc).push(t.replace(/^no/, ""));
  return st.mounts
    .filter((m) => (!inc.length || inc.includes(m.fstype)) && !exc.includes(m.fstype))
    .map((m) => {
      const lab = labels && m.dev ? st.dev(m.dev)?.fs?.label : "";
      return `${m.source} on ${m.target} type ${m.fstype} (${fullOpts(m)})${lab ? ` [${lab}]` : ""}\n`;
    })
    .join("");
}

function mountCommand(w: World): Command {
  return defineCommand("mount", async (args, ctx) => {
    const a = gnuArgs(args, {
      flags: "alvnrwfsVhFi",
      vals: "toLUT",
      long: {
        all: ["a", "none"], types: ["t", "req"], options: ["o", "req"], label: ["L", "req"], uuid: ["U", "req"], verbose: ["v", "none"],
        "read-only": ["r", "none"], "read-write": ["w", "none"], bind: ["bind", "none"], rbind: ["rbind", "none"], move: ["move", "none"],
        "show-labels": ["l", "none"], fake: ["f", "none"], "no-mtab": ["n", "none"], version: ["V", "none"], source: ["source", "req"], target: ["target", "req"],
        help: ["h", "none"],
      },
    });
    const e = optError("mount", a) ?? notYet("mount", a, ["bind", "rbind", "move", "T", "F", "i"]);
    if (e) return e;
    if (a.has("V")) return ok("mount from util-linux 2.37.4 (libmount 2.37.4: selinux, btrfs, verity, namespaces, assert, debug)\n");
    const st = w.storage;
    const type = a.last("t");
    const optsList: string[] = a.all("o");
    if (a.has("r")) optsList.push("ro");
    if (a.has("w")) optsList.push("rw");
    const labels = a.has("l");
    const cwd = ctx.cwd;

    if (!a.has("a") && !a.rest.length && !a.has("L") && !a.has("U")) {
      if (a.has("o") && !a.has("t")) return res("", "mount: bad usage\nTry 'mount --help' for more information.", 64);
      return ok(listMounts(w, type, labels));
    }
    if (!isRoot(w)) {
      if (a.has("a")) return res("", 'mount: only root can use "--all" option', 1);
      const t = a.rest.length > 1 ? a.rest[1] : a.rest[0];
      return res("", `mount: ${t}: must be superuser to use mount.`, 1);
    }

    const fail1 = (target: string, msg: string): ExecResult => res("", `mount: ${target}: ${msg}`, 32);

    // mount -a
    if (a.has("a")) {
      const entries = await st.readFstab();
      let errs = "";
      let okN = 0;
      let failN = 0;
      const inc = type ? type.split(",").filter((t) => !t.startsWith("no")) : [];
      const exc = type ? type.split(",").filter((t) => t.startsWith("no")).map((t) => t.slice(2)) : [];
      for (const en of entries) {
        if (en.vfstype === "swap" || en.vfstype === "none") continue;
        const ol = en.opts.split(",");
        if (ol.includes("noauto")) continue;
        if (inc.length && !inc.includes(en.vfstype)) continue;
        if (exc.includes(en.vfstype)) continue;
        const target = normalize(en.file);
        const dev = st.resolveDev(en.spec);
        const cur = st.mountAt(target);
        if (cur && ((dev && cur.dev === dev.name) || cur.source === en.spec)) continue;
        if (!dev && ol.includes("nofail") && en.vfstype !== "tmpfs") continue;
        const r = await st.doMount(en.spec, target, en.vfstype, [...ol.filter((o) => !["defaults", "nofail", "auto"].includes(o)), ...optsList]);
        if (typeof r === "string") {
          errs += `mount: ${target}: ${r}\n`;
          failN++;
        } else okN++;
      }
      return res("", errs, failN ? (okN ? 64 : 32) : 0);
    }

    // remount
    const remount = optsList.join(",").split(",").includes("remount");
    if (remount) {
      const t = a.rest.length > 1 ? a.rest[1] : a.rest[0];
      if (!t) return res("", "mount: bad usage\nTry 'mount --help' for more information.", 64);
      const dev = st.resolveDev(t);
      const m = st.mountAt(t.startsWith("/") ? t : resolve(cwd, t)) ?? (dev ? st.mounts.filter((x) => x.dev === dev.name).pop() : undefined);
      if (!m) return fail1(t, "mount point not mounted or bad option." + DMESG);
      let extra: string[] = optsList;
      if (a.rest.length === 1) {
        const fe = (await st.readFstab()).find((x) => normalize(x.file) === m.target);
        if (fe && !optsList.some((o) => /(^|,)(ro|rw)(,|$)/.test(o))) extra = [...fe.opts.split(",").filter((o) => o !== "defaults"), ...optsList];
      }
      const er = await st.remount(m, extra);
      if (er) return fail1(m.target, "wrong fs type, bad option, bad superblock on " + m.source + ", missing codepage or helper program, or other error." + DMESG);
      return ok();
    }

    let spec: string;
    let target: string;
    let opts = optsList;
    let fsType = type;
    if (a.has("L") || a.has("U")) {
      spec = a.has("L") ? `LABEL=${a.last("L")}` : `UUID=${a.last("U")}`;
      if (a.rest.length !== 1) return res("", "mount: bad usage\nTry 'mount --help' for more information.", 64);
      target = resolve(cwd, a.rest[0]);
    } else if (a.rest.length === 1) {
      // только каталог или только устройство — ищем в fstab
      const arg = a.rest[0];
      const entries = await st.readFstab();
      const abs = arg.startsWith("/") ? normalize(arg) : resolve(cwd, arg);
      const dev = st.resolveDev(arg);
      const en = entries.find((x) => normalize(x.file) === abs) ?? entries.find((x) => x.spec === arg || (dev && st.resolveDev(x.spec)?.name === dev.name));
      if (!en) return fail1(arg, "can't find in /etc/fstab.");
      spec = en.spec;
      target = normalize(en.file);
      fsType = fsType ?? en.vfstype;
      opts = [...en.opts.split(",").filter((o) => o !== "defaults"), ...optsList];
    } else if (a.rest.length === 2) {
      spec = a.rest[0];
      target = resolve(cwd, a.rest[1]);
      if (spec.startsWith(".") || (!spec.startsWith("/") && !/^(UUID|LABEL|PARTUUID)=/.test(spec) && fsType !== "tmpfs")) spec = resolve(cwd, spec);
    } else return res("", "mount: bad usage\nTry 'mount --help' for more information.", 64);

    if (fsType === "swap") return fail1(target, "unknown filesystem type 'swap'.");
    const r = await st.doMount(spec, target, fsType, opts);
    if (typeof r === "string") return fail1(target, /\.$|dmesg/.test(r) ? r : r + ".");
    return a.has("v") ? ok(`mount: ${r.source} mounted on ${r.target}.\n`) : ok();
  });
}

function umountCommand(w: World): Command {
  return defineCommand("umount", async (args, ctx) => {
    const a = gnuArgs(args, {
      flags: "lfrvanRdhVc",
      vals: "tO",
      long: { lazy: ["l", "none"], force: ["f", "none"], verbose: ["v", "none"], all: ["a", "none"], recursive: ["R", "none"], "read-only": ["r", "none"], version: ["V", "none"], "no-canonicalize": ["c", "none"], help: ["h", "none"] },
    });
    const e = optError("umount", a) ?? notYet("umount", a, ["a", "R", "d", "t", "O"]);
    if (e) return e;
    if (a.has("V")) return ok("umount from util-linux 2.37.4 (libmount 2.37.4: selinux, btrfs, verity, namespaces, assert, debug)\n");
    if (!a.rest.length) return res("", "umount: bad usage\nTry 'umount --help' for more information.", 2);
    const st = w.storage;
    let out = "";
    let err = "";
    let code = 0;
    for (const t of a.rest) {
      const abs = t.startsWith("/") ? normalize(t) : resolve(ctx.cwd, t);
      const dev = st.resolveDev(t);
      const m = st.mountAt(abs) ?? (dev ? st.mounts.filter((x) => x.dev === dev.name).pop() : undefined);
      if (!m) {
        const exists = await w.base.exists(abs);
        err += exists ? `umount: ${t}: not mounted.\n` : `umount: ${t}: no mount point specified.\n`;
        code = 32;
        continue;
      }
      if (!isRoot(w)) {
        err += `umount: ${m.target}: must be superuser to unmount.\n`;
        code = 32;
        continue;
      }
      const er = await st.doUmount(m, ctx.cwd, a.has("l"));
      if (er) {
        err += `umount: ${m.target}: ${er}.\n`;
        code = 32;
      } else if (a.has("v")) out += `umount: ${m.target} (${m.source}) unmounted\n`;
    }
    return res(out, err, code);
  });
}

// =====================================================================
// findmnt
// =====================================================================

const FM_COLS = ["SOURCE", "TARGET", "FSTYPE", "OPTIONS", "VFS-OPTIONS", "FS-OPTIONS", "LABEL", "UUID", "PARTUUID", "PARTLABEL", "MAJ:MIN", "FSROOT", "PROPAGATION", "ID", "PARENT", "SIZE", "USED", "AVAIL", "USE%", "FREQ", "PASSNO", "ACTION", "OLD-TARGET", "OLD-OPTIONS", "TID", "VFS-OPTIONS"];
const FM_RIGHT = new Set(["SIZE", "USED", "AVAIL", "USE%", "ID", "PARENT", "FREQ", "PASSNO"]);

interface FmRow {
  target: string; source: string; fstype: string; opts: string; vfs: string; fsopts: string; m?: Mount; freq?: string; pass?: string;
}

function findmntCommand(w: World): Command {
  return defineCommand("findmnt", async (args, ctx) => {
    const a = gnuArgs(args, {
      flags: "lnrDsxkmAuvPJcCeRwVhiFfS",
      vals: "oOtTMSNp",
      long: {
        list: ["l", "none"], noheadings: ["n", "none"], raw: ["r", "none"], output: ["o", "req"], types: ["t", "req"], target: ["T", "req"],
        mountpoint: ["M", "req"], source: ["S", "req"], fstab: ["s", "none"], mtab: ["m", "none"], kernel: ["k", "none"], df: ["D", "none"],
        verify: ["x", "none"], pairs: ["P", "none"], json: ["J", "none"], "submounts": ["R", "none"], all: ["A", "none"], uniq: ["u", "none"],
        "options": ["O", "req"], "evaluate": ["e", "none"], "nofsroot": ["v", "none"], version: ["V", "none"], help: ["h", "none"], canonicalize: ["c", "none"],
        "first-only": ["f", "none"], "tree": ["tree", "none"], "real": ["real", "none"], "pseudo": ["pseudo", "none"], "verbose": ["verbose", "none"],
      },
    });
    const e = optError("findmnt", a) ?? notYet("findmnt", a, ["J", "R", "O", "p", "N", "m", "real", "pseudo", "P"]);
    if (e) return e;
    if (a.has("V")) return ok("findmnt from util-linux 2.37.4\n");
    const st = w.storage;

    if (a.has("x")) return verifyFstab(w);

    const fstabMode = a.has("s");
    let rows: FmRow[];
    if (fstabMode) {
      rows = (await st.readFstab()).map((en) => ({
        target: en.file, source: en.spec, fstype: en.vfstype, opts: en.opts, vfs: en.opts, fsopts: en.opts, freq: en.dump, pass: en.pass,
      }));
    } else
      rows = st.mounts.map((m) => ({
        target: m.target, source: m.source, fstype: m.fstype, opts: fullOpts(m), vfs: m.vfs.join(","), fsopts: m.fsopts.join(","), m,
      }));

    // фильтры
    const tflt = a.last("t");
    if (tflt) {
      const neg = tflt.startsWith("no");
      const list = tflt.replace(/^no/, "").split(",");
      rows = rows.filter((r) => list.includes(r.fstype) !== neg);
    }
    const tgt = a.last("T");
    const mp = a.last("M");
    const src = a.last("S");
    const posArg = a.rest[0];
    if (tgt !== undefined) {
      const p = resolve(ctx.cwd, tgt);
      const m = st.mountFor(p);
      rows = rows.filter((r) => r.m === m);
    }
    if (mp !== undefined) rows = rows.filter((r) => normalize(r.target) === resolve(ctx.cwd, mp));
    if (src !== undefined) {
      const d = st.resolveDev(src);
      rows = rows.filter((r) => r.source === src || (!!d && r.m?.dev === d.name) || (!!d && r.source !== "none" && st.resolveDev(r.source)?.name === d.name));
    }
    if (posArg !== undefined) {
      const abs = posArg.startsWith("/") ? normalize(posArg) : resolve(ctx.cwd, posArg);
      const d = st.resolveDev(posArg);
      rows = rows.filter((r) => normalize(r.target) === abs || r.source === posArg || (!!d && (r.m?.dev === d.name || (r.source !== "none" && st.resolveDev(r.source)?.name === d.name))));
      if (a.has("f") && rows.length) rows = [rows[rows.length - 1]];
    }
    if (!rows.length) return res("", "", 1);

    let cols = a.has("D") ? ["SOURCE", "FSTYPE", "SIZE", "USED", "AVAIL", "USE%", "TARGET"] : fstabMode ? ["TARGET", "SOURCE", "FSTYPE", "OPTIONS"] : ["TARGET", "SOURCE", "FSTYPE", "OPTIONS"];
    const o = a.last("o");
    if (o !== undefined) {
      const req = o.replace(/^\+/, "").split(",").filter(Boolean).map((c) => c.toUpperCase());
      for (const c of req) if (!FM_COLS.includes(c)) return res("", `findmnt: unknown column: ${c}`, 1);
      cols = o.startsWith("+") ? [...cols, ...req] : req;
    }

    const scan = await st.scan();
    const cell = (c: string, r: FmRow): string => {
      const m = r.m;
      const d = m?.dev ? st.dev(m.dev) : undefined;
      const us = m && (m.dev || m.tmp) ? st.usageOf(m, scan) : null;
      switch (c) {
        case "TARGET": return r.target;
        case "SOURCE": return r.source;
        case "FSTYPE": return r.fstype;
        case "OPTIONS": return r.opts;
        case "VFS-OPTIONS": return r.vfs;
        case "FS-OPTIONS": return r.fsopts;
        case "LABEL": return d?.fs?.label ?? "";
        case "UUID": return d?.fs?.uuid ?? "";
        case "PARTUUID": return d?.partuuid ?? "";
        case "PARTLABEL": return "";
        case "MAJ:MIN": return m ? (d ? `${d.major}:${d.minor}` : `0:${m.id}`) : "";
        case "FSROOT": return m ? "/" : "";
        case "PROPAGATION": return m ? "shared" : "";
        case "ID": return m ? String(m.id) : "";
        case "PARENT": {
          if (!m || m.target === "/") return m ? "0" : "";
          const par = st.mounts.filter((q) => q !== m && (q.target === "/" || m.target.startsWith(q.target + "/"))).sort((x, y) => y.target.length - x.target.length || y.id - x.id)[0];
          return par ? String(par.id) : "0";
        }
        case "SIZE": return us ? humanLsblk(us.size) : "";
        case "USED": return us ? humanLsblk(us.used) : "";
        case "AVAIL": return us ? humanLsblk(us.avail) : "";
        case "USE%": return us ? `${us.used + us.avail ? Math.round((us.used * 100) / (us.used + us.avail)) : 0}%` : "";
        case "FREQ": return r.freq ?? "";
        case "PASSNO": return r.pass ?? "";
        default: return "";
      }
    };

    // дерево среди показанных строк: родитель — ближайший показанный предок по пути
    const flat = a.has("l") || a.has("r") || fstabMode || a.has("D");
    const order: { r: FmRow; prefix: string }[] = [];
    if (flat) rows.forEach((r) => order.push({ r, prefix: "" }));
    else {
      const parentOf = new Map<FmRow, FmRow | null>();
      for (const r of rows) {
        let best: FmRow | null = null;
        for (const q of rows) {
          if (q === r || r.target === "/") continue;
          const isAnc = q.target === "/" || r.target.startsWith(q.target + "/");
          if (isAnc && (!best || q.target.length > best.target.length || (q.target.length === best.target.length && (q.m?.id ?? 0) > (best.m?.id ?? 0)))) best = q;
        }
        parentOf.set(r, best);
      }
      const kids = (p: FmRow | null) => rows.filter((r) => parentOf.get(r) === p).sort((x, y) => (x.m?.id ?? 0) - (y.m?.id ?? 0));
      const walk = (p: FmRow, cp: string) => {
        const ks = kids(p);
        ks.forEach((k, i) => {
          const last = i === ks.length - 1;
          order.push({ r: k, prefix: cp + (last ? "└─" : "├─") });
          walk(k, cp + (last ? "  " : "│ "));
        });
      };
      for (const t of kids(null)) {
        order.push({ r: t, prefix: "" });
        walk(t, "");
      }
    }
    const data = order.map(({ r, prefix }) => cols.map((c, i) => (i === 0 && !flat ? prefix : "") + cell(c, r)));
    if (a.has("r")) {
      const lines = data.map((r) => r.map((x) => x.replace(/ /g, "\\x20")).join(" "));
      return ok([...(a.has("n") ? [] : [cols.join(" ")]), ...lines].join("\n") + "\n");
    }
    const lines = table(
      a.has("n") ? data : [cols, ...data],
      cols.map((c) => FM_RIGHT.has(c)),
    );
    return ok(lines.join("\n") + "\n");
  });
}

async function verifyFstab(w: World): Promise<ExecResult> {
  const st = w.storage;
  const entries = await st.readFstab();
  let out = "";
  let errors = 0;
  let warnings = 0;
  const E = (s: string) => {
    out += `   [E] ${s}\n`;
    errors++;
  };
  const W = (s: string) => {
    out += `   [W] ${s}\n`;
    warnings++;
  };
  const OK = (s: string) => (out += `   [ ] ${s}\n`);
  for (const en of entries) {
    out += `${en.file}\n`;
    const isSwap = en.vfstype === "swap";
    const nofail = en.opts.split(",").includes("nofail");
    if (!isSwap && en.file !== "none") {
      const inf = await w.info(en.file, true);
      if (!inf) W("target does not exist");
      else if (!inf.isDir) W("target is not a directory");
      else OK("target exists");
    }
    const dev = st.resolveDev(en.spec);
    if (en.spec.startsWith("/dev/") || /^(UUID|LABEL|PARTUUID)=/.test(en.spec)) {
      if (!dev) {
        if (nofail) W(`unreachable source: ${en.spec}`);
        else E(`unreachable on boot required source: ${en.spec}`);
      } else {
        if (!en.spec.startsWith("/dev/")) OK(`${en.spec} translated to ${st.devPath(dev)}`);
        OK(`source ${st.devPath(dev)} exists`);
        if (dev.fs && !isSwap && dev.fs.type !== en.vfstype && en.vfstype !== "auto") W(`${en.vfstype} does not match with on-disk ${dev.fs.type}`);
        else if (!dev.fs && !isSwap) W(`cannot detect on-disk filesystem type`);
        else OK(`FS type is ${dev.fs?.type ?? en.vfstype}`);
      }
    } else OK(`FS type is ${en.vfstype}`);
  }
  if (!errors && !warnings) return res(out + "\nSuccess, no errors or warnings detected\n");
  const pl = (n: number, s: string) => `${n} ${s}${n === 1 ? "" : "s"}`;
  out += `\n${pl(0, "parse error")}, ${pl(errors, "error")}, ${pl(warnings, "warning")}\n`;
  return res(out, "", errors ? 1 : 64);
}

// =====================================================================
// mkfs.*
// =====================================================================

function mkfsXfsOutput(path: string, size: number): string {
  const blocks = Math.floor(size / BLOCK);
  const agcount = 4;
  const agsize = Math.ceil(blocks / agcount);
  const log = Math.min(65536, Math.max(2560, Math.floor(blocks / 512 / 128) * 128 || 2560));
  const line = (pre: string, f: string, a: string, b: string) => `${pre.padEnd(9)}=${f.padEnd(23)}${a.padEnd(13)}${b}\n`;
  return (
    line("meta-data", path, "isize=512", `agcount=${agcount}, agsize=${agsize} blks`) +
    line("", "", "sectsz=512", "attr=2, projid32bit=1") +
    line("", "", "crc=1", "finobt=1, sparse=1, rmapbt=0") +
    line("", "", "reflink=1", "bigtime=1 inobtcount=1") +
    line("data", "", "bsize=4096", `blocks=${blocks}, imaxpct=25`) +
    line("", "", "sunit=0", "swidth=0 blks") +
    line("naming", "version 2", "bsize=4096", "ascii-ci=0, ftype=1") +
    line("log", "internal log", "bsize=4096", `blocks=${log}, version=2`) +
    line("", "", "sectsz=512", "sunit=0 blks, lazy-count=1") +
    line("realtime", "none", "extsz=4096", "blocks=0, rtextents=0")
  );
}

function mkfsExt4Output(size: number, uuid: string): string {
  const blocks = Math.floor(size / BLOCK);
  const inodes = ext4Inodes(size);
  const groups = Math.ceil(blocks / 32768);
  const backups = new Set<number>();
  if (groups > 1) backups.add(1);
  for (const b of [3, 5, 7]) for (let p = b; p < groups; p *= b) backups.add(p);
  const list = [...backups].sort((x, y) => x - y).map((g) => g * 32768);
  let out = `mke2fs 1.46.5 (30-Dec-2021)\nCreating filesystem with ${blocks} 4k blocks and ${inodes} inodes\nFilesystem UUID: ${uuid}\n`;
  if (list.length) {
    out += "Superblock backups stored on blocks: \n";
    let cur = "\t";
    const items = list.map(String);
    items.forEach((it, i) => {
      const piece = it + (i < items.length - 1 ? "," : "");
      if (cur.length > 1 && 8 + (cur.length - 1) + 1 + piece.length > 80) {
        out += cur.replace(/ $/, "") + "\n";
        cur = "\t";
      }
      cur += piece + (i < items.length - 1 ? " " : "");
    });
    out += cur + "\n";
  }
  out += `\nAllocating group tables: done${" ".repeat(28)}\nWriting inode tables: done${" ".repeat(28)}\nCreating journal (${ext4Journal(size)} blocks): done\nWriting superblocks and filesystem accounting information: done   \n\n`;
  return out;
}

async function doMkfs(w: World, prog: string, type: "xfs" | "ext4", args: string[]): Promise<ExecResult> {
  const xfs = type === "xfs";
  const a = gnuArgs(args, {
    flags: xfs ? "fqKV" : "FqVnvc",
    vals: xfs ? "LbdilmnrsNp" : "LmtTbIiNOeEgGjJMoRrUC",
    long: xfs ? {} : { },
  });
  const e = optError(prog, a);
  if (e) return e;
  if (a.has("V")) return ok(xfs ? "mkfs.xfs version 5.14.2\n" : "mke2fs 1.46.5 (30-Dec-2021)\n");
  if (!a.rest.length) {
    return xfs
      ? res("", "Usage: mkfs.xfs\n/* blocksize */\t\t[-b size=num]\n/* metadata */\t\t[-m crc=0|1,finobt=0|1,uuid=xxx,rmapbt=0|1,reflink=0|1,\n\t\t\t    inobtcount=0|1,bigtime=0|1]\n/* data subvol */\t[-d agcount=n,agsize=n,file,name=xxx,size=num,\n\t\t\t    (sunit=value,swidth=value|su=num,sw=num|noalign),\n\t\t\t    sectsize=num\n/* force overwrite */\t[-f]", 1)
      : res("", "Usage: mkfs.ext4 [-c|-l filename] [-b block-size] [-C cluster-size]\n\t[-i bytes-per-inode] [-I inode-size] [-J journal-options]\n\t[-G flex-group-size] [-N number-of-inodes] [-d root-directory]\n\t[-m reserved-blocks-percentage] [-o creator-os]\n\t[-g blocks-per-group] [-L volume-label] [-M last-mounted-directory]\n\t[-O feature[,...]] [-r fs-revision] [-E extended-option[,...]]\n\t[-t fs-type] [-T usage-type ] [-U UUID] [-e errors_behavior][-z undo_file]\n\t[-jnqvDFSV] device [blocks-count]", 1);
  }
  const st = w.storage;
  const spec = a.rest[0];
  const label = a.last("L") ?? "";
  const force = a.has(xfs ? "f" : "F");
  const quiet = a.has("q");
  const d = st.resolveDev(spec);
  if (!d) {
    return xfs
      ? res("", `${prog}: cannot open ${spec}: No such file or directory`, 1)
      : res("", `The file ${spec} does not exist and no size was specified.`, 1);
  }
  const path = st.devPath(d);
  if (!isRoot(w)) {
    return xfs ? res("", `${prog}: cannot open ${path}: Permission denied`, 1) : res("", `${prog}: Permission denied while trying to determine filesystem size`, 1);
  }
  if (st.mountsOf(d.name).length || st.swaps.has(d.name)) {
    return xfs ? res("", `${prog}: ${path} contains a mounted filesystem`, 1) : res("", `${path} is mounted; will not make a filesystem here!`, 1);
  }
  if (xfs && label.length > 12) return res("", `${prog}: label (${label}) too long (max 12)`, 1);
  if (xfs && d.size < 300 * MiB) return res("", "Filesystem must be larger than 300MB.\nUsage: mkfs.xfs", 1);
  const kids = st.children(d.name);
  if (!force) {
    if (kids.length) {
      return xfs
        ? res("", `${prog}: ${path} appears to contain a partition table (dos).\n${prog}: Use the -f option to force overwrite.`, 1)
        : res(`Found a dos partition table in ${path}\nProceed anyway? (y,N) `, "", 1);
    }
    if (d.fs) {
      return xfs
        ? res("", `${prog}: ${path} appears to contain an existing filesystem (${d.fs.type}).\n${prog}: Use the -f option to force overwrite.`, 1)
        : res(`${path} contains a ${d.fs.type} file system\nProceed anyway? (y,N) `, "", 1);
    }
  }
  for (const k of kids) await st.removeDev(k.name);
  const uuid = st.newUuid();
  d.fs = newFs(type, d.size, uuid, label);
  await st.syncDev();
  if (quiet) return ok();
  return ok(xfs ? mkfsXfsOutput(path, d.size) : mkfsExt4Output(d.size, uuid));
}

function mkfsCommands(w: World): Command[] {
  const xfs = defineCommand("mkfs.xfs", async (args) => doMkfs(w, "mkfs.xfs", "xfs", args));
  const ext4 = defineCommand("mkfs.ext4", async (args) => doMkfs(w, "mkfs.ext4", "ext4", args));
  const mke2fs = defineCommand("mke2fs", async (args) => {
    const i = args.indexOf("-t");
    const t = i >= 0 ? args[i + 1] : "ext2";
    if (t !== "ext4") return res("", `mke2fs: тренажёр умеет только -t ext4 (запрошено ${t})`, 1);
    return doMkfs(w, "mke2fs", "ext4", args.filter((_, j) => j !== i && j !== i + 1));
  });
  const mkfs = defineCommand("mkfs", async (args) => {
    const a = gnuArgs(args, { flags: "V", vals: "t", long: { type: ["t", "req"] } });
    // оставшиеся ключи отдаём mkfs.<тип> как есть
    const ti = args.findIndex((x) => x === "-t" || x.startsWith("--type"));
    let t = a.last("t");
    const rest = args.filter((x, j) => {
      if (x === "-t") return false;
      if (j > 0 && args[j - 1] === "-t") return false;
      if (x.startsWith("--type")) return false;
      if (x.startsWith("-t") && x.length > 2) return false;
      return true;
    });
    void ti;
    if (!t) t = "ext2";
    if (t === "xfs") return doMkfs(w, "mkfs.xfs", "xfs", rest);
    if (t === "ext4") return doMkfs(w, "mkfs.ext4", "ext4", rest);
    if (["ext2", "ext3", "vfat", "btrfs", "msdos", "fat"].includes(t)) return res("", `mkfs: тренажёр пока умеет только xfs и ext4 (запрошено ${t}; без -t mkfs делает ext2)`, 1);
    return res("", `mkfs: fs type ${t} not found`, 1);
  });
  return [xfs, ext4, mke2fs, mkfs];
}

// =====================================================================
// swapon / swapoff / free
// =====================================================================

function swapCommands(w: World, onUnsupported: (n: string) => void): Command[] {
  const swapon = defineCommand("swapon", async (args) => {
    const a = gnuArgs(args, {
      flags: "asvhV",
      vals: "pfo",
      long: { show: ["show", "opt"], noheadings: ["noheadings", "none"], bytes: ["bytes", "none"], summary: ["s", "none"], all: ["a", "none"], verbose: ["v", "none"], raw: ["raw", "none"] },
    });
    const e = optError("swapon", a) ?? notYet("swapon", a, ["p", "f", "o", "raw"]);
    if (e) return e;
    const st = w.storage;
    if (a.has("show") || (!a.rest.length && !a.has("a") && !a.has("s"))) {
      if (!a.has("show")) return res("", "swapon: тренажёр: используй swapon --show", 1);
      const act = [...st.swaps].map((n) => st.dev(n)!).filter(Boolean);
      if (!act.length) return ok();
      const sz = (n: number) => (a.has("bytes") ? String(n) : humanLsblk(n));
      const rows = act.map((d) => [`/dev/${d.kname}`, "partition", sz(d.size), a.has("bytes") ? "0" : "0B", "-2"]);
      const lines = table(a.has("noheadings") ? rows : [["NAME", "TYPE", "SIZE", "USED", "PRIO"], ...rows], [false, false, true, true, true]);
      return ok(lines.join("\n") + "\n");
    }
    if (a.has("s")) {
      const body = [...st.swaps].map((n) => st.dev(n)!).map((d) => `/dev/${d.kname}\t\t\t\tpartition\t${Math.floor(d.size / KiB)}\t\t0\t\t-2\n`).join("");
      return ok("Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" + body);
    }
    if (!isRoot(w)) return res("", `swapon: ${a.rest[0] ?? ""}: swapon failed: Operation not permitted`, 255);
    if (a.has("a")) {
      for (const en of await st.readFstab()) {
        if (en.vfstype !== "swap") continue;
        const d = st.resolveDev(en.spec);
        if (d?.fs?.type === "swap") st.swaps.add(d.name);
      }
      await st.syncProc();
      return ok();
    }
    let err = "";
    for (const r of a.rest) {
      const d = st.resolveDev(r);
      if (!d) err += `swapon: cannot open ${r}: No such file or directory\n`;
      else if (d.fs?.type !== "swap") err += `swapon: ${r}: read swap header failed\n`;
      else st.swaps.add(d.name);
    }
    await st.syncProc();
    return res("", err, err ? 255 : 0);
  });
  const swapoff = defineCommand("swapoff", async (args) => {
    const a = gnuArgs(args, { flags: "av", long: { all: ["a", "none"], verbose: ["v", "none"] } });
    const e = optError("swapoff", a);
    if (e) return e;
    const st = w.storage;
    if (!isRoot(w)) return res("", `swapoff: ${a.rest[0] ?? ""}: swapoff failed: Operation not permitted`, 255);
    if (a.has("a")) st.swaps.clear();
    let err = "";
    for (const r of a.rest) {
      const d = st.resolveDev(r);
      if (!d || !st.swaps.has(d.name)) err += `swapoff: ${r}: swapoff failed: Invalid argument\n`;
      else st.swaps.delete(d.name);
    }
    await st.syncProc();
    return res("", err, err ? 255 : 0);
  });
  const free = defineCommand("free", async (args) => {
    const a = gnuArgs(args, {
      flags: "bkmghtwlV",
      vals: "sc",
      long: { human: ["h", "none"], bytes: ["b", "none"], kibi: ["k", "none"], mebi: ["m", "none"], gibi: ["g", "none"], total: ["t", "none"], si: ["si", "none"], wide: ["w", "none"], lohi: ["l", "none"], version: ["V", "none"] },
    });
    const e = optError("free", a) ?? notYet("free", a, ["w", "l", "s", "c", "si"]);
    if (e) return e;
    if (a.has("V")) return ok("free from procps-ng 3.3.17\n");
    const st = w.storage;
    const total = st.memTotalKib;
    const used = 346424;
    const shared = 5144;
    const cache = 483092;
    const free = total - used - cache;
    const avail = free + Math.floor(cache * 0.85);
    const swapTotal = [...st.swaps].reduce((s, n) => s + Math.floor(st.dev(n)!.size / KiB), 0);
    const conv = (kib: number): string => {
      if (a.has("h")) return humanFree(kib);
      if (a.has("b")) return String(kib * 1024);
      if (a.has("m")) return String(Math.floor(kib / 1024));
      if (a.has("g")) return String(Math.floor(kib / MiB));
      return String(kib);
    };
    const mk = (label: string, vals: number[]) => label.padEnd(8) + vals.map((v) => " " + conv(v).padStart(11)).join("");
    const lines = [
      "".padEnd(8) + ["total", "used", "free", "shared", "buff/cache", "available"].map((h) => " " + h.padStart(11)).join(""),
      mk("Mem:", [total, used, free, shared, cache, avail]),
      mk("Swap:", [swapTotal, 0, swapTotal]),
    ];
    if (a.has("t")) lines.push(mk("Total:", [total + swapTotal, used, free + swapTotal]));
    return ok(lines.join("\n") + "\n");
  });
  void onUnsupported;
  return [swapon, swapoff, free];
}

// =====================================================================
// systemctl (только daemon-reload; остальное — позже)
// =====================================================================

function systemctlStub(w: World, onUnsupported: (n: string) => void): Command {
  return defineCommand("systemctl", async (args) => {
    const sub = args.find((x) => !x.startsWith("-"));
    if (sub === "daemon-reload") {
      if (!isRoot(w)) return res("", "Failed to reload daemon: Interactive authentication required.", 1);
      return ok();
    }
    const svc = sub ? serviceAction(w, sub, args.slice(args.indexOf(sub) + 1).filter((x) => !x.startsWith("-"))) : null;
    if (svc) return res(svc.out, svc.err.replace(/\n$/, ""), svc.code);
    onUnsupported("systemctl");
    w.unsupported.push("systemctl");
    return res("", "systemctl: в RHEL такая команда есть, но тренажёр её пока не умеет (записал в журнал)", 127);
  });
}

// =====================================================================
// truncate / fallocate / dd — большие файлы без хранения содержимого
// =====================================================================

/** Создать (или усечь) файл от имени текущего пользователя через охраняемую ФС. */
async function openForWrite(w: World, p: string, create: boolean): Promise<string | null> {
  try {
    if (!(await w.base.exists(p))) {
      if (!create) return "ENOENT";
      await w.fs.writeFile(p, "");
    } else {
      const ex = await w.info(p, true);
      if (ex?.isDir) return "EISDIR";
      await w.fs.appendFile(p, "");
      if (!isRoot(w) && !(await w.canAccess(p, "w"))) return "EACCES";
    }
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? "EIO";
  }
}

const CODE_TEXT: Record<string, string> = {
  EACCES: "Permission denied", ENOENT: "No such file or directory", EROFS: "Read-only file system", ENOSPC: "No space left on device",
  EISDIR: "Is a directory", EIO: "Input/output error", ENOTDIR: "Not a directory",
};

function parseSizeArg(s: string): number | null {
  const m = /^(\d+)([KMGTP]?)(i?B)?$/i.exec(s);
  if (!m) return null;
  const mult: Record<string, number> = { "": 1, K: KiB, M: MiB, G: GiB, T: GiB * 1024, P: GiB * 1024 ** 2 };
  return parseInt(m[1], 10) * mult[m[2].toUpperCase()];
}

function fileCommands(w: World): Command[] {
  const truncate = defineCommand("truncate", async (args, ctx) => {
    const a = gnuArgs(args, { flags: "co", vals: "sr", long: { size: ["s", "req"], "no-create": ["c", "none"], reference: ["r", "req"] } });
    const e = optError("truncate", a) ?? notYet("truncate", a, ["o", "r"]);
    if (e) return e;
    if (!a.has("s")) return res("", "truncate: you must specify either '--size' or '--reference'\nTry 'truncate --help' for more information.", 1);
    if (!a.rest.length) return res("", "truncate: missing file operand\nTry 'truncate --help' for more information.", 1);
    let spec = a.last("s")!;
    let mode = "";
    if (/^[+\-<>/%]/.test(spec)) {
      mode = spec[0];
      spec = spec.slice(1);
    }
    const n = parseSizeArg(spec);
    if (n === null) return res("", `truncate: Invalid number: ‘${a.last("s")}’`, 1);
    const st = w.storage;
    let err = "";
    for (const f of a.rest) {
      const p = resolve(ctx.cwd, f);
      const existed = await w.base.exists(p);
      if (!existed && a.has("c")) continue;
      const r = await openForWrite(w, p, true);
      if (r) {
        err += `truncate: cannot open '${f}' for writing: ${CODE_TEXT[r] ?? r}\n`;
        continue;
      }
      const inf = (await w.info(p, true))!;
      const cur = st.virt.get(p)?.apparent ?? inf.size;
      const target = mode === "+" ? cur + n : mode === "-" ? Math.max(0, cur - n) : mode === "<" ? Math.min(cur, n) : mode === ">" ? Math.max(cur, n) : n;
      const realLen = st.virt.has(p) ? 0 : inf.size;
      if (!st.virt.has(p) && target <= realLen) {
        const txt = await w.base.readFile(p);
        await w.base.writeFile(p, txt.slice(0, target));
        st.virt.delete(p);
      } else {
        const keep = st.virt.get(p)?.alloc ?? Math.ceil(realLen / BLOCK) * BLOCK;
        st.virt.set(p, { apparent: target, alloc: Math.min(keep, Math.ceil(target / BLOCK) * BLOCK) });
      }
    }
    return res("", err, err ? 1 : 0);
  });

  const fallocate = defineCommand("fallocate", async (args, ctx) => {
    const a = gnuArgs(args, { flags: "nvpzdxi", vals: "lo", long: { length: ["l", "req"], offset: ["o", "req"], keep: ["n", "none"], "punch-hole": ["p", "none"], "zero-range": ["z", "none"], "dig-holes": ["d", "none"], verbose: ["v", "none"] } });
    const e = optError("fallocate", a) ?? notYet("fallocate", a, ["n", "p", "z", "d", "x", "i", "o"]);
    if (e) return e;
    if (!a.has("l")) return res("", "fallocate: no length argument specified", 1);
    if (a.rest.length !== 1) return res("", a.rest.length ? "fallocate: unexpected number of arguments" : "fallocate: no filename specified.", 1);
    const n = parseSizeArg(a.last("l")!);
    if (n === null || n === 0) return res("", `fallocate: invalid length value specified`, 1);
    const st = w.storage;
    const p = resolve(ctx.cwd, a.rest[0]);
    const r = await openForWrite(w, p, true);
    if (r) return res("", `fallocate: cannot open ${a.rest[0]}: ${CODE_TEXT[r] ?? r}`, 1);
    const m = st.mountFor(p);
    const prev = st.virt.get(p)?.alloc ?? 0;
    if (m.dev || m.tmp) {
      const u = await st.usage(m);
      if (n - prev > u.avail) {
        return res("", "fallocate: fallocate failed: No space left on device", 1);
      }
    }
    const inf = (await w.info(p, true))!;
    st.virt.set(p, { apparent: Math.max(n, inf.size), alloc: Math.ceil(n / BLOCK) * BLOCK });
    return ok();
  });

  const dd = defineCommand("dd", async (args, ctx) => {
    const op = new Map<string, string>();
    for (const x of args) {
      const i = x.indexOf("=");
      if (i < 0) {
        if (x === "--help" || x === "--version") return ok(x === "--version" ? "dd (coreutils) 8.32\n" : "Usage: dd [OPERAND]...\n  or:  dd OPTION\n");
        return res("", `dd: unrecognized operand ‘${x}’\nTry 'dd --help' for more information.`, 1);
      }
      op.set(x.slice(0, i), x.slice(i + 1));
    }
    for (const k of op.keys()) if (!["if", "of", "bs", "ibs", "obs", "count", "skip", "seek", "conv", "status", "iflag", "oflag"].includes(k)) return res("", `dd: unrecognized operand ‘${k}=${op.get(k)}’\nTry 'dd --help' for more information.`, 1);
    const st = w.storage;
    const bsRaw = op.get("bs") ?? op.get("ibs") ?? "512";
    const bs = parseSizeArg(bsRaw.replace(/^(\d+)([kKMGT])$/, (_, d, u) => d + (u === "k" ? "K" : u)));
    if (bs === null || bs === 0) return res("", `dd: invalid number: ‘${bsRaw}’`, 1);
    const countRaw = op.get("count");
    const count = countRaw !== undefined ? parseSizeArg(countRaw) : null;
    if (countRaw !== undefined && count === null) return res("", `dd: invalid number: ‘${countRaw}’`, 1);
    const skip = op.get("skip") ? (parseSizeArg(op.get("skip")!) ?? 0) : 0;
    const seek = op.get("seek") ? (parseSizeArg(op.get("seek")!) ?? 0) : 0;
    const inp = op.get("if");
    const outp = op.get("of");
    const status = op.get("status");
    let inVirtual = false;
    let inLen = Infinity;
    let inText: string | null = null;
    if (inp === undefined) return res("", "dd: тренажёр: чтение из stdin не поддерживается, укажи if=", 1);
    if (["/dev/zero", "/dev/urandom", "/dev/random"].includes(inp)) inVirtual = true;
    else {
      const ip = resolve(ctx.cwd, inp);
      const inf = await w.info(ip, true);
      if (!inf) return res("", `dd: failed to open '${inp}': No such file or directory`, 1);
      if (inf.isDir) return res("", `dd: error reading '${inp}': Is a directory`, 1);
      if (!isRoot(w) && !(await w.canAccess(ip, "r"))) return res("", `dd: failed to open '${inp}': Permission denied`, 1);
      const v = st.virt.get(ip);
      inLen = v ? v.apparent : inf.size;
      if (!v) inText = await w.base.readFile(ip);
      inVirtual = !!v;
    }
    let want = count !== null ? count * bs : Math.max(0, inLen - skip * bs);
    let stderr = "";
    let code = 0;
    const op2 = outp === undefined ? null : outp === "/dev/null" ? "null" : resolve(ctx.cwd, outp);
    if (op2 === null && count === null && inLen === Infinity) return res("", "", 0);
    let target = op2;
    if (target && target !== "null" && target.startsWith("/dev/")) {
      const d = st.resolveDev(target);
      if (d) {
        if (!isRoot(w)) return res("", `dd: failed to open '${outp}': Permission denied`, 1);
        if (st.mountsOf(d.name).length) return res("", `dd: error writing '${outp}': Device or resource busy`, 1);
        // запись в начало устройства затирает сигнатуру ФС
        if (want > 0 && seek === 0) d.fs = null;
        for (const k of st.children(d.name)) if (want > 0 && seek === 0 && d.type === "disk") await st.removeDev(k.name);
        await st.syncDev();
        target = "null";
      }
    }
    if (target && target !== "null") {
      const r = await openForWrite(w, target, true);
      if (r) return res("", `dd: failed to open '${outp}': ${CODE_TEXT[r] ?? r}`, 1);
      const m = st.mountFor(target);
      if (m.dev || m.tmp) {
        const u = await st.usage(m);
        if (want > u.avail) {
          if (countRaw === undefined) {
            want = u.avail;
            stderr += `dd: error writing '${outp}': No space left on device\n`;
            code = 1;
          } else {
            const fit = Math.floor(u.avail / bs) * bs;
            want = fit;
            stderr += `dd: error writing '${outp}': No space left on device\n`;
            code = 1;
          }
        }
      }
      if (!(op.get("conv") ?? "").includes("notrunc") || !(await w.base.exists(target))) {
        // файл уже обнулён openForWrite только если новый; усекаем явно
        await w.base.writeFile(target, "");
        st.virt.delete(target);
      }
      const total = seek * bs + want;
      if (!inVirtual && inText !== null && want <= inText.length - skip * bs && total === want) {
        await w.base.writeFile(target, inText.slice(skip * bs, skip * bs + want));
        st.virt.delete(target);
      } else if (want > 0 || seek > 0) {
        st.virt.set(target, { apparent: total, alloc: Math.ceil(want / BLOCK) * BLOCK });
      }
    }
    const full = Math.floor(want / bs);
    const part = want % bs ? 1 : 0;
    if (status !== "none") {
      stderr += `${full}+${part} records in\n${full}+${part} records out\n`;
      if (status !== "noxfer") {
        const secs = Math.max(0.0008, want / 1.4e9);
        const si = siBytes(want);
        const iec = iecBytes(want);
        const speed = siBytes(want / secs) + "/s";
        stderr += want < 1000 ? `${want} bytes copied, ${fmtSecs(secs)} s, ${speed}\n` : `${want} bytes (${si}, ${iec}) copied, ${fmtSecs(secs)} s, ${speed}\n`;
      }
    }
    return res("", stderr, code);
  });
  return [truncate, fallocate, dd];
}

function siBytes(n: number): string {
  if (n < 1000) return `${Math.round(n)} B`;
  const u = ["kB", "MB", "GB", "TB"];
  let v = n / 1000;
  let i = 0;
  while (v >= 1000 && i < u.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : v.toFixed(v < 100 ? 1 : 0)} ${u[i]}`;
}
function iecBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KiB", "MiB", "GiB", "TiB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${u[i]}`;
}
function fmtSecs(s: number): string {
  return String(parseFloat(s.toPrecision(6)));
}

export function storageCommands(w: World, onUnsupported: (name: string) => void): Command[] {
  return [
    lsblkCommand(w), blkidCommand(w), dfCommand(w), duCommand(w), mountCommand(w), umountCommand(w), findmntCommand(w),
    ...mkfsCommands(w), ...swapCommands(w, onUnsupported), systemctlStub(w, onUnsupported), ...fileCommands(w),
  ];
}

export { fstabLine, parseSize, xfsInodes, basename };
