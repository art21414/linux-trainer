// ls, stat, cat — со своими владельцами, правами и проверкой доступа.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { NodeInfo, World } from "../world";
import { resolve } from "../path";
import { bytesToText, fail, invalidOpt, isRecent, lsDate, parseArgs, strftime } from "../util";

const C = {
  dir: "\x1b[01;34m",
  link: "\x1b[01;36m",
  exec: "\x1b[01;32m",
  orphan: "\x1b[40;31;01m", // битый симлинк
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

/** Число жёстких ссылок: у файла — по таблице inode, у каталога — 2 + число подкаталогов. */
export async function linkCount(w: World, inf: NodeInfo): Promise<number> {
  if (!inf.isDir) return inf.isLink ? 1 : w.inodes.count(inf.path);
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
}

function colorize(w: World, inf: NodeInfo, name: string, broken = false, enabled = w.tty): string {
  if (!enabled) return name;
  let c = "";
  if (inf.isLink) c = broken ? C.orphan : C.link;
  else if (inf.isDir) {
    const ow = (inf.mode & 0o002) !== 0;
    const st = (inf.mode & 0o1000) !== 0;
    c = ow && st ? C.tw : ow ? C.ow : C.dir;
  } else if (inf.mode & 0o111) c = C.exec;
  return c ? c + name + C.reset : name;
}

function humanSize(n: number, base = 1024): string {
  if (n < base) return String(n);
  const units = ["K", "M", "G", "T", "P"];
  let v = n;
  let i = -1;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  const u = base === 1000 && units[i] === "K" ? "k" : units[i];
  return (v < 10 ? (Math.ceil(v * 10) / 10).toFixed(1) : String(Math.ceil(v))) + u;
}

/** Сортировка как в en_US.UTF-8: без учёта регистра и ведущих точек. */
function nameCompare(a: string, b: string): number {
  const ka = a.replace(/^\.+/, "").toLowerCase();
  const kb = b.replace(/^\.+/, "").toLowerCase();
  return ka < kb ? -1 : ka > kb ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

/** Версионная сортировка (ls -v): числа внутри имён сравниваются как числа. */
function versionCompare(a: string, b: string): number {
  const ra = a.match(/\d+|\D+/g) ?? [];
  const rb = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const d = Number(x) - Number(y);
      if (d) return d;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return ra.length - rb.length;
}

/** Ширина строки без ANSI-кодов. */
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

/** Раскладка в колонки как у GNU ls: по столбцам (-C) или по строкам (-x). */
function columns(items: string[], width: number, across = false): string {
  if (!items.length) return "";
  const lens = items.map(visLen);
  const max = width > 0 ? Math.min(items.length, Math.max(1, Math.floor(width / 3))) : items.length;
  for (let cols = max; cols >= 1; cols--) {
    const rows = Math.ceil(items.length / cols);
    const at = (r: number, c: number) => (across ? r * cols + c : c * rows + r);
    const widths: number[] = [];
    for (let c = 0; c < cols; c++) {
      let mx = 0;
      for (let r = 0; r < rows; r++) {
        const i = at(r, c);
        if (i < items.length) mx = Math.max(mx, lens[i]);
      }
      widths.push(mx);
    }
    const total = widths.reduce((sum, x) => sum + x, 0) + 2 * (cols - 1);
    if (width <= 0 || total <= width || cols === 1) {
      const lines: string[] = [];
      for (let r = 0; r < rows; r++) {
        let line = "";
        for (let c = 0; c < cols; c++) {
          const i = at(r, c);
          if (i >= items.length) continue;
          const lastInRow = c === cols - 1 || at(r, c + 1) >= items.length;
          line += lastInRow ? items[i] : items[i] + " ".repeat(widths[c] - lens[i] + 2);
        }
        lines.push(line);
      }
      return lines.join("\n") + "\n";
    }
  }
  return items.join("\n") + "\n";
}

// ---------- имена: кавычки как у GNU ls ----------

type QuoteStyle = "literal" | "shell" | "shell-always" | "shell-escape" | "shell-escape-always" | "c" | "escape";
const CTRL = /[\x00-\x1f\x7f]/;
const SHELL_SPECIAL = /[\s!"$&'()*;<=>?[\\^`{|}]/;

const ctrlEscape = (ch: string): string => {
  const m: Record<string, string> = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\x07": "\\a", "\b": "\\b", "\f": "\\f", "\v": "\\v", "\x1b": "\\033" };
  return m[ch] ?? "\\" + ch.charCodeAt(0).toString(8).padStart(3, "0");
};

/** Имя в кавычках по стилю quoting-style. quoted — были ли добавлены кавычки (для выравнивания колонок). */
export function quoteName(name: string, style: QuoteStyle): { text: string; quoted: boolean } {
  switch (style) {
    case "literal":
      return { text: name, quoted: false };
    case "c":
      return { text: `"${[...name].map((ch) => (ch === '"' ? '\\"' : ch === "\\" ? "\\\\" : CTRL.test(ch) ? ctrlEscape(ch) : ch)).join("")}"`, quoted: true };
    case "escape":
      return { text: [...name].map((ch) => (ch === " " ? "\\ " : ch === "\\" ? "\\\\" : CTRL.test(ch) ? ctrlEscape(ch) : ch)).join(""), quoted: false };
    default: {
      const always = style === "shell-always" || style === "shell-escape-always";
      const escapeCtrl = style === "shell-escape" || style === "shell-escape-always";
      if (escapeCtrl && CTRL.test(name)) {
        // 'abc'$'\n''def'
        const parts: string[] = [];
        let run = "";
        let ctl = "";
        const flushRun = () => run && (parts.push(`'${run.replace(/'/g, "'\\''")}'`), (run = ""));
        const flushCtl = () => ctl && (parts.push(`$'${ctl}'`), (ctl = ""));
        for (const ch of name) {
          if (CTRL.test(ch)) {
            flushRun();
            ctl += ctrlEscape(ch);
          } else {
            flushCtl();
            run += ch;
          }
        }
        flushRun();
        flushCtl();
        return { text: parts.join(""), quoted: true };
      }
      const need = name === "" || SHELL_SPECIAL.test(name) || /^[#~]/.test(name);
      if (!need && !always) return { text: name, quoted: false };
      if (name.includes("'")) {
        if (!/["$`\\!]/.test(name)) return { text: `"${name}"`, quoted: true };
        return { text: `'${name.replace(/'/g, "'\\''")}'`, quoted: true };
      }
      return { text: `'${name}'`, quoted: true };
    }
  }
}

const TIME_STYLE_HELP =
  "Valid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n";

function formatLsTime(d: Date, style: string, now = new Date()): string {
  const recent = isRecent(d, now);
  const s = style.replace(/^posix-/, "");
  if (style.startsWith("+")) {
    const [oldF, recentF] = style.slice(1).split("\n");
    return strftime(recent && recentF !== undefined ? recentF : oldF, d);
  }
  switch (s) {
    case "full-iso":
      return strftime("%F %T.%N %z", d);
    case "long-iso":
      return strftime("%F %H:%M", d);
    case "iso":
      return recent ? strftime("%m-%d %H:%M", d) : strftime("%F ", d);
    default:
      return lsDate(d, now);
  }
}

interface LsItem {
  name: string;
  inf: NodeInfo;
}

export function lsCommand(w: World): Command {
  return defineCommand("ls", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "laAdhRrtSFpiucUvXngoGsxCm1qQbkLHfNwTI",
      long: {
        all: "a", "almost-all": "A", directory: "d", "human-readable": "h", recursive: "R", reverse: "r", "full-time": "full-time",
        "group-directories-first": "group-directories-first", "no-group": "G", "numeric-uid-gid": "n", dereference: "L",
        "dereference-command-line": "H", classify: "F", "file-type": "file-type", inode: "i", size: "s", literal: "N", si: "si",
        "hide-control-chars": "q", escape: "b", "quote-name": "Q", "show-control-chars": "show-control-chars", "time-style": "time-style",
        time: "time", sort: "sort", format: "format", "indicator-style": "indicator-style", "quoting-style": "quoting-style", width: "w", tabsize: "T",
      },
      withValue: ["w", "T", "I", "time", "time-style", "sort", "format", "indicator-style", "quoting-style"],
      optValue: ["color", "colour"],
      digits: true,
    });
    if (p.bad) return fail(invalidOpt("ls", p.bad));
    const f = p.flags;
    const v = p.values;
    // сообщения argmatch в UTF-8-локали (en_US.UTF-8 на Rocky) используют типографские кавычки ‘…’, имена файлов — обычные '…'
    const bail = (what: string, val: string, valid: string) => fail(`ls: invalid argument ‘${val}’ for ‘${what}’\n${valid}Try 'ls --help' for more information.`, 2);

    // --- разбор режимов ---
    const quotingWord = v.get("quoting-style");
    const QUOTING = ["literal", "shell", "shell-always", "shell-escape", "shell-escape-always", "c", "escape", "locale", "clocale"];
    if (quotingWord !== undefined && !QUOTING.includes(quotingWord))
      return bail("quoting style", quotingWord, "Valid arguments are:\n" + QUOTING.map((x) => `  - ‘${x}’`).join("\n") + "\n");
    const timeWord = v.get("time");
    const TIMES: Record<string, "mtime" | "atime" | "ctime" | "birth"> = { mtime: "mtime", modify: "mtime", atime: "atime", access: "atime", use: "atime", ctime: "ctime", status: "ctime", birth: "birth", creation: "birth" };
    if (timeWord !== undefined && !TIMES[timeWord])
      return bail("--time", timeWord, "Valid arguments are:\n  - ‘atime’, ‘access’, ‘use’\n  - ‘ctime’, ‘status’\n  - ‘mtime’, ‘modify’\n  - ‘birth’, ‘creation’\n");
    const timeKind: "mtime" | "atime" | "ctime" | "birth" = timeWord ? TIMES[timeWord] : f.has("u") ? "atime" : f.has("c") ? "ctime" : "mtime";
    const sortWord = v.get("sort");
    const SORTS = ["none", "size", "time", "version", "extension", "width", "name"];
    if (sortWord !== undefined && !SORTS.includes(sortWord)) return bail("--sort", sortWord, "Valid arguments are:\n  - ‘none’\n  - ‘time’\n  - ‘size’\n  - ‘extension’\n  - ‘version’\n");
    const formatWord = v.get("format");
    const FORMATS = ["long", "verbose", "commas", "horizontal", "across", "vertical", "single-column"];
    if (formatWord !== undefined && !FORMATS.includes(formatWord))
      return bail("--format", formatWord, "Valid arguments are:\n  - ‘verbose’, ‘long’\n  - ‘commas’\n  - ‘horizontal’, ‘across’\n  - ‘vertical’\n  - ‘single-column’\n");
    const indWord = v.get("indicator-style");
    if (indWord !== undefined && !["none", "slash", "file-type", "classify"].includes(indWord))
      return bail("indicator style", indWord, "Valid arguments are:\n  - ‘none’\n  - ‘slash’\n  - ‘file-type’\n  - ‘classify’\n");
    let timeStyle = v.get("time-style");
    if (f.has("full-time")) f.add("l");
    if (f.has("full-time") && timeStyle === undefined) timeStyle = "full-iso";
    if (timeStyle !== undefined && !timeStyle.startsWith("+") && !/^(posix-)?(full-iso|long-iso|iso|locale)$/.test(timeStyle))
      return fail(`ls: invalid argument ‘${timeStyle}’ for ‘time style’\n${TIME_STYLE_HELP}Try 'ls --help' for more information.`, 2);
    const widthOpt = v.get("w");
    if (widthOpt !== undefined && !/^\d+$/.test(widthOpt)) return fail(`ls: invalid line width: ‘${widthOpt}’`, 2);

    const long = f.has("l") || f.has("n") || f.has("g") || f.has("o") || formatWord === "long" || formatWord === "verbose";
    type Fmt = "long" | "columns" | "across" | "one" | "commas";
    const fmt: Fmt = long ? "long" : f.has("m") || formatWord === "commas" ? "commas" : f.has("x") || formatWord === "horizontal" || formatWord === "across" ? "across" : f.has("C") || formatWord === "vertical" ? "columns" : f.has("1") || formatWord === "single-column" ? "one" : w.tty ? "columns" : "one";
    const colorWord = v.get("color") ?? v.get("colour");
    let useColor = w.tty; // в интерактивном терминале Rocky ls — это alias с --color=auto
    if (f.has("color") || f.has("colour")) {
      if (colorWord === undefined || ["always", "yes", "force"].includes(colorWord)) useColor = true;
      else if (["never", "no", "none"].includes(colorWord)) useColor = false;
      else if (["auto", "tty", "if-tty"].includes(colorWord)) useColor = w.tty;
      else return bail("--color", colorWord, "Valid arguments are:\n  - ‘always’, ‘yes’, ‘force’\n  - ‘never’, ‘no’, ‘none’\n  - ‘auto’, ‘tty’, ‘if-tty’\n");
    }
    const dirsOnlyNames = f.has("d");
    const showAll = f.has("a") || f.has("f");
    const almost = f.has("A") && !showAll;
    const style: QuoteStyle = ((): QuoteStyle => {
      if (quotingWord) return quotingWord === "locale" || quotingWord === "clocale" ? "c" : (quotingWord as QuoteStyle);
      if (f.has("Q")) return "c";
      if (f.has("b")) return "escape";
      if (f.has("N")) return "literal";
      return w.tty ? "shell-escape" : "literal";
    })();
    const hideCtl = f.has("q") || (w.tty && !f.has("show-control-chars") && style === "literal" && !f.has("N"));
    let ind: "none" | "slash" | "file-type" | "classify" = f.has("F") ? "classify" : f.has("file-type") ? "file-type" : f.has("p") ? "slash" : "none";
    if (indWord) ind = indWord as typeof ind;
    const sortKey: "name" | "none" | "size" | "time" | "version" | "extension" = ((): "name" | "none" | "size" | "time" | "version" | "extension" => {
      if (sortWord) return sortWord === "width" ? "name" : (sortWord as "name" | "none" | "size" | "time" | "version" | "extension");
      if (f.has("f") || f.has("U")) return "none";
      if (f.has("S")) return "size";
      if (f.has("t")) return "time";
      if (f.has("v")) return "version";
      if (f.has("X")) return "extension";
      if (!long && (f.has("u") || f.has("c")) && !timeWord) return "time"; // ls -u / ls -c без -l и -t сортируют по времени
      return "name";
    })();
    const baseNum = f.has("si") ? 1000 : 1024;
    const termWidth = widthOpt !== undefined ? Number(widthOpt) : w.tty ? w.cols : 80;
    const now = new Date();

    const timeOf = (inf: NodeInfo): Date => (timeKind === "atime" ? inf.atime : timeKind === "ctime" ? inf.ctime : timeKind === "birth" ? inf.birth : inf.mtime);

    const showName = (name: string): { text: string; quoted: boolean } => {
      const nm = hideCtl ? name.replace(/[\x00-\x1f\x7f]/g, "?") : name;
      return quoteName(nm, style);
    };
    const indicator = (inf: NodeInfo): string => {
      if (ind === "none") return "";
      if (inf.isDir) return "/";
      if (ind === "slash") return "";
      if (inf.isLink) return ind === "classify" || ind === "file-type" ? "@" : "";
      if (ind === "classify" && inf.mode & 0o111) return "*";
      return "";
    };

    let out = "";
    let err = "";
    let code = 0;

    const dirSize = async (inf: NodeInfo) => {
      try {
        const n = (await w.base.readdir(inf.path)).reduce((sum, e) => sum + e.length + 9, 6);
        return n > 4096 ? Math.ceil(n / 4096) * 4096 : n;
      } catch {
        return 6;
      }
    };
    const blocksOf = (inf: NodeInfo) => (inf.isDir || inf.isLink ? 0 : Math.ceil(inf.size / 4096) * 4);
    const isBroken = async (inf: NodeInfo) => inf.isLink && !(await w.info(inf.path, true));
    const inoOf = (inf: NodeInfo) => String(w.inodes.ino(inf.path));
    const blkStr = (inf: NodeInfo) => String(f.has("k") || !f.has("h") ? blocksOf(inf) : humanSize(blocksOf(inf) * 1024, baseNum));

    /** Ячейка с именем: цвет, кавычки, индикатор; для ссылки в -l — стрелка на цель. */
    const nameCell = async (it: LsItem, align: boolean, withTarget: boolean): Promise<string> => {
      const q = showName(it.name);
      const broken = await isBroken(it.inf);
      let cell = (align && !q.quoted ? " " : "") + colorize(w, it.inf, q.text, broken, useColor) + indicator(it.inf);
      if (withTarget && it.inf.isLink) {
        try {
          cell += " -> " + w.files.displayTarget(await w.base.readlink(it.inf.path));
        } catch {
          /* битая ссылка */
        }
      }
      return cell;
    };

    const render = async (entries: LsItem[], dirInf: NodeInfo | null): Promise<string> => {
      let res = "";
      if (!entries.length) return dirInf && (fmt === "long" || f.has("s")) ? "total 0\n" : "";
      const quotedAny = entries.some((e) => showName(e.name).quoted);
      const align = quotedAny && (fmt === "long" || fmt === "columns" || fmt === "across") && style !== "literal" && style !== "escape" && style !== "c";
      if (dirInf && (fmt === "long" || f.has("s"))) res += `total ${f.has("h") ? humanSize(entries.reduce((sum, e) => sum + blocksOf(e.inf) * 1024, 0), baseNum) : entries.reduce((sum, e) => sum + blocksOf(e.inf), 0)}\n`;
      const inoW = f.has("i") ? Math.max(...entries.map((e) => inoOf(e.inf).length)) : 0;
      const blkW = f.has("s") ? Math.max(...entries.map((e) => blkStr(e.inf).length)) : 0;
      const frills = (inf: NodeInfo) => (f.has("i") ? inoOf(inf).padStart(inoW) + " " : "") + (f.has("s") ? blkStr(inf).padStart(blkW) + " " : "");
      if (fmt === "long") {
        const rows: string[][] = [];
        for (const { name, inf } of entries) {
          const size = inf.isDir ? await dirSize(inf) : inf.size;
          const user = f.has("n") ? String(inf.uid) : (w.userByUid(inf.uid)?.name ?? String(inf.uid));
          const group = f.has("n") ? String(inf.gid) : (w.groupByGid(inf.gid)?.name ?? String(inf.gid));
          const when = timeStyle ? formatLsTime(timeOf(inf), timeStyle, now) : lsDate(timeOf(inf), now);
          rows.push([
            frills(inf) + modeString(inf) + ".",
            String(await linkCount(w, inf)),
            f.has("g") ? "" : user,
            f.has("o") || f.has("G") ? "" : group,
            f.has("h") ? humanSize(size, baseNum) : String(size),
            when,
            await nameCell({ name, inf }, align, true),
          ]);
        }
        const wd = [1, 2, 3, 4].map((c) => Math.max(...rows.map((r) => r[c].length)));
        res += rows
          .map((r) => {
            const cols = [r[0], r[1].padStart(wd[0]), f.has("g") ? null : r[2].padEnd(wd[1]), f.has("o") || f.has("G") ? null : r[3].padEnd(wd[2]), r[4].padStart(wd[3]), r[5], r[6]];
            return cols.filter((c): c is string => c !== null).join(" ");
          })
          .join("\n") + "\n";
        return res;
      }
      const cells: string[] = [];
      for (const e of entries) cells.push(frills(e.inf) + (await nameCell(e, align, false)));
      if (fmt === "one") return res + cells.join("\n") + "\n";
      if (fmt === "commas") {
        let line = "";
        const lines: string[] = [];
        cells.forEach((c, i) => {
          const len = visLen(c);
          if (i === 0) line = c;
          else if (termWidth > 0 && visLen(line) + len + 2 > termWidth) {
            lines.push(line + ",");
            line = c;
          } else line += ", " + c;
        });
        lines.push(line);
        return res + lines.join("\n") + "\n";
      }
      return res + columns(cells, termWidth, fmt === "across");
    };

    const cmpFor = (): ((a: LsItem, b: LsItem) => number) => {
      const byName = (a: LsItem, b: LsItem) => nameCompare(a.name, b.name);
      switch (sortKey) {
        case "none":
          return () => 0;
        case "size":
          return (a, b) => b.inf.size - a.inf.size || byName(a, b);
        case "time":
          return (a, b) => timeOf(b.inf).getTime() - timeOf(a.inf).getTime() || byName(a, b);
        case "version":
          return (a, b) => versionCompare(a.name, b.name) || byName(a, b);
        case "extension": {
          const ext = (n: string) => (n.lastIndexOf(".") > 0 ? n.slice(n.lastIndexOf(".") + 1) : "");
          return (a, b) => (ext(a.name) < ext(b.name) ? -1 : ext(a.name) > ext(b.name) ? 1 : 0) || byName(a, b);
        }
        default:
          return byName;
      }
    };
    const sortEntries = (arr: LsItem[]) => {
      arr.sort(cmpFor());
      if (f.has("group-directories-first")) {
        const dirs = arr.filter((e) => e.inf.isDir);
        const rest = arr.filter((e) => !e.inf.isDir);
        arr.splice(0, arr.length, ...dirs, ...rest);
      }
      if (f.has("r")) arr.reverse();
      return arr;
    };

    const targets = p.rest.length ? p.rest : ["."];
    const files: LsItem[] = [];
    const dirs: LsItem[] = [];
    for (const t of targets) {
      const abs = resolve(ctx.cwd, t);
      if (!(await w.canTraverse(abs))) {
        err += `ls: cannot access '${t}': Permission denied\n`;
        code = 2;
        continue;
      }
      const linf = await w.info(abs);
      // битая ссылка в командной строке без -L листингуется как файл
      const inf = (await w.info(abs, true)) ?? (f.has("L") ? null : linf);
      if (!inf || !linf) {
        err += `ls: cannot access '${t}': No such file or directory\n`;
        code = 2;
        continue;
      }
      if (t.endsWith("/") && t.length > 1 && !inf.isDir) {
        err += `ls: cannot access '${t}': Not a directory\n`;
        code = 2;
        continue;
      }
      // ls -l на симлинк показывает саму ссылку (если нет -L/-H и слэша); без -l ссылка на каталог раскрывается
      const deref = f.has("L") || f.has("H") || !(long || ind === "classify" || ind === "file-type") ? true : t.endsWith("/");
      const shown = deref ? inf : linf;
      if (dirsOnlyNames || !shown.isDir) files.push({ name: t, inf: shown });
      else dirs.push({ name: t, inf });
    }

    sortEntries(files);
    out += await render(files, null);
    sortEntries(dirs);

    const showHeader = targets.length > 1 || f.has("R");
    const listDir = async (name: string, inf: NodeInfo, first: boolean) => {
      if (!w.permOn(inf, "r")) {
        err += `ls: cannot open directory '${name}': Permission denied\n`;
        code = 2;
        return;
      }
      let names = await w.fs.readdir(inf.path); // через охраняемую ФС: чтение каталога обновляет его atime
      if (!showAll && !almost) names = names.filter((n) => !n.startsWith("."));
      const entries: LsItem[] = [];
      for (const n of names) {
        const childPath = inf.path === "/" ? "/" + n : inf.path + "/" + n;
        let ci = await w.info(childPath, f.has("L"));
        if (!ci && f.has("L")) ci = await w.info(childPath);
        if (ci) entries.push({ name: n, inf: ci });
      }
      if (showAll) {
        const parent = (await w.info(resolve(inf.path, ".."), true))!;
        entries.push({ name: ".", inf }, { name: "..", inf: parent });
      }
      sortEntries(entries);
      if (sortKey === "none" && showAll) {
        // без сортировки (-f, -U) «.» и «..» идут первыми, как в реальном каталоге
        const dots = entries.filter((e) => e.name === "." || e.name === "..");
        entries.splice(0, entries.length, ...dots.sort((x, y) => x.name.length - y.name.length), ...entries.filter((e) => e.name !== "." && e.name !== ".."));
      }
      if (showHeader) out += (first && !files.length ? "" : "\n") + `${showName(name).text}:\n`;
      out += await render(entries, inf);
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

/** Время как в stat: `2026-11-02 19:30:01.123000000 +0000`. */
export function statTime(d: Date): string {
  return strftime("%F %T.%N %z", d);
}

/** Одинарные кавычки как у coreutils `quote()`: 'имя'. */
const q1 = (s: string) => `'${s}'`;

/** Разворот escape-последовательностей для --printf. */
function unescapePrintf(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    switch (e[0]) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "a": return "\x07";
      case "b": return "\b";
      case "f": return "\f";
      case "v": return "\v";
      case "\\": return "\\";
      case '"': return '"';
      case "x": return String.fromCharCode(parseInt(e.slice(1), 16));
      default:
        return /[0-7]/.test(e[0]) ? String.fromCharCode(parseInt(e, 8)) : "\\" + e;
    }
  });
}

export function statCommand(w: World): Command {
  return defineCommand("stat", async (args, ctx) => {
    const p = parseArgs(args, { short: "L", withValue: ["c", "format", "printf"], long: { dereference: "L" } });
    if (p.bad) return fail(invalidOpt("stat", p.bad));
    const lastArg = args[args.length - 1];
    if (lastArg === "-c") return fail(`stat: option requires an argument -- 'c'\nTry 'stat --help' for more information.`);
    if (lastArg === "--format" || lastArg === "--printf") return fail(`stat: option '${lastArg}' requires an argument\nTry 'stat --help' for more information.`);
    const raw = p.values.get("printf");
    const fmt = p.values.get("c") ?? p.values.get("format") ?? raw;
    if (!p.rest.length) return fail("stat: missing operand\nTry 'stat --help' for more information.");
    let out = "";
    let err = "";
    let code = 0;
    for (const t of p.rest) {
      const abs = resolve(ctx.cwd, t);
      if (!(await w.canTraverse(abs))) {
        err += `stat: cannot statx ${q1(t)}: Permission denied\n`;
        code = 1;
        continue;
      }
      const inf = await w.info(abs, p.flags.has("L"));
      if (!inf) {
        err += `stat: cannot statx ${q1(t)}: No such file or directory\n`;
        code = 1;
        continue;
      }
      const user = w.userByUid(inf.uid)?.name ?? "UNKNOWN";
      const group = w.groupByGid(inf.gid)?.name ?? "UNKNOWN";
      const links = await linkCount(w, inf);
      const blocks = inf.isDir ? 0 : Math.ceil(inf.size / 512 / 8) * 8;
      const linkTarget = inf.isLink ? w.files.displayTarget(await w.base.readlink(inf.path)) : "";
      const context = `unconfined_u:object_r:${inf.path.startsWith("/home") ? "user_home_t" : inf.path.startsWith("/tmp") ? "user_tmp_t" : "default_t"}:s0`;
      if (fmt !== undefined) {
        const text = raw !== undefined ? unescapePrintf(fmt) : fmt;
        out +=
          text.replace(/%([a-zA-Z%])/g, (_, c: string) => {
            switch (c) {
              case "a": return inf.mode.toString(8);
              case "A": return modeString(inf);
              case "b": return String(blocks);
              case "B": return "512";
              case "C": return context;
              case "d": return "64768";
              case "D": return "fd00";
              case "f": return (inf.mode | (inf.isLink ? 0o120000 : inf.isDir ? 0o040000 : 0o100000)).toString(16);
              case "F": return fileType(inf);
              case "g": return String(inf.gid);
              case "G": return group;
              case "h": return String(links);
              case "i": return String(w.inodes.ino(inf.path));
              case "m": return "/";
              case "n": return t;
              case "N": return inf.isLink ? `${q1(t)} -> ${q1(linkTarget)}` : q1(t);
              case "o": return "4096";
              case "s": return String(inf.size);
              case "t": return "0";
              case "T": return "0";
              case "u": return String(inf.uid);
              case "U": return user;
              case "w": return statTime(inf.birth);
              case "W": return String(Math.floor(inf.birth.getTime() / 1000));
              case "x": return statTime(inf.atime);
              case "X": return String(Math.floor(inf.atime.getTime() / 1000));
              case "y": return statTime(inf.mtime);
              case "Y": return String(Math.floor(inf.mtime.getTime() / 1000));
              case "z": return statTime(inf.ctime);
              case "Z": return String(Math.floor(inf.ctime.getTime() / 1000));
              case "%": return "%";
              default: return "?";
            }
          }) + (raw !== undefined ? "" : "\n");
        continue;
      }
      const name = inf.isLink ? `${t} -> ${linkTarget}` : t;
      out += `  File: ${name}\n`;
      out += `  Size: ${String(inf.size).padEnd(10)}\tBlocks: ${String(blocks).padEnd(10)} IO Block: 4096   ${fileType(inf)}\n`;
      out += `Device: fd00h/64768d\tInode: ${String(w.inodes.ino(inf.path)).padEnd(11)} Links: ${links}\n`;
      out += `Access: (${inf.mode.toString(8).padStart(4, "0")}/${modeString(inf)})  Uid: (${String(inf.uid).padStart(5)}/${user.padStart(8)})   Gid: (${String(inf.gid).padStart(5)}/${group.padStart(8)})\n`;
      out += `Context: ${context}\n`;
      out += `Access: ${statTime(inf.atime)}\nModify: ${statTime(inf.mtime)}\nChange: ${statTime(inf.ctime)}\n Birth: ${statTime(inf.birth)}\n`;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

/** Свой cat — чтобы корректно писать «Permission denied» и «Is a directory» и уметь -A -b -e -E -n -s -t -T -v. */
export function catCommand(w: World): Command {
  return defineCommand("cat", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "AbeEnstTuv",
      long: { "show-all": "A", "number-nonblank": "b", "show-ends": "E", number: "n", "squeeze-blank": "s", "show-tabs": "T", "show-nonprinting": "v" },
      digits: false,
    });
    if (p.bad) return fail(invalidOpt("cat", p.bad));
    const f = p.flags;
    const showEnds = f.has("A") || f.has("E") || f.has("e");
    const showTabs = f.has("A") || f.has("T") || f.has("t");
    const showNp = f.has("A") || f.has("v") || f.has("e") || f.has("t");
    const numberNonBlank = f.has("b");
    const number = f.has("n") && !numberNonBlank;
    const squeeze = f.has("s");
    const plainCopy = !(showEnds || showTabs || showNp || numberNonBlank || number || squeeze);
    const targets = p.rest.length ? p.rest : ["-"];
    let out = "";
    let err = "";
    let code = 0;
    let lineNo = 0;
    let prevBlank = false;
    const enc = new TextEncoder();
    const render = (text: string): string => {
      if (plainCopy) return text;
      const lines = text.split("\n");
      const endsWithNl = text.endsWith("\n");
      if (endsWithNl) lines.pop();
      const res: string[] = [];
      lines.forEach((ln, i) => {
        const blank = ln === "";
        if (squeeze && blank && prevBlank) return;
        prevBlank = blank;
        let body = "";
        if (showNp || showTabs) {
          for (const byte of enc.encode(ln)) {
            if (byte === 9) body += showTabs ? "^I" : "\t";
            else if (showNp && byte < 32) body += "^" + String.fromCharCode(byte + 64);
            else if (showNp && byte === 127) body += "^?";
            else if (showNp && byte >= 128) body += "M-" + (byte - 128 < 32 ? "^" + String.fromCharCode(byte - 128 + 64) : byte - 128 === 127 ? "^?" : String.fromCharCode(byte - 128));
            else body += String.fromCharCode(byte);
          }
          if (!showNp) body = bytesToText(body); // без -v многобайтные символы остаются как есть
        } else body = ln;
        const hasNl = i < lines.length - 1 || endsWithNl;
        let prefix = "";
        if (numberNonBlank ? !blank : number) prefix = `${String(++lineNo).padStart(6)}\t`;
        res.push(prefix + body + (showEnds && hasNl ? "$" : "") + (hasNl ? "\n" : ""));
      });
      return res.join("");
    };
    for (const t of targets) {
      if (t === "-") {
        out += render(bytesToText(ctx.stdin));
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
      out += render((await w.read(abs)) ?? "");
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}


// ---------- head ----------

/** Число с суффиксом как у coreutils: 10, 1k, 2K, 3M, 1b (=512), 1kB (=1000). */
function parseCount(v: string): number | null {
  const m = /^(\d+)(b|kB|KB|k|K|MB|M|GB|G)?$/.exec(v);
  if (!m) return null;
  const mult: Record<string, number> = { b: 512, kB: 1000, KB: 1000, k: 1024, K: 1024, MB: 1e6, M: 1024 ** 2, GB: 1e9, G: 1024 ** 3 };
  return Number(m[1]) * (m[2] ? mult[m[2]] : 1);
}

/** Свой head: умеет -n -N / -c -N (всё, кроме последних N), -q, -v, несколько файлов. */
export function headCommand(w: World): Command {
  return defineCommand("head", async (args, ctx) => {
    // -5 — сокращение для -n 5
    const norm = args.map((a, i) => (/^-\d+$/.test(a) && !["-n", "-c", "--lines", "--bytes"].includes(args[i - 1] ?? "") ? `-n${a.slice(1)}` : a));
    const p = parseArgs(norm, { short: "qvz", withValue: ["n", "c"], long: { lines: "n", bytes: "c", quiet: "q", silent: "q", verbose: "v", "zero-terminated": "z" } });
    if (p.bad) return fail(invalidOpt("head", p.bad));
    let mode: "n" | "c" = "n";
    let raw = "10";
    for (const a of norm) {
      if (a === "--") break;
      const m = /^-[a-zA-Z]*([nc])(.*)$/.exec(a) ?? /^--(lines|bytes)=(.*)$/.exec(a);
      if (m) {
        mode = m[1][0] as "n" | "c";
        raw = m[2] || p.values.get(mode) || raw;
      }
    }
    if (p.values.has("n") && mode === "n") raw = p.values.get("n")!;
    if (p.values.has("c") && mode === "c") raw = p.values.get("c")!;
    const neg = raw.startsWith("-");
    const count = parseCount(neg ? raw.slice(1) : raw.replace(/^\+/, ""));
    if (count === null) return fail(`head: invalid number of ${mode === "n" ? "lines" : "bytes"}: '${raw}'`);
    const files = p.rest.length ? p.rest : ["-"];
    const header = files.length > 1 ? !p.flags.has("q") : p.flags.has("v");
    const sep = p.flags.has("z") ? "\0" : "\n";
    let out = "";
    let err = "";
    let code = 0;
    const take = (text: string): string => {
      if (mode === "c") {
        const bytes = new TextEncoder().encode(text);
        const n = neg ? Math.max(0, bytes.length - count) : Math.min(count, bytes.length);
        return new TextDecoder().decode(bytes.slice(0, n));
      }
      const lines = text.split(sep);
      const trailing = text.endsWith(sep);
      if (trailing) lines.pop();
      const n = neg ? Math.max(0, lines.length - count) : Math.min(count, lines.length);
      const kept = lines.slice(0, n);
      const full = n < lines.length || trailing;
      return kept.join(sep) + (kept.length && full ? sep : "");
    };
    let first = true;
    for (const t of files) {
      let text: string;
      let shown = t;
      if (t === "-") {
        text = bytesToText(ctx.stdin);
        shown = "standard input";
      } else {
        const abs = resolve(ctx.cwd, t);
        const inf = await w.info(abs, true);
        if (!inf) {
          err += `head: cannot open '${t}' for reading: No such file or directory\n`;
          code = 1;
          continue;
        }
        if (!(await w.canTraverse(abs)) || (!inf.isDir && !w.permOn(inf, "r"))) {
          err += `head: cannot open '${t}' for reading: Permission denied\n`;
          code = 1;
          continue;
        }
        if (inf.isDir) {
          err += `head: error reading '${t}': Is a directory\n`;
          code = 1;
          continue;
        }
        text = (await w.read(abs)) ?? "";
      }
      if (header) out += `${first ? "" : "\n"}==> ${shown} <==\n`;
      first = false;
      out += take(text);
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}
