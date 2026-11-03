// find (GNU findutils 4.8): выражения с -a/-o/!/(), тесты по имени, типу, владельцу, правам, времени, размеру, inode,
// ссылкам; действия -print/-print0/-printf/-ls/-delete/-exec/-ok/-fprint/-prune/-quit. Времена — из модели мира.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { NodeInfo, World } from "../world";
import { resolve } from "../path";
import { parseDateSpec } from "../datespec";
import { segmentRegex } from "../globs";
import { lsDate, shq, strftime } from "../util";
import { applyMode } from "./perms";
import { linkCount, modeString } from "./files";
import { makeAsker } from "./fileops";

const q = (s: string) => `‘${s}’`; // findutils пишет имена через quote(): в UTF-8-локали Rocky это типографские кавычки

type Node =
  | { t: "and" | "or"; a: Node; b: Node }
  | { t: "not"; a: Node }
  | { t: "test"; name: string; arg?: string; extra?: string[] };

const ACTIONS = new Set(["-print", "-print0", "-printf", "-ls", "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fls", "-fprintf"]);
const WITH_ARG = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-lname", "-ilname", "-regex", "-iregex", "-type", "-xtype", "-inum", "-links", "-size",
  "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-newer", "-anewer", "-cnewer", "-perm", "-user", "-group", "-uid", "-gid", "-samefile", "-fstype",
  "-printf", "-fprint", "-fprint0", "-fls", "-used", "-context", "-newerat", "-newerac", "-newerat", "-regextype",
]);
const NOARG = new Set([
  "-true", "-false", "-empty", "-nouser", "-nogroup", "-readable", "-writable", "-executable", "-print", "-print0", "-ls", "-delete", "-prune", "-quit",
]);

class FindError extends Error {}

export function findCommand(w: World): Command {
  return defineCommand("find", async (args, ctx) => {
    let out = "";
    let err = "";
    let code = 0;
    try {
      const r = await runFind(w, args, ctx, (s) => (out += s), (s) => (err += s));
      code = r;
    } catch (e) {
      if (e instanceof FindError) {
        err += `find: ${e.message}\n`;
        code = 1;
      } else throw e;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

interface Entry {
  path: string;
  abs: string;
  depth: number;
  inf: NodeInfo;
  name: string;
  start: string;
}

async function runFind(
  w: World,
  args: string[],
  ctx: { cwd: string; stdin: unknown; exec?: (c: string, o: { cwd: string }) => Promise<{ stdout: string; stderr: string; exitCode: number }> },
  emit: (s: string) => void,
  emitErr: (s: string) => void,
): Promise<number> {
  let i = 0;
  let follow = false;
  while (i < args.length && /^-(H|L|P|D\w*|O\d)$/.test(args[i])) {
    if (args[i] === "-L") follow = true;
    i++;
  }
  const starts: string[] = [];
  while (i < args.length && !args[i].startsWith("-") && args[i] !== "!" && args[i] !== "(") starts.push(args[i++]);
  if (!starts.length) starts.push(".");

  // --- глобальные опции и разбор выражения ---
  let maxDepth = Infinity;
  let minDepth = 0;
  let depthFirst = false;
  let xdev = false;
  let daystart = false;
  const toks: string[] = [];
  let sawTest = "";
  const needNum = (opt: string, v: string | undefined) => {
    if (v === undefined) throw new FindError(`missing argument to \`${opt}'`);
    if (!/^\d+$/.test(v)) throw new FindError(`Expected a positive decimal integer argument to ${opt}, but got ${q(v)}`);
    return Number(v);
  };
  const rest = args.slice(i);
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    const warnPos = (name: string) => {
      if (sawTest)
        emitErr(`find: warning: you have specified the global option ${name} after the argument ${sawTest}, but global options are not positional, i.e., ${name} affects tests specified before it as well as those specified after it.  Please specify global options before other arguments.\n`);
    };
    if (a === "-maxdepth") (warnPos(a), (maxDepth = needNum(a, rest[++k])));
    else if (a === "-mindepth") (warnPos(a), (minDepth = needNum(a, rest[++k])));
    else if (a === "-depth" || a === "-d") (warnPos("-depth"), (depthFirst = true));
    else if (a === "-xdev" || a === "-mount") (warnPos(a), (xdev = true));
    else if (a === "-daystart") daystart = true;
    else if (a === "-follow") follow = true;
    else if (a === "-noleaf" || a === "-ignore_readdir_race" || a === "-noignore_readdir_race") continue;
    else if (a === "-regextype" || a === "-D" || a === "-O") k++;
    else {
      toks.push(a);
      if (/^-/.test(a) && !["-o", "-a", "-and", "-or", "-not"].includes(a) && !sawTest) sawTest = a;
      if (WITH_ARG.has(a) || a === "-exec" || a === "-execdir" || a === "-ok" || a === "-okdir") {
        if (a.startsWith("-exec") || a.startsWith("-ok")) {
          // команда до ; или +
          let j = k + 1;
          while (j < rest.length && rest[j] !== ";" && rest[j] !== "+") j++;
          if (j >= rest.length) throw new FindError(`missing argument to \`${a}'`);
          toks.push(...rest.slice(k + 1, j + 1));
          k = j;
        } else {
          if (k + 1 >= rest.length) throw new FindError(`missing argument to \`${a}'`);
          toks.push(rest[++k]);
        }
      }
    }
  }

  // рекурсивный разбор: or > and > not > primary
  let p = 0;
  const peek = () => toks[p];
  const parseOr = (): Node => {
    let left = parseAnd();
    while (peek() === "-o" || peek() === "-or") {
      p++;
      left = { t: "or", a: left, b: parseAnd() };
    }
    return left;
  };
  const parseAnd = (): Node => {
    let left = parseNot();
    for (;;) {
      const t = peek();
      if (t === "-a" || t === "-and") p++;
      else if (t === undefined || t === "-o" || t === "-or" || t === ")") break;
      left = { t: "and", a: left, b: parseNot() };
    }
    return left;
  };
  const parseNot = (): Node => {
    const t = peek();
    if (t === "!" || t === "-not") {
      p++;
      return { t: "not", a: parseNot() };
    }
    return parsePrimary();
  };
  const parsePrimary = (): Node => {
    const t = toks[p++];
    if (t === undefined) throw new FindError("invalid expression; expected to find a predicate");
    if (t === "(") {
      const e = parseOr();
      if (toks[p++] !== ")") throw new FindError("invalid expression; I was expecting to find a ')' somewhere but did not see one.");
      return e;
    }
    if (t === ")") throw new FindError("invalid expression; you have too many ')'");
    if (!t.startsWith("-")) throw new FindError(`paths must precede expression: \`${t}'\nFind: possible unquoted pattern after predicate \`-name'?`.split("\n")[0]);
    if (t.startsWith("-exec") || t.startsWith("-ok")) {
      const cmd: string[] = [];
      while (toks[p] !== ";" && toks[p] !== "+") cmd.push(toks[p++]);
      const term = toks[p++];
      return { t: "test", name: t, arg: term, extra: cmd };
    }
    if (WITH_ARG.has(t) || /^-newer[acmBt][acmBt]$/.test(t)) return { t: "test", name: t, arg: toks[p++] };
    if (!NOARG.has(t)) throw new FindError(`unknown predicate \`${t}'`);
    return { t: "test", name: t };
  };
  let tree: Node | null = null;
  if (toks.length) {
    tree = parseOr();
    if (p < toks.length) throw new FindError(toks[p] === ")" ? "invalid expression; you have too many ')'" : `paths must precede expression: \`${toks[p]}'`);
  }
  const hasAction = (n: Node | null): boolean =>
    !n ? false : n.t === "test" ? ACTIONS.has(n.name) : n.t === "not" ? hasAction(n.a) : hasAction(n.a) || hasAction(n.b);
  const usesDelete = (n: Node | null): boolean => (!n ? false : n.t === "test" ? n.name === "-delete" : n.t === "not" ? usesDelete(n.a) : usesDelete(n.a) || usesDelete(n.b));
  if (usesDelete(tree)) depthFirst = true;
  if (!tree) tree = { t: "test", name: "-print" };
  else if (!hasAction(tree)) tree = { t: "and", a: tree, b: { t: "test", name: "-print" } };

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const refNow = daystart ? dayStart.getTime() : now.getTime();
  const me = w.cur;
  let exit = 0;
  let quit = false;
  const ask = makeAsker(w, ctx.stdin, emitErr);
  const batches = new Map<Node, { cmd: string[]; paths: string[] }>();

  const joinPath = (base: string, n: string) => (base.endsWith("/") ? base + n : `${base}/${n}`);
  const typeChar = (inf: NodeInfo) => (inf.isLink ? "l" : inf.isDir ? "d" : "f");
  const sizeBlocks = (inf: NodeInfo) => (inf.isDir || inf.isLink ? 0 : Math.ceil(inf.size / 4096) * 8);
  const userName = (uid: number) => w.userByUid(uid)?.name ?? String(uid);
  const groupName = (gid: number) => w.groupByGid(gid)?.name ?? String(gid);

  const cmpNum = (spec: string, value: number, name: string): boolean => {
    const m = /^([+-]?)(\d+)$/.exec(spec);
    if (!m) throw new FindError(`invalid argument ${q(spec)} to \`${name}'`);
    const n = Number(m[2]);
    return m[1] === "+" ? value > n : m[1] === "-" ? value < n : value === n;
  };

  const permBits = (spec: string): { bits: number; kind: "exact" | "all" | "any" } => {
    const kind = spec.startsWith("-") ? "all" : spec.startsWith("/") ? "any" : "exact";
    const body = kind === "exact" ? spec : spec.slice(1);
    let bits: number | null;
    if (/^[0-7]+$/.test(body)) bits = parseInt(body, 8);
    else bits = applyMode(body, 0, false, 0);
    if (bits === null) throw new FindError(`invalid mode ${q(spec)}`);
    return { bits, kind };
  };

  const formatPrintf = async (fmt: string, e: Entry): Promise<string> => {
    const inf = e.inf;
    const target = inf.isLink ? await w.base.readlink(inf.path) : "";
    const tf = (d: Date, c: string): string => {
      if (c === "@") return `${Math.floor(d.getTime() / 1000)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}0000000`;
      if (c === "+") return `${strftime("%F+%T", d)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}0000000`;
      if (c === "c") return `${strftime("%a %b %e %H:%M:%S", d)}.${String(d.getUTCMilliseconds()).padStart(3, "0")}0000000 ${d.getUTCFullYear()}`;
      return strftime(`%${c}`, d);
    };
    let res = "";
    for (let k = 0; k < fmt.length; k++) {
      const c = fmt[k];
      if (c === "\\") {
        const n = fmt[++k];
        res += n === "n" ? "\n" : n === "t" ? "\t" : n === "0" ? "\0" : n === "\\" ? "\\" : n === "r" ? "\r" : "\\" + (n ?? "");
        continue;
      }
      if (c !== "%") {
        res += c;
        continue;
      }
      let n = fmt[++k];
      let width = "";
      while (n !== undefined && /[-\d.]/.test(n)) {
        width += n;
        n = fmt[++k];
      }
      let v: string;
      switch (n) {
        case "%": v = "%"; break;
        case "p": v = e.path; break;
        case "P": v = e.path === e.start ? "" : e.path.slice(e.start.length).replace(/^\//, ""); break;
        case "f": v = e.name; break;
        case "h": v = e.path.includes("/") ? e.path.replace(/\/[^/]*$/, "") || "/" : "."; break;
        case "s": v = String(inf.size); break;
        case "b": v = String(Math.ceil(sizeBlocks(inf) / 1)); break;
        case "k": v = String(sizeBlocks(inf) / 2); break;
        case "m": v = (inf.mode & 0o7777).toString(8); break;
        case "M": v = modeString(inf); break;
        case "u": v = userName(inf.uid); break;
        case "U": v = String(inf.uid); break;
        case "g": v = groupName(inf.gid); break;
        case "G": v = String(inf.gid); break;
        case "y": v = typeChar(inf); break;
        case "Y": v = inf.isLink ? ((await w.info(e.abs, true)) ? typeChar((await w.info(e.abs, true))!) : "N") : typeChar(inf); break;
        case "l": v = target; break;
        case "i": v = String(w.inodes.ino(inf.path)); break;
        case "n": v = String(await linkCount(w, inf)); break;
        case "d": v = String(e.depth); break;
        case "t": v = tf(inf.mtime, "c"); break;
        case "A": case "C": case "T": {
          const d = n === "A" ? inf.atime : n === "C" ? inf.ctime : inf.mtime;
          v = tf(d, fmt[++k]);
          break;
        }
        default: v = "%" + (n ?? "");
      }
      if (width) {
        const wd = Number(width.replace("-", "").split(".")[0]) || 0;
        v = width.startsWith("-") ? v.padEnd(wd) : v.padStart(wd);
      }
      res += v;
    }
    return res;
  };

  const lsLine = async (e: Entry): Promise<string> => {
    const inf = e.inf;
    const target = inf.isLink ? ` -> ${await w.base.readlink(inf.path)}` : "";
    return `${String(w.inodes.ino(inf.path)).padStart(6)} ${String(sizeBlocks(inf) / 2).padStart(4)} ${modeString(inf)} ${String(await linkCount(w, inf)).padStart(3)} ${userName(inf.uid).padEnd(8)} ${groupName(inf.gid).padEnd(8)} ${String(inf.size).padStart(8)} ${lsDate(inf.mtime)} ${e.path}${target}\n`;
  };

  const run = async (command: string): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    if (!ctx.exec) return { stdout: "", stderr: "find: -exec не поддерживается в этом окружении\n", exitCode: 1 };
    return ctx.exec(command, { cwd: ctx.cwd });
  };

  const test = async (n: Extract<Node, { t: "test" }>, e: Entry): Promise<boolean> => {
    const inf = e.inf;
    const arg = n.arg ?? "";
    switch (n.name) {
      case "-true": return true;
      case "-false": return false;
      case "-name": return segmentRegex(arg).test(e.name);
      case "-iname": return new RegExp(segmentRegex(arg).source, "is").test(e.name);
      case "-path": case "-wholename": return segmentRegex(arg).test(e.path);
      case "-ipath": case "-iwholename": return new RegExp(segmentRegex(arg).source, "is").test(e.path);
      case "-lname": return inf.isLink && segmentRegex(arg).test(await w.base.readlink(inf.path));
      case "-ilname": return inf.isLink && new RegExp(segmentRegex(arg).source, "is").test(await w.base.readlink(inf.path));
      case "-regex": return new RegExp(`^(?:${arg})$`, "s").test(e.path);
      case "-iregex": return new RegExp(`^(?:${arg})$`, "is").test(e.path);
      case "-type":
      case "-xtype": {
        let t = inf.isLink ? "l" : inf.isDir ? "d" : "f";
        if (n.name === "-xtype" && inf.isLink) {
          const target = await w.info(e.abs, true);
          t = target ? typeChar(target) : "l";
        }
        const known = "bcdpflsD";
        for (const c of arg.split(",")) if (c.length !== 1 || !known.includes(c)) throw new FindError(`Unknown argument to -type: ${c}`);
        return arg.split(",").includes(t);
      }
      case "-inum": return cmpNum(arg, w.inodes.ino(inf.path), n.name);
      case "-links": return cmpNum(arg, await linkCount(w, inf), n.name);
      case "-samefile": {
        const ref = await w.info(resolve(ctx.cwd, arg), follow);
        if (!ref) throw new FindError(`${q(arg)}: No such file or directory`);
        return w.inodes.sameFile(ref.path, inf.path);
      }
      case "-empty": return inf.isDir ? (await w.base.readdir(e.abs)).length === 0 : !inf.isLink && inf.size === 0;
      case "-size": {
        const m = /^([+-]?)(\d+)([cwbkMG]?)$/.exec(arg);
        if (!m) throw new FindError(`Invalid argument ${q(arg)} to -size`);
        const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3, "": 512 }[m[3] as "c"];
        const v = Math.ceil(inf.size / unit);
        const nn = Number(m[2]);
        return m[1] === "+" ? v > nn : m[1] === "-" ? v < nn : v === nn;
      }
      case "-mtime": case "-atime": case "-ctime": {
        const t = n.name === "-mtime" ? inf.mtime : n.name === "-atime" ? inf.atime : inf.ctime;
        return cmpNum(arg, Math.floor((refNow - t.getTime()) / 86400000), n.name);
      }
      case "-mmin": case "-amin": case "-cmin": {
        const t = n.name === "-mmin" ? inf.mtime : n.name === "-amin" ? inf.atime : inf.ctime;
        const age = (refNow - t.getTime()) / 60000;
        const m = /^([+-]?)(\d+)$/.exec(arg);
        if (!m) throw new FindError(`invalid argument ${q(arg)} to \`${n.name}'`);
        const nn = Number(m[2]);
        return m[1] === "+" ? age > nn : m[1] === "-" ? age < nn : Math.ceil(age) === nn;
      }
      case "-newer": case "-anewer": case "-cnewer": {
        const ref = await w.info(resolve(ctx.cwd, arg), follow);
        if (!ref) throw new FindError(`${q(arg)}: No such file or directory`);
        const mine = n.name === "-newer" ? inf.mtime : n.name === "-anewer" ? inf.atime : inf.ctime;
        return mine.getTime() > ref.mtime.getTime();
      }
      case "-perm": {
        const { bits, kind } = permBits(arg);
        const mode = inf.mode & 0o7777;
        return kind === "exact" ? mode === bits : kind === "all" ? (mode & bits) === bits : bits === 0 || (mode & bits) !== 0;
      }
      case "-user": case "-uid": {
        if (n.name === "-user" && !/^\d+$/.test(arg)) {
          const u = w.user(arg);
          if (!u) throw new FindError(`${q(arg)} is not the name of a known user`);
          return inf.uid === u.uid;
        }
        return n.name === "-user" ? inf.uid === Number(arg) : cmpNum(arg, inf.uid, n.name);
      }
      case "-group": case "-gid": {
        if (n.name === "-group" && !/^\d+$/.test(arg)) {
          const g = w.group(arg);
          if (!g) throw new FindError(`${q(arg)} is not the name of a known group`);
          return inf.gid === g.gid;
        }
        return n.name === "-group" ? inf.gid === Number(arg) : cmpNum(arg, inf.gid, n.name);
      }
      case "-nouser": return !w.userByUid(inf.uid);
      case "-nogroup": return !w.groupByGid(inf.gid);
      case "-readable": return me.uid === 0 || w.permOn(inf, "r");
      case "-writable": return me.uid === 0 || w.permOn(inf, "w");
      case "-executable": return w.permOn(inf, "x");
      case "-fstype": return w.storage.mountFor(e.abs).fstype === arg;
      case "-prune": pruneHit = true; return true;
      case "-quit": quit = true; return true;
      case "-print": emit(e.path + "\n"); return true;
      case "-print0": emit(e.path + "\0"); return true;
      case "-printf": emit(await formatPrintf(arg, e)); return true;
      case "-ls": emit(await lsLine(e)); return true;
      case "-fprint": case "-fprint0": case "-fls": {
        const f = resolve(ctx.cwd, arg);
        const text = n.name === "-fls" ? await lsLine(e) : e.path + (n.name === "-fprint0" ? "\0" : "\n");
        await w.fs.appendFile(f, text);
        return true;
      }
      case "-delete": {
        if (e.path === e.start && e.depth === 0 && (e.path === "." || e.path === "..")) return true;
        try {
          if (inf.isDir && (await w.base.readdir(e.abs)).length) throw new Error("ENOTEMPTY");
          await w.fs.rm(e.abs);
          return true;
        } catch (er) {
          const m = er instanceof Error ? er.message : "";
          emitErr(`find: cannot delete ${q(e.path)}: ${/ENOTEMPTY/.test(m) ? "Directory not empty" : /EACCES/.test(m) ? "Permission denied" : /EPERM/.test(m) ? "Operation not permitted" : m}\n`);
          exit = 1;
          return false;
        }
      }
      default:
        break;
    }
    if (n.name.startsWith("-exec") || n.name.startsWith("-ok")) {
      const cmd = n.extra ?? [];
      const dirMode = n.name.endsWith("dir");
      const path = dirMode ? "./" + e.name : e.path;
      if (n.arg === "+") {
        let b = batches.get(n);
        if (!b) batches.set(n, (b = { cmd, paths: [] }));
        b.paths.push(path);
        return true;
      }
      if (n.name.startsWith("-ok") && !(await ask.yes(`< ${cmd[0]} ... ${path} > ? `))) return false;
      const line = cmd.map((c) => shq(c.replace(/\{\}/g, path))).join(" ");
      const r = await run(dirMode ? `cd ${shq(dirname2(e.abs))} && ${line}` : line);
      emit(r.stdout);
      emitErr(r.stderr);
      return r.exitCode === 0;
    }
    if (/^-newer[acmB][acmt]$/.test(n.name)) {
      const X = n.name[6];
      const Y = n.name[7];
      const mine = X === "a" ? inf.atime : X === "c" ? inf.ctime : X === "B" ? inf.birth : inf.mtime;
      let ref: Date | null;
      if (Y === "t") ref = parseDateSpec(arg, now);
      else {
        const r = await w.info(resolve(ctx.cwd, arg), follow);
        ref = r ? (Y === "a" ? r.atime : Y === "c" ? r.ctime : r.mtime) : null;
      }
      if (!ref) throw new FindError(Y === "t" ? `I cannot figure out how to interpret ${q(arg)} as a date or time` : `${q(arg)}: No such file or directory`);
      return mine.getTime() > ref.getTime();
    }
    throw new FindError(`unknown predicate \`${n.name}'`);
  };

  const dirname2 = (abs: string) => abs.replace(/\/[^/]*$/, "") || "/";

  const evalNode = async (n: Node, e: Entry): Promise<boolean> => {
    if (n.t === "test") return test(n, e);
    if (n.t === "not") return !(await evalNode(n.a, e));
    if (n.t === "and") return (await evalNode(n.a, e)) && (await evalNode(n.b, e));
    return (await evalNode(n.a, e)) || (await evalNode(n.b, e));
  };

  let pruneHit = false;
  const visit = async (e: Entry, startMountId: number): Promise<void> => {
    if (quit) return;
    const descend = async () => {
      if (!e.inf.isDir || e.depth >= maxDepth) return;
      if (xdev && w.storage.mountFor(e.abs).id !== startMountId) return;
      if (me.uid !== 0 && !w.permOn(e.inf, "r")) {
        emitErr(`find: ${q(e.path)}: Permission denied\n`);
        exit = 1;
        return;
      }
      let names: string[];
      try {
        names = await w.fs.readdir(e.abs);
      } catch {
        return;
      }
      for (const nm of names) {
        if (quit) return;
        const cabs = e.abs === "/" ? "/" + nm : `${e.abs}/${nm}`;
        const ci = await w.info(cabs, follow);
        if (!ci) continue;
        await visit({ path: joinPath(e.path, nm), abs: cabs, depth: e.depth + 1, inf: ci, name: nm, start: e.start }, startMountId);
      }
    };
    const evaluate = async () => {
      if (e.depth < minDepth) return;
      await evalNode(tree!, e);
    };
    if (depthFirst) {
      await descend();
      await evaluate();
    } else {
      pruneHit = false;
      await evaluate();
      if (!pruneHit) await descend();
    }
  };

  for (const s of starts) {
    const abs = resolve(ctx.cwd, s);
    const inf = await w.info(abs, follow);
    if (!inf || !(await w.canTraverse(abs))) {
      emitErr(`find: ${q(s)}: ${inf ? "Permission denied" : "No such file or directory"}\n`);
      exit = 1;
      continue;
    }
    const name = s.replace(/\/+$/, "").split("/").pop() || s;
    await visit({ path: s, abs, depth: 0, inf, name: s === "/" ? "/" : name, start: s }, w.storage.mountFor(abs).id);
  }
  // -exec ... {} + — один запуск на все найденные пути
  for (const b of batches.values()) {
    if (!b.paths.length) continue;
    const line = b.cmd.flatMap((c) => (c === "{}" ? b.paths : [c])).map((c) => shq(c)).join(" ");
    const r = await run(line);
    emit(r.stdout);
    emitErr(r.stderr);
    if (r.exitCode !== 0) exit = 1;
  }
  return exit;
}
