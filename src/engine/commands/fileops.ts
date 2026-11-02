// rm, cp, mv — свои реализации по образцу GNU coreutils 8.32 (RHEL 9): интерактивные вопросы (-i, -I),
// сохранение атрибутов (-p, -a), -T/-t, резервные копии, подробный вывод (-v), «сухие» ошибки как у настоящих.
// Времена (atime/ctime/mtime) и владельцев ведёт мир: здесь только вызываем охраняемую ФС и World.setTimes/setOwner.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { NodeInfo, World } from "../world";
import { basename, dirname, normalize, resolve } from "../path";
import { bytesToText, errnoText, fail, invalidOpt, parseArgs } from "../util";
import { modeString } from "./files";

const q = (s: string) => `'${s}'`;
const tryHelp = (cmd: string) => `Try '${cmd} --help' for more information.`;

// ---------- вопросы пользователю ----------

/**
 * Ответы на вопросы `rm -i`/`cp -i`/`mv -i`: из канала (`yes | rm -i`), от пользователя в терминале (w.readLine)
 * или EOF (= «нет», как у настоящей команды без tty). Если вопрос не показал экран терминала, текст уходит в stderr.
 */
export function makeAsker(w: World, stdin: unknown, emit: (s: string) => void) {
  const piped = String(stdin ?? "").length > 0;
  const lines = piped ? bytesToText(stdin).split("\n") : [];
  let pos = 0;
  return {
    /** Ввод идёт с терминала (нужно для вопросов про write-protected файлы). */
    tty: !piped && !!w.readLine,
    async yes(text: string): Promise<boolean> {
      let ans: string | null;
      if (piped) {
        emit(text);
        ans = pos < lines.length && !(pos === lines.length - 1 && lines[pos] === "") ? lines[pos++] : null;
      } else if (w.readLine) ans = await w.readLine(text);
      else {
        emit(text);
        ans = null;
      }
      return ans !== null && /^[yY]/.test(ans);
    },
  };
}

const typeWord = (inf: NodeInfo) => (inf.isLink ? "symbolic link" : inf.isDir ? "directory" : inf.size === 0 ? "regular empty file" : "regular file");

// ---------- rm ----------

type Interactive = "never" | "once" | "always" | "default";

export function rmCommand(w: World): Command {
  return defineCommand("rm", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "fiIrRdv",
      long: { force: "f", recursive: "r", dir: "d", verbose: "v", "one-file-system": "one-file-system", "no-preserve-root": "no-preserve-root", "interactive": "interactive" },
      optValue: ["interactive", "preserve-root"],
    });
    if (p.bad) {
      // как diagnose_leading_hyphen: если в каталоге есть файл, похожий на опцию, подсказываем `rm ./-x`
      let hint = "";
      for (const a of args) {
        if (a === "--") break;
        if (a.startsWith("-") && a.length > 1 && (await w.info(resolve(ctx.cwd, a)))) {
          hint = `Try 'rm ./${a}' to remove the file ${q(a)}.\n`;
          break;
        }
      }
      return fail(invalidOpt("rm", p.bad, hint));
    }
    // режим вопросов — побеждает последний из -f -i -I --interactive
    let mode: Interactive = "default";
    let force = false;
    for (const a of args) {
      if (a === "--") break;
      if (a.startsWith("--")) {
        if (a === "--force") (force = true), (mode = "never");
        else if (a === "--interactive" || a === "--interactive=always" || a === "--interactive=yes") mode = "always";
        else if (a === "--interactive=once") mode = "once";
        else if (a === "--interactive=never" || a === "--interactive=no" || a === "--interactive=none") mode = "never";
        else if (a.startsWith("--interactive=")) return fail(`rm: invalid argument ‘${a.slice(14)}’ for ‘--interactive’\nValid arguments are:\n  - ‘never’, ‘no’, ‘none’\n  - ‘once’\n  - ‘always’, ‘yes’\n${tryHelp("rm")}`);
      } else if (a.startsWith("-") && a.length > 1) {
        for (const c of a.slice(1)) {
          if (c === "f") (force = true), (mode = "never");
          else if (c === "i") mode = "always";
          else if (c === "I") mode = "once";
        }
      }
    }
    const recursive = p.flags.has("r") || p.flags.has("R");
    const dirFlag = p.flags.has("d");
    const verbose = p.flags.has("v");
    const noPreserve = p.flags.has("no-preserve-root");
    const targets = p.rest;
    if (!targets.length) return force ? { stdout: "", stderr: "", exitCode: 0 } : fail(`rm: missing operand\n${tryHelp("rm")}`);

    if (recursive && !noPreserve && w.cur.uid === 0 && targets.length > 3 && targets.every((t) => /^\/[^/]+$/.test(t))) {
      // rm -rf /* — сервер жалко, просто не даём
      return fail("тренажёр: rm -rf /* заблокирован. Палыч упал в обморок, но сервер жив.");
    }

    let out = "";
    let err = "";
    let code = 0;
    const ask = makeAsker(w, ctx.stdin, (s) => (err += s));
    const bad = (msg: string) => {
      err += `rm: ${msg}\n`;
      code = 1;
    };

    if (mode === "once" && (targets.length > 3 || recursive)) {
      const n = targets.length;
      const text = recursive ? `rm: remove ${n} argument${n > 1 ? "s" : ""} recursively? ` : `rm: remove ${n} arguments? `;
      if (!(await ask.yes(text))) return { stdout: "", stderr: err, exitCode: 0 };
    }

    const writable = (inf: NodeInfo) => w.cur.uid === 0 || w.permOn(inf, "w");
    /** Нужно ли спросить: -i всегда; иначе только для защищённых от записи, если ввод с терминала. */
    const needAsk = (inf: NodeInfo) => mode === "always" || (mode !== "never" && !inf.isLink && !writable(inf) && ask.tty);
    const wp = (inf: NodeInfo) => (!inf.isLink && !writable(inf) && ask.tty ? "write-protected " : "");

    const unlink = async (abs: string, shown: string, inf: NodeInfo): Promise<boolean> => {
      try {
        await w.fs.rm(abs);
        if (verbose) out += `removed ${q(shown)}\n`;
        return true;
      } catch (e) {
        bad(`cannot remove ${q(shown)}: ${errnoText(e)}`);
        void inf;
        return false;
      }
    };

    const removeFile = async (abs: string, shown: string, inf: NodeInfo): Promise<void> => {
      if (needAsk(inf) && !(await ask.yes(`rm: remove ${wp(inf)}${typeWord(inf)} ${q(shown)}? `))) return;
      await unlink(abs, shown, inf);
    };

    const removeDir = async (abs: string, shown: string, inf: NodeInfo): Promise<void> => {
      const descend = mode === "always" || (mode !== "never" && !writable(inf) && ask.tty);
      if (descend && !(await ask.yes(`rm: descend into ${wp(inf)}directory ${q(shown)}? `))) return;
      let names: string[] = [];
      try {
        if (w.cur.uid !== 0 && !w.permOn(inf, "r")) throw new Error("EACCES");
        names = await w.base.readdir(abs);
      } catch {
        bad(`cannot remove ${q(shown)}: Permission denied`);
        return;
      }
      for (const n of names) {
        const childAbs = abs === "/" ? "/" + n : abs + "/" + n;
        const childShown = shown.replace(/\/+$/, "") + "/" + n;
        const ci = await w.info(childAbs);
        if (!ci) continue;
        if (ci.isDir) await removeDir(childAbs, childShown, ci);
        else await removeFile(childAbs, childShown, ci);
      }
      // каталог: вопрос «remove directory?» (только в -i), затем rmdir
      const cur = (await w.info(abs)) ?? inf;
      if (mode === "always" && !(await ask.yes(`rm: remove ${wp(cur)}directory ${q(shown)}? `))) return;
      if ((await w.base.readdir(abs)).length) {
        bad(`cannot remove ${q(shown)}: Directory not empty`);
        return;
      }
      try {
        await w.fs.rm(abs);
        if (verbose) out += `removed directory ${q(shown)}\n`;
      } catch (e) {
        bad(`cannot remove ${q(shown)}: ${errnoText(e)}`);
      }
    };

    for (const name of targets) {
      const abs = resolve(ctx.cwd, name);
      const last = name.replace(/\/+$/, "").split("/").pop() ?? "";
      if (recursive && (last === "." || last === "..")) {
        err += `rm: refusing to remove '.' or '..' directory: skipping ${q(name)}\n`;
        code = 1;
        continue;
      }
      if (recursive && abs === "/" && !noPreserve) {
        err += "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n";
        code = 1;
        continue;
      }
      if (!(await w.canTraverse(abs))) {
        if (!force || (await w.info(abs))) bad(`cannot remove ${q(name)}: Permission denied`);
        continue;
      }
      const inf = await w.info(abs);
      if (!inf) {
        if (!force) bad(`cannot remove ${q(name)}: No such file or directory`);
        continue;
      }
      if (inf.isDir) {
        // `rm l/` (слэш у ссылки на каталог) — это каталог, а не ссылка
        if (!recursive && !dirFlag) {
          bad(`cannot remove ${q(name)}: Is a directory`);
          continue;
        }
        if (!recursive) {
          // -d: только пустой каталог
          if (needAsk(inf) && !(await ask.yes(`rm: remove ${wp(inf)}directory ${q(name)}? `))) continue;
          if ((await w.base.readdir(abs)).length) {
            bad(`cannot remove ${q(name)}: Directory not empty`);
            continue;
          }
          try {
            await w.fs.rm(abs);
            if (verbose) out += `removed directory ${q(name)}\n`;
          } catch (e) {
            bad(`cannot remove ${q(name)}: ${errnoText(e)}`);
          }
          continue;
        }
        await removeDir(abs, name, inf);
        continue;
      }
      if (name.endsWith("/")) {
        // `rm l/` для ссылки на каталог: rmdir-семантика
        const target = inf.isLink ? await w.info(abs, true) : null;
        bad(`cannot remove ${q(name)}: ${target?.isDir && !recursive ? "Is a directory" : "Not a directory"}`);
        continue;
      }
      await removeFile(abs, name, inf);
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

// ---------- общее для cp и mv ----------

/** Резервная копия: simple (`b~`), numbered (`b.~1~`), existing, none. */
async function makeBackup(w: World, dest: string, control: string, suffix: string): Promise<string | null> {
  if (control === "none") return null;
  let target = dest + suffix;
  let numbered = control === "numbered";
  if (control === "existing") {
    const names = await w.base.readdir(dirname(dest));
    numbered = names.some((n) => n.startsWith(basename(dest) + ".~") && n.endsWith("~"));
  }
  if (numbered) {
    const names = await w.base.readdir(dirname(dest));
    let max = 0;
    for (const n of names) {
      const m = new RegExp(`^${basename(dest).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.~(\\d+)~$`).exec(n);
      if (m) max = Math.max(max, Number(m[1]));
    }
    target = `${dest}.~${max + 1}~`;
  }
  await w.fs.mv(dest, target);
  return target;
}

const BACKUP_CONTROLS: Record<string, string> = { none: "none", off: "none", numbered: "numbered", t: "numbered", existing: "existing", nil: "existing", simple: "simple", never: "simple" };

/** Разбор опций резервных копий, общих для cp и mv. */
function backupOpts(p: { flags: Set<string>; values: Map<string, string> }, cmd: string): { control: string; suffix: string } | { error: string } {
  const suffix = p.values.get("S") ?? "~";
  let control = "";
  if (p.flags.has("b") || p.flags.has("backup")) control = "existing";
  const v = p.values.get("backup");
  if (v !== undefined) {
    control = BACKUP_CONTROLS[v] ?? "";
    if (!control)
      return { error: `${cmd}: invalid argument ‘${v}’ for ‘backup type’\nValid arguments are:\n  - ‘none’, ‘off’\n  - ‘simple’, ‘never’\n  - ‘existing’, ‘nil’\n  - ‘numbered’, ‘t’\n${tryHelp(cmd)}` };
  }
  return { control, suffix };
}

/** Куда копировать/переносить: общий разбор операндов (-t, -T, последний операнд — каталог или файл). */
async function planTargets(
  w: World,
  cmd: string,
  cwd: string,
  p: { flags: Set<string>; values: Map<string, string>; rest: string[] },
): Promise<{ error: string } | { pairs: { src: string; dest: string; destShown: string }[]; destDir: string | null }> {
  const tdir = p.values.get("t") ?? p.values.get("target-directory");
  const T = p.flags.has("T");
  const ops = [...p.rest];
  let sources: string[];
  let destArg: string;
  let intoDir: boolean;
  if (tdir !== undefined) {
    if (T) return { error: `${cmd}: cannot combine --target-directory (-t) and --no-target-directory (-T)` };
    if (!ops.length) return { error: `${cmd}: missing file operand\n${tryHelp(cmd)}` };
    const inf = await w.info(resolve(cwd, tdir), true);
    if (!inf) return { error: cmd === "cp" ? `cp: failed to access ${q(tdir)}: No such file or directory` : `${cmd}: target directory ${q(tdir)}: No such file or directory` };
    if (!inf.isDir) return { error: `${cmd}: target ${q(tdir)} is not a directory` };
    sources = ops;
    destArg = tdir;
    intoDir = true;
  } else {
    if (!ops.length) return { error: `${cmd}: missing file operand\n${tryHelp(cmd)}` };
    if (ops.length === 1) return { error: `${cmd}: missing destination file operand after ${q(ops[0])}\n${tryHelp(cmd)}` };
    destArg = ops[ops.length - 1];
    sources = ops.slice(0, -1);
    if (T) {
      if (ops.length > 2) return { error: `${cmd}: extra operand ${q(ops[2])}\n${tryHelp(cmd)}` };
      intoDir = false;
    } else {
      const inf = await w.info(resolve(cwd, destArg), true);
      intoDir = !!inf?.isDir;
      if (!intoDir && sources.length > 1) return { error: `${cmd}: target ${q(destArg)} is not a directory` };
    }
  }
  const parents = p.flags.has("parents");
  if (parents && !intoDir) return { error: `cp: with --parents, the destination must be a directory\n${tryHelp("cp")}` };
  const pairs = sources.map((src) => {
    // имя берётся лексически (cp -r d/. e копирует содержимое, имя «.»), без разбора симлинков и «..»
    const nameIn = parents ? src.replace(/^\/+/, "") : (src.replace(/\/+$/, "").split("/").pop() || "/");
    const shown = intoDir ? destArg.replace(/\/+$/, "") + "/" + nameIn : destArg;
    return { src, dest: resolve(cwd, shown), destShown: intoDir && destArg === "/" ? "/" + nameIn : shown };
  });
  return { pairs, destDir: intoDir ? resolve(cwd, destArg) : null };
}

// ---------- cp ----------

const PRESERVE_ALL = ["mode", "ownership", "timestamps", "links", "context", "xattr"];

export function cpCommand(w: World): Command {
  return defineCommand("cp", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "adfHiLlnPpRrsSTtuvxbZ",
      withValue: ["t", "S", "target-directory", "suffix"],
      long: {
        archive: "a", force: "f", interactive: "i", link: "l", "no-clobber": "n", "no-dereference": "P", recursive: "r", symbolic: "s",
        "no-target-directory": "T", "target-directory": "t", update: "u", verbose: "v", "one-file-system": "x", dereference: "L",
        suffix: "S", "dereference-command-line-symlinks": "H", "attributes-only": "attributes-only", parents: "parents", "remove-destination": "remove-destination",
      },
      optValue: ["preserve", "no-preserve", "backup", "reflink", "sparse"],
    });
    if (p.bad) return fail(invalidOpt("cp", p.bad));
    const f = p.flags;
    // -S SUFFIX и -t DIR у нас короткие с аргументом; -Z (SELinux-контекст) не поддерживаем
    if (f.has("Z")) return fail(invalidOpt("cp", "Z"));
    const bo = backupOpts(p, "cp");
    if ("error" in bo) return fail(bo.error);
    if (f.has("S") && !bo.control) bo.control = "simple";
    if (f.has("S")) bo.suffix = p.values.get("S") ?? bo.suffix;

    // --preserve / --no-preserve
    const preserve = new Set<string>();
    const addList = (list: string, on: boolean): string | null => {
      for (const item of list.split(",")) {
        const names = item === "all" ? PRESERVE_ALL : [item];
        for (const n of names) {
          if (!PRESERVE_ALL.includes(n)) return item;
          if (on) preserve.add(n);
          else preserve.delete(n);
        }
      }
      return null;
    };
    const badPreserve = (item: string, which: string) =>
      fail(`cp: invalid argument ‘${item}’ for ‘--${which}’\nValid arguments are:\n  - ‘mode’\n  - ‘timestamps’\n  - ‘ownership’\n  - ‘links’\n  - ‘context’\n  - ‘xattr’\n  - ‘all’\n${tryHelp("cp")}`);
    const archive = f.has("a");
    if (archive) PRESERVE_ALL.filter((x) => x !== "context").forEach((x) => preserve.add(x));
    if (f.has("p")) ["mode", "ownership", "timestamps"].forEach((x) => preserve.add(x));
    if (f.has("d")) preserve.add("links");
    if (f.has("preserve")) {
      const v = p.values.get("preserve");
      const bad = addList(v ?? "mode,ownership,timestamps", true);
      if (bad) return badPreserve(bad, "preserve");
    }
    if (f.has("no-preserve")) {
      const bad = addList(p.values.get("no-preserve") ?? "", false);
      if (bad) return badPreserve(bad, "no-preserve");
    }
    const recursive = f.has("r") || f.has("R") || archive;
    const noDeref = f.has("P") || archive || f.has("d");
    const derefAll = f.has("L");
    const derefCmd = f.has("H");
    const deref = (cmdline: boolean) => (derefAll ? true : noDeref ? false : derefCmd ? cmdline : !recursive);
    const verbose = f.has("v");
    const force = f.has("f");
    const interactive = f.has("i");
    const noClobber = f.has("n");
    const update = f.has("u");
    const attrOnly = f.has("attributes-only");
    const removeDest = f.has("remove-destination");

    const plan = await planTargets(w, "cp", ctx.cwd, p);
    if ("error" in plan) return fail(plan.error);

    let out = "";
    let err = "";
    let code = 0;
    const bad = (msg: string) => {
      err += `cp: ${msg}\n`;
      code = 1;
    };
    const ask = makeAsker(w, ctx.stdin, (s) => (err += s));
    const me = w.cur;
    const linkedDest = new Map<number, string>();

    const applyAttrs = async (srcInf: NodeInfo, destAbs: string, destShown: string, created: boolean) => {
      if (preserve.has("ownership")) {
        const gids = w.gidsOf(me);
        if (me.uid === 0) w.setOwner(destAbs, srcInf.uid, srcInf.gid);
        else if (gids.has(srcInf.gid)) w.setOwner(destAbs, (await w.info(destAbs))!.uid, srcInf.gid);
      }
      if (preserve.has("mode")) await w.setMode(destAbs, srcInf.mode);
      else if (created) await w.setMode(destAbs, srcInf.mode & ~w.umask & 0o777);
      if (preserve.has("timestamps")) await w.setTimes(destAbs, { atime: srcInf.atime, mtime: srcInf.mtime });
      void destShown;
    };

    const copyEntry = async (srcAbs: string, srcShown: string, destAbs: string, destShown: string, cmdline: boolean): Promise<void> => {
      if (!(await w.canTraverse(srcAbs))) return bad(`cannot stat ${q(srcShown)}: Permission denied`);
      let sinf = await w.info(srcAbs);
      if (!sinf) return bad(`cannot stat ${q(srcShown)}: No such file or directory`);
      const asLink = sinf.isLink && !deref(cmdline);
      if (sinf.isLink && !asLink) {
        const target = await w.info(srcAbs, true);
        if (!target) return bad(`cannot stat ${q(srcShown)}: No such file or directory`);
        sinf = target;
      }
      let dinf = await w.info(destAbs);

      if (sinf.isDir && !asLink) {
        if (!recursive) {
          err += `cp: -r not specified; omitting directory ${q(srcShown)}\n`;
          code = 1;
          return;
        }
        const realSrc = await w.resolveFinal(srcAbs);
        if (normalize(destAbs) === realSrc || (destAbs + "/").startsWith(realSrc + "/")) {
          return bad(`cannot copy a directory, ${q(srcShown)}, into itself, ${q(destShown)}`);
        }
        if (dinf && dinf.isLink) dinf = await w.info(destAbs, true);
        if (dinf && !dinf.isDir) return bad(`cannot overwrite non-directory ${q(destShown)} with directory ${q(srcShown)}`);
        const created = !dinf;
        if (created) {
          try {
            if (!(await w.exists(dirname(destAbs)))) throw new Error("ENOENT");
            await w.fs.mkdir(destAbs);
          } catch (e) {
            return bad(`cannot create directory ${q(destShown)}: ${errnoText(e)}`);
          }
        }
        if (verbose) out += `${q(srcShown)} -> ${q(destShown)}\n`;
        let names: string[] = [];
        try {
          names = await w.fs.readdir(srcAbs);
        } catch (e) {
          bad(`cannot access ${q(srcShown)}: ${errnoText(e)}`);
        }
        for (const n of names) {
          await copyEntry(srcAbs === "/" ? "/" + n : srcAbs + "/" + n, srcShown.replace(/\/+$/, "") + "/" + n, destAbs + "/" + n, destShown.replace(/\/+$/, "") + "/" + n, false);
        }
        await applyAttrs(sinf, destAbs, destShown, created);
        return;
      }

      // --- не каталог ---
      if (dinf && dinf.isDir && !(dinf.isLink && !(await w.info(destAbs, true))?.isDir)) {
        return bad(`cannot overwrite directory ${q(destShown)} with non-directory`);
      }
      if (dinf) {
        // сравниваем то, во что упираются оба имени (cp a l, где l -> a, — тот же файл)
        const srcReal = asLink ? sinf.path : await w.resolveFinal(srcAbs);
        const destReal = asLink ? dinf.path : await w.resolveFinal(destAbs);
        const sameFile = w.inodes.sameFile(srcReal, destReal);
        if (sameFile && !(bo.control && bo.control !== "none")) return bad(`${q(srcShown)} and ${q(destShown)} are the same file`);
        if (noClobber) return;
        if (update && !asLink && dinf.mtime.getTime() >= sinf.mtime.getTime()) return;
        if (interactive && !(await ask.yes(`cp: overwrite ${q(destShown)}? `))) return;
      }
      let backedUp = "";
      if (dinf && bo.control && bo.control !== "none") {
        const b = await makeBackup(w, destAbs, bo.control, bo.suffix);
        if (b) backedUp = b;
        dinf = null;
      } else if (dinf && removeDest) {
        await w.fs.rm(destAbs);
        dinf = null;
      }
      const shownLine = () => {
        if (verbose) out += `${q(srcShown)} -> ${q(destShown)}${backedUp ? ` (backup: ${q(destShown + backedUp.slice(destAbs.length))})` : ""}\n`;
      };

      // жёсткая/символическая ссылка вместо копии
      if (f.has("l") || f.has("s")) {
        if (dinf) {
          if (!force) return bad(`cannot create ${f.has("s") ? "symbolic" : "hard"} link ${q(destShown)}: File exists`);
          await w.fs.rm(destAbs);
        }
        try {
          if (f.has("s")) {
            if (!srcShown.startsWith("/") && dirname(destAbs) !== normalize(ctx.cwd)) return bad(`cannot create symbolic link ${q(destShown)}: can make relative symbolic links only in current directory`);
            await w.fs.symlink(srcShown, destAbs);
          } else await w.fs.link(srcAbs, destAbs);
        } catch (e) {
          return bad(`cannot create ${f.has("s") ? "symbolic" : "hard"} link ${q(destShown)}: ${errnoText(e)}`);
        }
        return shownLine();
      }

      if (asLink) {
        if (dinf) {
          if (!force && !removeDest) return bad(`cannot create symbolic link ${q(destShown)}: File exists`);
          await w.fs.rm(destAbs);
        }
        try {
          await w.fs.symlink(await w.base.readlink(srcAbs), destAbs);
        } catch (e) {
          return bad(`cannot create symbolic link ${q(destShown)}: ${errnoText(e)}`);
        }
        return shownLine();
      }

      // сохранение жёстких ссылок внутри копируемого дерева (-a, --preserve=links)
      if (preserve.has("links") && w.inodes.count(sinf.path) > 1) {
        const first = linkedDest.get(w.inodes.ino(sinf.path));
        if (first && !dinf) {
          try {
            await w.fs.link(first, destAbs);
            return shownLine();
          } catch {
            /* упадём в обычное копирование */
          }
        }
      }

      if (!(await w.canAccess(srcAbs, "r")) && me.uid !== 0) return bad(`cannot open ${q(srcShown)} for reading: Permission denied`);
      // запись «насквозь» через симлинк назначения
      let writeTo = destAbs;
      if (dinf?.isLink) {
        const t = await w.resolveFinal(destAbs);
        if (!(await w.exists(t))) return bad(`not writing through dangling symlink ${q(destShown)}`);
        writeTo = t;
      }
      const created = !(await w.exists(writeTo));
      if (created && !(await w.exists(dirname(writeTo)))) return bad(`cannot create regular file ${q(destShown)}: No such file or directory`);
      try {
        let data: Uint8Array | string = "";
        if (!attrOnly) data = await w.fs.readFileBuffer(srcAbs);
        try {
          await w.fs.writeFile(writeTo, data);
        } catch (e) {
          if (force && !created && /^EACCES|^EPERM/.test(e instanceof Error ? e.message : "")) {
            await w.fs.rm(writeTo);
            await w.fs.writeFile(writeTo, data);
          } else throw e;
        }
      } catch (e) {
        return bad(`cannot create regular file ${q(destShown)}: ${errnoText(e)}`);
      }
      if (created || preserve.size) await applyAttrs(sinf, writeTo, destShown, created);
      if (preserve.has("links")) linkedDest.set(w.inodes.ino(sinf.path), writeTo);
      shownLine();
    };

    for (const pair of plan.pairs) {
      const src = pair.src;
      if (f.has("parents") && !(await w.exists(dirname(pair.dest)))) {
        try {
          await w.fs.mkdir(dirname(pair.dest), { recursive: true });
        } catch (e) {
          bad(`cannot create directory ${q(dirname(pair.destShown))}: ${errnoText(e)}`);
          continue;
        }
      }
      await copyEntry(resolve(ctx.cwd, src), src, pair.dest, pair.destShown, true);
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

// ---------- mv ----------

export function mvCommand(w: World): Command {
  return defineCommand("mv", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "finuvTtbS",
      withValue: ["t", "S", "target-directory", "suffix"],
      long: { force: "f", interactive: "i", "no-clobber": "n", update: "u", verbose: "v", "no-target-directory": "T", "target-directory": "t", suffix: "S" },
      optValue: ["backup"],
    });
    if (p.bad) return fail(invalidOpt("mv", p.bad));
    const f = p.flags;
    const bo = backupOpts(p, "mv");
    if ("error" in bo) return fail(bo.error);
    if (f.has("S") && !bo.control) bo.control = "simple";
    if (f.has("S")) bo.suffix = p.values.get("S") ?? bo.suffix;
    // режим вопросов: последний из -f -i -n
    let mode: "force" | "interactive" | "noclobber" | "default" = "default";
    for (const a of args) {
      if (a === "--") break;
      if (a === "--force") mode = "force";
      else if (a === "--interactive") mode = "interactive";
      else if (a === "--no-clobber") mode = "noclobber";
      else if (a.startsWith("-") && !a.startsWith("--")) for (const c of a.slice(1)) mode = c === "f" ? "force" : c === "i" ? "interactive" : c === "n" ? "noclobber" : mode;
    }
    const verbose = f.has("v");
    const update = f.has("u");

    const plan = await planTargets(w, "mv", ctx.cwd, p);
    if ("error" in plan) return fail(plan.error);

    let out = "";
    let err = "";
    let code = 0;
    const bad = (msg: string) => {
      err += `mv: ${msg}\n`;
      code = 1;
    };
    const ask = makeAsker(w, ctx.stdin, (s) => (err += s));
    const me = w.cur;

    for (const { src, dest, destShown } of plan.pairs) {
      const srcAbs = resolve(ctx.cwd, src);
      if (!(await w.canTraverse(srcAbs))) {
        bad(`cannot stat ${q(src)}: Permission denied`);
        continue;
      }
      const sinf = await w.info(srcAbs);
      if (!sinf) {
        bad(`cannot stat ${q(src)}: No such file or directory`);
        continue;
      }
      let dinf = await w.info(dest);
      if (dinf && w.inodes.sameFile(sinf.path, dinf.path) && sinf.isLink === dinf.isLink && !(bo.control && bo.control !== "none")) {
        bad(`${q(src)} and ${q(destShown)} are the same file`);
        continue;
      }
      if (sinf.isDir && (dest + "/").startsWith(srcAbs + "/")) {
        bad(`cannot move ${q(src)} to a subdirectory of itself, ${q(destShown)}`);
        continue;
      }
      if (!(await w.exists(dirname(dest)))) {
        bad(`cannot move ${q(src)} to ${q(destShown)}: No such file or directory`);
        continue;
      }
      let backedUp = "";
      if (dinf) {
        const dTarget = dinf.isLink ? await w.info(dest, true) : dinf;
        if (sinf.isDir && dTarget && !dTarget.isDir) {
          bad(`cannot overwrite non-directory ${q(destShown)} with directory ${q(src)}`);
          continue;
        }
        if (!sinf.isDir && dTarget?.isDir) {
          bad(`cannot overwrite directory ${q(destShown)} with non-directory`);
          continue;
        }
        if (mode === "noclobber") continue;
        if (update && dinf.mtime.getTime() >= sinf.mtime.getTime()) continue;
        if (mode === "interactive" && !(await ask.yes(`mv: overwrite ${q(destShown)}? `))) continue;
        if (mode === "default" && ask.tty && me.uid !== 0 && !dinf.isLink && !w.permOn(dinf, "w")) {
          const perm = (dinf.mode & 0o777).toString(8).padStart(4, "0");
          if (!(await ask.yes(`mv: replace ${q(destShown)}, overriding mode ${perm} (${modeString(dinf).slice(1)})? `))) continue;
        }
        if (bo.control && bo.control !== "none") {
          const b = await makeBackup(w, dest, bo.control, bo.suffix);
          if (b) backedUp = b;
        } else {
          try {
            await w.fs.rm(dest, { recursive: true });
          } catch (e) {
            bad(`cannot move ${q(src)} to ${q(destShown)}: ${errnoText(e)}`);
            continue;
          }
        }
        dinf = null;
      }
      try {
        await w.fs.mv(srcAbs, dest);
      } catch (e) {
        bad(`cannot move ${q(src)} to ${q(destShown)}: ${errnoText(e)}`);
        continue;
      }
      if (verbose) out += `renamed ${q(src)} -> ${q(destShown)}${backedUp ? ` (backup: ${q(destShown + backedUp.slice(dest.length))})` : ""}\n`;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}
