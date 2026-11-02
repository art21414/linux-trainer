// ln, readlink, realpath, unlink — жёсткие и символические ссылки.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { basename, dirname, normalize, resolve } from "../path";
import { fail, parseArgs } from "../util";

const tryHelp = (cmd: string) => `Try '${cmd} --help' for more information.`;

function badOption(cmd: string, bad: string): string {
  return bad.startsWith("--") ? `${cmd}: unrecognized option '${bad}'\n${tryHelp(cmd)}` : `${cmd}: invalid option -- '${bad}'\n${tryHelp(cmd)}`;
}

/** Каноническая форма пути с разбором симлинков. mode: f — последний компонент может не существовать, e — все существуют, m — любые. */
export async function canonicalize(w: World, cwd: string, path: string, mode: "f" | "e" | "m"): Promise<{ path: string; err?: string }> {
  let rest = (path.startsWith("/") ? path : `${cwd}/${path}`).split("/").filter((x) => x && x !== ".");
  let cur: string[] = [];
  let hops = 0;
  while (rest.length) {
    const comp = rest.shift()!;
    if (comp === "..") {
      cur.pop();
      continue;
    }
    const cand = "/" + [...cur, comp].join("/");
    const inf = await w.info(cand);
    if (!inf) {
      const last = rest.length === 0;
      if (mode === "m" || (mode === "f" && last)) {
        cur.push(comp);
        continue;
      }
      return { path: cand, err: "No such file or directory" };
    }
    if (inf.isLink) {
      if (++hops > 40) return { path: cand, err: "Too many levels of symbolic links" };
      const t = await w.base.readlink(cand);
      rest = t.split("/").filter((x) => x && x !== ".").concat(rest);
      if (t.startsWith("/")) cur = [];
      continue;
    }
    if (!inf.isDir && rest.length) {
      if (mode === "m") {
        cur.push(comp);
        continue;
      }
      return { path: cand, err: "Not a directory" };
    }
    cur.push(comp);
  }
  return { path: "/" + cur.join("/") };
}

/** Относительный путь from → to (оба абсолютные). */
export function relativePath(from: string, to: string): string {
  const a = normalize(from).split("/").filter(Boolean);
  const b = normalize(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const parts = [...a.slice(i).map(() => ".."), ...b.slice(i)];
  return parts.length ? parts.join("/") : ".";
}

const errText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e);
  if (m.startsWith("EACCES")) return "Permission denied";
  if (m.startsWith("EPERM")) return "Operation not permitted";
  if (m.startsWith("ENOENT")) return "No such file or directory";
  if (m.startsWith("EEXIST")) return "File exists";
  if (m.startsWith("EISDIR")) return "Is a directory";
  if (m.startsWith("ENOTDIR")) return "Not a directory";
  return m;
};

export function lnCommand(w: World): Command {
  return defineCommand("ln", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "sfnvTrLPbi",
      withValue: ["t", "target-directory", "S", "suffix"],
      long: {
        symbolic: "s", force: "f", verbose: "v", "no-dereference": "n", relative: "r", logical: "L", physical: "P",
        "no-target-directory": "T", "target-directory": "target-directory", backup: "b", interactive: "i",
      },
    });
    if (p.bad) return fail(badOption("ln", p.bad), 1);
    const f = p.flags;
    const symbolic = f.has("s");
    const tdirOpt = p.values.get("t") ?? p.values.get("target-directory");
    let operands = [...p.rest];
    if (!operands.length) return fail(`ln: missing file operand\n${tryHelp("ln")}`);
    let dirName: string | undefined = tdirOpt;
    let targets: string[];
    if (dirName === undefined) {
      if (operands.length === 1) {
        // ln TARGET — ссылка с тем же именем в текущем каталоге
        targets = operands;
        dirName = ".";
      } else if (f.has("T")) {
        if (operands.length > 2) return fail(`ln: extra operand '${operands[2]}'\n${tryHelp("ln")}`);
        targets = [operands[0]];
      } else {
        const last = operands[operands.length - 1];
        const inf = await w.info(resolve(ctx.cwd, last), !f.has("n") || last.endsWith("/"));
        if (inf?.isDir) {
          dirName = last;
          targets = operands.slice(0, -1);
        } else if (operands.length > 2) {
          return fail(`ln: target '${last}': ${inf ? "Not a directory" : "No such file or directory"}`);
        } else targets = [operands[0]];
      }
    } else {
      const inf = await w.info(resolve(ctx.cwd, dirName), true);
      if (!inf) return fail(`ln: target directory '${dirName}': No such file or directory`);
      if (!inf.isDir) return fail(`ln: target directory '${dirName}': Not a directory`);
      targets = operands;
    }
    if (dirName === undefined) operands = [];

    let out = "";
    let err = "";
    let code = 0;
    for (const t of targets) {
      let name: string;
      if (dirName !== undefined) name = (dirName === "." && operands.length === 1 ? "." : dirName.replace(/\/+$/, "") || "/") + "/" + basename(t.replace(/\/+$/, "") || "/");
      else name = p.rest[p.rest.length - 1];
      if (dirName === "." && operands.length === 1) name = "./" + basename(t);
      const dest = resolve(ctx.cwd, name);
      const src = resolve(ctx.cwd, t);
      const kind = symbolic ? "symbolic" : "hard";
      const label = symbolic ? `failed to create symbolic link '${name}'` : `failed to create hard link '${name}'`;
      try {
        if (!symbolic) {
          let sinf = await w.info(src, f.has("L"));
          if (!(await w.canTraverse(src))) {
            err += `ln: failed to access '${t}': Permission denied\n`;
            code = 1;
            continue;
          }
          if (!sinf) {
            err += `ln: failed to access '${t}': No such file or directory\n`;
            code = 1;
            continue;
          }
          if (sinf.isDir) {
            err += `ln: ${t}: hard link not allowed for directory\n`;
            code = 1;
            continue;
          }
          if (f.has("L") && sinf.isLink) sinf = (await w.info(src, true)) ?? sinf;
        }
        const dinf = await w.info(dest);
        if (dinf) {
          if (!f.has("f")) {
            err += `ln: ${label}: File exists\n`;
            code = 1;
            continue;
          }
          // -f удалил бы единственную ссылку на файл — GNU ln этого не допускает
          if (!symbolic && w.inodes.sameFile(src, dest) && (await w.info(src))?.isLink === dinf.isLink) {
            err += `ln: '${t}' and '${name}' are the same file\n`;
            code = 1;
            continue;
          }
          if (dinf.isDir && !dinf.isLink) {
            err += `ln: ${label}: File exists\n`;
            code = 1;
            continue;
          }
          await w.fs.rm(dest);
        }
        if (!symbolic && w.cur.uid !== 0) {
          // fs.protected_hardlinks=1: чужой файл можно «залинковать» только имея на него r и w
          const sinf = (await w.info(src))!;
          if (sinf.uid !== w.cur.uid && !(w.permOn(sinf, "r") && w.permOn(sinf, "w"))) {
            err += `ln: ${label} => '${t}': Operation not permitted\n`;
            code = 1;
            continue;
          }
        }
        if (!(await w.exists(dirname(dest)))) {
          err += `ln: ${label}: No such file or directory\n`;
          code = 1;
          continue;
        }
        if (symbolic) {
          const target = f.has("r") ? relativePath(dirname(dest), src) : t;
          await w.fs.symlink(target, dest);
          if (f.has("v")) out += `'${name}' -> '${target}'\n`;
        } else {
          await w.fs.link(src, dest);
          if (f.has("v")) out += `'${name}' => '${t}'\n`;
        }
        void kind;
      } catch (e) {
        const msg = errText(e);
        err += symbolic ? `ln: ${label}: ${msg}\n` : `ln: ${label} => '${t}': ${msg}\n`;
        code = 1;
      }
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

export function readlinkCommand(w: World): Command {
  return defineCommand("readlink", async (args, ctx) => {
    const p = parseArgs(args, { short: "femnqsvz", long: { canonicalize: "f", "canonicalize-existing": "e", "canonicalize-missing": "m", "no-newline": "n", quiet: "q", silent: "s", verbose: "v", zero: "z" } });
    if (p.bad) return fail(badOption("readlink", p.bad), 1);
    if (!p.rest.length) return fail(`readlink: missing operand\n${tryHelp("readlink")}`);
    const f = p.flags;
    const canon = f.has("f") ? "f" : f.has("e") ? "e" : f.has("m") ? "m" : null;
    const nl = f.has("n") && p.rest.length === 1 ? "" : "\n";
    let out = "";
    let err = "";
    let code = 0;
    for (const t of p.rest) {
      const abs = resolve(ctx.cwd, t);
      if (canon) {
        const r = await canonicalize(w, ctx.cwd, t, canon);
        if (r.err) {
          code = 1;
          if (f.has("v")) err += `readlink: ${t}: ${r.err}\n`;
          continue;
        }
        out += r.path + nl;
        continue;
      }
      const inf = await w.info(abs);
      if (!inf || !inf.isLink) {
        code = 1;
        if (f.has("v")) err += `readlink: ${t}: ${inf ? "Invalid argument" : "No such file or directory"}\n`;
        continue;
      }
      out += (await w.base.readlink(abs)) + nl;
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

export function realpathCommand(w: World): Command {
  return defineCommand("realpath", async (args, ctx) => {
    const p = parseArgs(args, {
      short: "emsqLP",
      withValue: ["relative-to", "relative-base"],
      long: { "canonicalize-existing": "e", "canonicalize-missing": "m", strip: "s", "no-symlinks": "s", quiet: "q", logical: "L", physical: "P", "relative-to": "relative-to", "relative-base": "relative-base" },
    });
    if (p.bad) return fail(badOption("realpath", p.bad), 1);
    if (!p.rest.length) return fail(`realpath: missing operand\n${tryHelp("realpath")}`);
    const f = p.flags;
    const mode = f.has("e") ? "e" : f.has("m") ? "m" : "f";
    const relTo = p.values.get("relative-to");
    const relBase = p.values.get("relative-base");
    const relToAbs = relTo !== undefined ? (await canonicalize(w, ctx.cwd, relTo, "m")).path : undefined;
    let out = "";
    let err = "";
    let code = 0;
    for (const t of p.rest) {
      let path: string;
      if (f.has("s")) path = resolve(ctx.cwd, t);
      else {
        const r = await canonicalize(w, ctx.cwd, t, mode);
        if (r.err) {
          if (!f.has("q")) err += `realpath: ${t}: ${r.err}\n`;
          code = 1;
          continue;
        }
        path = r.path;
      }
      if (relToAbs !== undefined) {
        const base = relBase !== undefined ? (await canonicalize(w, ctx.cwd, relBase, "m")).path : relToAbs;
        const inside = path === base || path.startsWith(base === "/" ? "/" : base + "/");
        if (relBase === undefined || inside) path = relativePath(relToAbs, path);
      }
      out += path + "\n";
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

export function unlinkCommand(w: World): Command {
  return defineCommand("unlink", async (args, ctx) => {
    const p = parseArgs(args, { short: "" });
    if (p.bad) return fail(badOption("unlink", p.bad), 1);
    if (!p.rest.length) return fail(`unlink: missing operand\n${tryHelp("unlink")}`);
    if (p.rest.length > 1) return fail(`unlink: extra operand '${p.rest[1]}'\n${tryHelp("unlink")}`);
    const t = p.rest[0];
    const abs = resolve(ctx.cwd, t);
    if (!(await w.canTraverse(abs))) return fail(`unlink: cannot unlink '${t}': Permission denied`);
    const inf = await w.info(abs);
    if (!inf) return fail(`unlink: cannot unlink '${t}': No such file or directory`);
    if (inf.isDir) return fail(`unlink: cannot unlink '${t}': Is a directory`);
    try {
      await w.fs.rm(abs);
    } catch (e) {
      return fail(`unlink: cannot unlink '${t}': ${errText(e)}`);
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

export function linkCommands(w: World): Command[] {
  return [lnCommand(w), readlinkCommand(w), realpathCommand(w), unlinkCommand(w)];
}
