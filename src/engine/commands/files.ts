// ls, stat, cat — со своими владельцами, правами и проверкой доступа.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { NodeInfo, World } from "../world";
import { resolve } from "../path";
import { bytesToText, fail, lsDate, parseArgs } from "../util";

const C = {
  dir: "\x1b[01;34m",
  link: "\x1b[01;36m",
  exec: "\x1b[01;32m",
  tw: "\x1b[30;42m", // каталог со sticky и правом записи для всех (/tmp)
  ow: "\x1b[34;42m",
  reset: "\x1b[0m",
};

/** -rwxr-xr-x с учётом suid/sgid/sticky. */
export function modeString(inf: Pick<NodeInfo, "mode" | "isDir" | "isLink">): string {
  const m = inf.mode;
  const t = inf.isLink ? "l" : inf.isDir ? "d" : "-";
  const tri = (r: number, special: boolean, sch: string) => {
    const x = (r & 1) !== 0;
    const xc = special ? (x ? sch : sch.toUpperCase()) : x ? "x" : "-";
    return (r & 4 ? "r" : "-") + (r & 2 ? "w" : "-") + xc;
  };
  return (
    t +
    tri((m >> 6) & 7, (m & 0o4000) !== 0, "s") +
    tri((m >> 3) & 7, (m & 0o2000) !== 0, "s") +
    tri(m & 7, (m & 0o1000) !== 0, "t")
  );
}

function colorize(w: World, inf: NodeInfo, name: string): string {
  if (!w.tty) return name;
  let c = "";
  if (inf.isLink) c = C.link;
  else if (inf.isDir) {
    const ow = (inf.mode & 0o002) !== 0;
    const st = (inf.mode & 0o1000) !== 0;
    c = ow && st ? C.tw : ow ? C.ow : C.dir;
  } else if (inf.mode & 0o111) c = C.exec;
  return c ? c + name + C.reset : name;
}

function humanSize(n: number): string {
  if (n < 1024) return String(n);
  const units = ["K", "M", "G", "T"];
  let v = n;
  let i = -1;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + units[i];
}

/** Сортировка как в en_US.UTF-8: без учёта регистра и ведущих точек. */
function nameCompare(a: string, b: string): number {
  const ka = a.replace(/^\.+/, "").toLowerCase();
  const kb = b.replace(/^\.+/, "").toLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Ширина строки без ANSI-кодов. */
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Раскладка в колонки как у GNU ls (заполнение по столбцам). */
function columns(items: string[], width: number): string {
  if (!items.length) return "";
  const lens = items.map(visLen);
  for (let cols = Math.min(items.length, Math.max(1, Math.floor(width / 3))); cols >= 1; cols--) {
    const rows = Math.ceil(items.length / cols);
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let mx = 0;
      for (let r = 0; r < rows; r++) {
        const i = c * rows + r;
        if (i < items.length) mx = Math.max(mx, lens[i]);
      }
      widths.push(mx);
    }
    const total = widths.reduce((s, x) => s + x, 0) + 2 * (cols - 1);
    if (total <= width || cols === 1) {
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        let line = "";
        for (let c = 0; c < cols; c++) {
          const i = c * rows + r;
          if (i >= items.length) continue;
          const last = c === cols - 1 || (c + 1) * rows + r >= items.length;
          line += last ? items[i] : items[i] + " ".repeat(widths[c] - lens[i] + 2);
        }
        lines.push(line);
      }
      return lines.join("\n") + "\n";
    }
  }
  return items.join("\n") + "\n";
}

export function lsCommand(w: World): Command {
  return defineCommand("ls", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "laAdh1RrtSFi",
      long: { all: "a", "almost-all": "A", directory: "d", "human-readable": "h", recursive: "R", reverse: "r", color: "color" },
      withValue: ["color"],
    });
    if (p.bad) return fail(`ls: invalid option -- '${p.bad.replace(/^-+/, "")}'\nTry 'ls --help' for more information.`, 2);
    const f = p.flags;
    const long = f.has("l");
    const targets = p.rest.length ? p.rest : ["."];
    let out = "";
    let err = "";
    let code = 0;

    const nlinks = async (inf: NodeInfo) => {
      if (!inf.isDir) return 1;
      let n = 2;
      try {
        for (const e of await w.base.readdir(inf.path)) {
          const s = await w.info(inf.path === "/" ? "/" + e : inf.path + "/" + e);
          if (s?.isDir) n++;
        }
      } catch {
        /* пусто */
      }
      return n;
    };
    const dirSize = async (inf: NodeInfo) => {
      try {
        const n = (await w.base.readdir(inf.path)).reduce((s, e) => s + e.length + 9, 6);
        return n > 4096 ? Math.ceil(n / 4096) * 4096 : n;
      } catch {
        return 6;
      }
    };

    const longLines = async (entries: { name: string; inf: NodeInfo }[]) => {
      const rows: string[][] = [];
      for (const { name, inf } of entries) {
        const size = inf.isDir ? await dirSize(inf) : inf.size;
        const user = w.userByUid(inf.uid)?.name ?? String(inf.uid);
        const group = w.groupByGid(inf.gid)?.name ?? String(inf.gid);
        let shown = colorize(w, inf, name);
        if (inf.isLink) {
          try {
            shown += " -> " + (await w.base.readlink(inf.path));
          } catch {
            /* битая ссылка */
          }
        }
        rows.push([
          modeString(inf) + ".",
          String(await nlinks(inf)),
          user,
          group,
          f.has("h") ? humanSize(size) : String(size),
          lsDate(inf.mtime),
          shown,
        ]);
      }
      const wd = [1, 2, 3, 4].map((c) => Math.max(...rows.map((r) => r[c].length)));
      return rows
        .map((r) => [r[0], r[1].padStart(wd[0]), r[2].padEnd(wd[1]), r[3].padEnd(wd[2]), r[4].padStart(wd[3]), r[5], r[6]].join(" "))
        .join("\n");
    };

    const blocks = (entries: { inf: NodeInfo }[]) =>
      entries.reduce((s, { inf }) => s + (inf.isDir ? 0 : Math.ceil(inf.size / 4096) * 4), 0);

    const sortEntries = <T extends { name: string; inf: NodeInfo }>(arr: T[]) => {
      arr.sort((a, b) => nameCompare(a.name, b.name));
      if (f.has("t")) arr.sort((a, b) => b.inf.mtime.getTime() - a.inf.mtime.getTime());
      if (f.has("S")) arr.sort((a, b) => b.inf.size - a.inf.size);
      if (f.has("r")) arr.reverse();
      return arr;
    };

    const render = async (entries: { name: string; inf: NodeInfo }[]) => {
      if (!entries.length) return "";
      if (long) return (await longLines(entries)) + "\n";
      const names = entries.map((e) => colorize(w, e.inf, e.name));
      if (w.tty && !f.has("1")) return columns(names, w.cols);
      return names.join("\n") + "\n";
    };

    const files: { name: string; inf: NodeInfo }[] = [];
    const dirs: { name: string; inf: NodeInfo }[] = [];
    for (const t of targets) {
      const abs = resolve(ctx.cwd, t);
      if (!(await w.canTraverse(abs))) {
        err += `ls: cannot access '${t}': Permission denied\n`;
        code = 2;
        continue;
      }
      const inf = await w.info(abs, true);
      const linf = await w.info(abs);
      if (!inf || !linf) {
        err += `ls: cannot access '${t}': No such file or directory\n`;
        code = 2;
        continue;
      }
      // ls -l на симлинк показывает саму ссылку; ls на симлинк-каталог — его содержимое
      if (f.has("d") || !inf.isDir || (long && linf.isLink && !t.endsWith("/"))) files.push({ name: t, inf: long ? linf : inf });
      else dirs.push({ name: t, inf });
    }

    sortEntries(files);
    out += await render(files);
    sortEntries(dirs);

    const showHeader = targets.length > 1 || f.has("R");
    const listDir = async (name: string, inf: NodeInfo, first: boolean) => {
      if (!w.permOn(inf, "r")) {
        err += `ls: cannot open directory '${name}': Permission denied\n`;
        code = 2;
        return;
      }
      let names = await w.base.readdir(inf.path);
      if (!f.has("a") && !f.has("A")) names = names.filter((n) => !n.startsWith("."));
      const entries: { name: string; inf: NodeInfo }[] = [];
      for (const n of names) {
        const ci = await w.info(inf.path === "/" ? "/" + n : inf.path + "/" + n);
        if (ci) entries.push({ name: n, inf: ci });
      }
      sortEntries(entries);
      if (f.has("a")) {
        const parent = (await w.info(resolve(inf.path, ".."), true))!;
        entries.unshift({ name: "..", inf: parent });
        entries.unshift({ name: ".", inf });
      }
      if (showHeader) out += (first && !files.length ? "" : "\n") + `${name}:\n`;
      if (long) out += `total ${blocks(entries)}\n`;
      out += await render(entries);
      if (f.has("R")) {
        for (const e of entries) {
          if (e.name === "." || e.name === "..") continue;
          if (e.inf.isDir && !e.inf.isLink) await listDir(name.replace(/\/$/, "") + "/" + e.name, e.inf, false);
        }
      }
    };
    let first = true;
    for (const d of dirs) {
      await listDir(d.name, d.inf, first);
      first = false;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

function fileType(inf: NodeInfo): string {
  if (inf.isLink) return "symbolic link";
  if (inf.isDir) return "directory";
  return inf.size === 0 ? "regular empty file" : "regular file";
}

function statTime(d: Date): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}000000 +0000`;
}

function inode(path: string): number {
  let h = 5381;
  for (const c of path) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0;
  return 100000 + (h % 9000000);
}

export function statCommand(w: World): Command {
  return defineCommand("stat", async (args, ctx) => {
    const p = parseArgs(args, { short: "LcF", withValue: ["c", "format", "printf"], long: { dereference: "L" } });
    const fmt = p.values.get("c") ?? p.values.get("format") ?? p.values.get("printf");
    if (!p.rest.length) return fail("stat: missing operand\nTry 'stat --help' for more information.");
    let out = "";
    let err = "";
    let code = 0;
    for (const t of p.rest) {
      const abs = resolve(ctx.cwd, t);
      if (!(await w.canTraverse(abs))) {
        err += `stat: cannot statx '${t}': Permission denied\n`;
        code = 1;
        continue;
      }
      const inf = await w.info(abs, p.flags.has("L"));
      if (!inf) {
        err += `stat: cannot statx '${t}': No such file or directory\n`;
        code = 1;
        continue;
      }
      const user = w.userByUid(inf.uid)?.name ?? "UNKNOWN";
      const group = w.groupByGid(inf.gid)?.name ?? "UNKNOWN";
      if (fmt !== undefined) {
        out +=
          fmt.replace(/%([aAuUgGnsFyYix%])/g, (_, c: string) => {
            switch (c) {
              case "a":
                return inf.mode.toString(8);
              case "A":
                return modeString(inf);
              case "u":
                return String(inf.uid);
              case "U":
                return user;
              case "g":
                return String(inf.gid);
              case "G":
                return group;
              case "n":
                return t;
              case "s":
                return String(inf.size);
              case "F":
                return fileType(inf);
              case "y":
                return statTime(inf.mtime);
              case "Y":
                return String(Math.floor(inf.mtime.getTime() / 1000));
              case "i":
                return String(inode(inf.path));
              case "x":
                return statTime(inf.mtime);
              default:
                return "%";
            }
          }) + "\n";
        continue;
      }
      const blocks = inf.isDir ? 0 : Math.ceil(inf.size / 512 / 8) * 8;
      const name = inf.isLink ? `${t} -> ${await w.base.readlink(inf.path)}` : t;
      const ts = statTime(inf.mtime);
      out += `  File: ${name}\n`;
      out += `  Size: ${String(inf.size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: 4096   ${fileType(inf)}\n`;
      out += `Device: fd00h/64768d\tInode: ${String(inode(inf.path)).padEnd(11)} Links: ${inf.isDir ? 2 : 1}\n`;
      out += `Access: (${inf.mode.toString(8).padStart(4, "0")}/${modeString(inf)})  Uid: (${String(inf.uid).padStart(5)}/${user.padStart(8)})   Gid: (${String(inf.gid).padStart(5)}/${group.padStart(8)})\n`;
      out += `Context: unconfined_u:object_r:${inf.path.startsWith("/home") ? "user_home_t" : inf.path.startsWith("/tmp") ? "user_tmp_t" : "default_t"}:s0\n`;
      out += `Access: ${ts}\nModify: ${ts}\nChange: ${ts}\n Birth: ${ts}\n`;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

/** Свой cat — чтобы корректно писать «Permission denied» и «Is a directory». */
export function catCommand(w: World): Command {
  return defineCommand("cat", async (args, ctx) => {
    const p = parseArgs(args, { short: "nAEbsv", long: { number: "n", "show-all": "A" } });
    if (p.bad) return fail(`cat: invalid option -- '${p.bad.replace(/^-+/, "")}'\nTry 'cat --help' for more information.`);
    const targets = p.rest.length ? p.rest : ["-"];
    let out = "";
    let err = "";
    let code = 0;
    for (const t of targets) {
      if (t === "-") {
        out += bytesToText(ctx.stdin);
        continue;
      }
      const abs = resolve(ctx.cwd, t);
      const inf = await w.info(abs, true);
      if (!(await w.canTraverse(abs)) || (inf && !inf.isDir && !w.permOn(inf, "r"))) {
        err += `cat: ${t}: Permission denied\n`;
        code = 1;
        continue;
      }
      if (!inf) {
        err += `cat: ${t}: No such file or directory\n`;
        code = 1;
        continue;
      }
      if (inf.isDir) {
        err += `cat: ${t}: Is a directory\n`;
        code = 1;
        continue;
      }
      out += (await w.read(abs)) ?? "";
    }
    if (p.flags.has("n")) {
      const lines = out.split("\n");
      const tail = out.endsWith("\n") ? lines.pop() : undefined;
      out = lines.map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join("\n") + (tail !== undefined ? "\n" : "");
    }
    if (p.flags.has("A") || p.flags.has("E")) out = out.replace(/\n/g, "$\n");
    return { stdout: out, stderr: err, exitCode: code };
  });
}

