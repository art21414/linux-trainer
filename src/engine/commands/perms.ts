// chmod, chown, chgrp, umask
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { resolve } from "../path";
import { fail, parseArgs } from "../util";

/** Вычислить новый режим по спецификации chmod. null — неверная запись. */
export function applyMode(spec: string, cur: number, isDir: boolean, umask: number): number | null {
  if (/^[0-7]{1,5}$/.test(spec)) {
    let v = parseInt(spec, 8) & 0o7777;
    // GNU: короткая восьмеричная запись не снимает setuid/setgid у каталогов
    // (снять их можно только 5-значной записью, например 00755)
    if (isDir && spec.length < 5) v |= cur & 0o6000;
    return v;
  }
  let m = cur;
  for (const clause of spec.split(",")) {
    const mm = /^([ugoa]*)((?:[-+=][rwxXstugo]*)+)$/.exec(clause);
    if (!mm) return null;
    const who = mm[1];
    let whoMask = 0;
    if (!who || who.includes("a")) whoMask = 0o7777;
    else {
      if (who.includes("u")) whoMask |= 0o4700;
      if (who.includes("g")) whoMask |= 0o2070;
      if (who.includes("o")) whoMask |= 0o1007;
    }
    const filter = who ? 0o7777 : ~umask & 0o7777;
    for (const [, op, perms] of mm[2].matchAll(/([-+=])([rwxXstugo]*)/g)) {
      let bits = 0;
      for (const c of perms) {
        if (c === "r") bits |= 0o444;
        else if (c === "w") bits |= 0o222;
        else if (c === "x") bits |= 0o111;
        else if (c === "X") bits |= isDir || m & 0o111 ? 0o111 : 0;
        else if (c === "s") bits |= 0o6000;
        else if (c === "t") bits |= 0o1000;
        else {
          const shift = c === "u" ? 6 : c === "g" ? 3 : 0;
          const r = (m >> shift) & 7;
          bits |= r | (r << 3) | (r << 6);
        }
      }
      const eff = bits & whoMask & (op === "=" ? 0o7777 : filter);
      if (op === "+") m |= eff;
      else if (op === "-") m &= ~eff;
      else {
        let clear = whoMask & 0o777;
        if (!isDir) clear |= whoMask & 0o7000;
        m = (m & ~clear) | eff;
      }
    }
  }
  return m & 0o7777;
}

export function chmodCommand(w: World): Command {
  return defineCommand("chmod", async (args, ctx) => {
    // режим вида -w / -x тоже допустим — отделяем его от опций
    const opts: string[] = [];
    const rest: string[] = [];
    for (const a of args) {
      if (/^-[rwxXst]+$/.test(a) && !/^-[Rvcf]+$/.test(a)) rest.push(a);
      else if (a.startsWith("-") && a.length > 1) opts.push(a);
      else rest.push(a);
    }
    const p = parseArgs(opts, { short: "Rvcf", long: { recursive: "R", verbose: "v", changes: "c", silent: "f", quiet: "f" } });
    if (p.bad) return fail(`chmod: invalid option -- '${p.bad.replace(/^-+/, "")}'\nTry 'chmod --help' for more information.`);
    if (rest.length === 0) return fail("chmod: missing operand\nTry 'chmod --help' for more information.");
    const [spec, ...files] = rest;
    if (!files.length) return fail(`chmod: missing operand after ‘${spec}’\nTry 'chmod --help' for more information.`);
    if (applyMode(spec, 0o644, false, w.umask) === null) return fail(`chmod: invalid mode: ‘${spec}’\nTry 'chmod --help' for more information.`);
    let out = "";
    let err = "";
    let code = 0;
    for (const f of files) {
      const abs = resolve(ctx.cwd, f);
      if (!(await w.canTraverse(abs)) || !(await w.info(abs, true))) {
        const inf = await w.info(abs, true);
        err += `chmod: cannot access '${f}': ${inf ? "Permission denied" : "No such file or directory"}\n`;
        code = 1;
        continue;
      }
      const paths = p.flags.has("R") ? w.subtree(abs) : [abs];
      for (const path of paths) {
        const inf = (await w.info(path, true))!;
        const shown = path === abs ? f : f.replace(/\/$/, "") + path.slice(abs.length);
        if (w.cur.uid !== 0 && w.cur.uid !== inf.uid) {
          err += `chmod: changing permissions of '${shown}': Operation not permitted\n`;
          code = 1;
          continue;
        }
        const next = applyMode(spec, inf.mode, inf.isDir, w.umask)!;
        await w.setMode(path, next);
        if (p.flags.has("v") || (p.flags.has("c") && next !== inf.mode)) {
          const o = inf.mode.toString(8).padStart(4, "0");
          const n = next.toString(8).padStart(4, "0");
          out += next === inf.mode ? `mode of '${shown}' retained as ${o}\n` : `mode of '${shown}' changed from ${o} to ${n}\n`;
        }
      }
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

function lookupUser(w: World, s: string) {
  return w.user(s) ?? (/^\d+$/.test(s) ? { uid: Number(s), gid: Number(s), name: s } : undefined);
}
function lookupGroup(w: World, s: string) {
  return w.group(s) ?? (/^\d+$/.test(s) ? { gid: Number(s), name: s } : undefined);
}

function makeOwnerCommand(w: World, name: "chown" | "chgrp"): Command {
  return defineCommand(name, async (args, ctx) => {
    const p = parseArgs(args, { short: "RvcfhH", long: { recursive: "R", verbose: "v", changes: "c" } });
    if (p.bad) return fail(`${name}: invalid option -- '${p.bad.replace(/^-+/, "")}'\nTry '${name} --help' for more information.`);
    if (p.rest.length === 0) return fail(`${name}: missing operand\nTry '${name} --help' for more information.`);
    const [spec, ...files] = p.rest;
    if (!files.length) return fail(`${name}: missing operand after ‘${spec}’\nTry '${name} --help' for more information.`);

    let uid: number | undefined;
    let gid: number | undefined;
    if (name === "chgrp") {
      const g = lookupGroup(w, spec);
      if (!g) return fail(`chgrp: invalid group: ‘${spec}’`);
      gid = g.gid;
    } else {
      const m = /^([^:.]*)(?:([:.])(.*))?$/.exec(spec)!;
      const [, us, sep, gs] = m;
      if (us) {
        const u = lookupUser(w, us);
        if (!u) return fail(`chown: invalid user: ‘${spec}’`);
        uid = u.uid;
        if (sep && gs === "") gid = u.gid; // «user:» — основная группа пользователя
      }
      if (gs) {
        const g = lookupGroup(w, gs);
        if (!g) return fail(`chown: invalid group: ‘${spec}’`);
        gid = g.gid;
      }
      if (uid === undefined && gid === undefined && !sep) return fail(`chown: invalid user: ‘${spec}’`);
    }

    let out = "";
    let err = "";
    let code = 0;
    const me = w.cur;
    for (const f of files) {
      const abs = resolve(ctx.cwd, f);
      const top = await w.info(abs);
      if (!top || !(await w.canTraverse(abs))) {
        err += `${name}: cannot access '${f}': ${top ? "Permission denied" : "No such file or directory"}\n`;
        code = 1;
        continue;
      }
      const paths = p.flags.has("R") ? w.subtree(abs) : [abs];
      for (const path of paths) {
        const inf = (await w.info(path))!;
        const shown = path === abs ? f : f.replace(/\/$/, "") + path.slice(abs.length);
        const nu = uid ?? inf.uid;
        const ng = gid ?? inf.gid;
        let allowed = me.uid === 0;
        // обычный пользователь может только сменить группу своего файла на свою группу
        if (!allowed && nu === inf.uid && me.uid === inf.uid && w.gidsOf(me).has(ng)) allowed = true;
        if (!allowed) {
          err += `${name}: changing ${name === "chgrp" ? "group" : "ownership"} of '${shown}': Operation not permitted\n`;
          code = 1;
          continue;
        }
        w.setOwner(path, nu, ng);
        // смена владельца обычным файлом снимает setuid/setgid (как в Linux)
        if (!inf.isDir && (nu !== inf.uid || ng !== inf.gid) && inf.mode & 0o6000 && me.uid !== 0) await w.setMode(path, inf.mode & ~0o6000);
        if (p.flags.has("v") || (p.flags.has("c") && (nu !== inf.uid || ng !== inf.gid))) {
          const un = (id: number) => w.userByUid(id)?.name ?? String(id);
          const gn = (id: number) => w.groupByGid(id)?.name ?? String(id);
          out +=
            nu === inf.uid && ng === inf.gid
              ? `ownership of '${shown}' retained as ${un(nu)}:${gn(ng)}\n`
              : `changed ownership of '${shown}' from ${un(inf.uid)}:${gn(inf.gid)} to ${un(nu)}:${gn(ng)}\n`;
        }
      }
    }
    return { stdout: out, stderr: err, exitCode: code };
  });
}

export const chownCommand = (w: World) => makeOwnerCommand(w, "chown");
export const chgrpCommand = (w: World) => makeOwnerCommand(w, "chgrp");

export function umaskCommand(w: World): Command {
  return defineCommand("umask", async (args) => {
    const p = parseArgs(args, { short: "Sp" });
    const sym = (m: number) => {
      const allowed = ~m & 0o777;
      const tri = (s: number) => ((allowed >> s) & 4 ? "r" : "") + ((allowed >> s) & 2 ? "w" : "") + ((allowed >> s) & 1 ? "x" : "");
      return `u=${tri(6)},g=${tri(3)},o=${tri(0)}`;
    };
    if (!p.rest.length) {
      return { stdout: (p.flags.has("S") ? sym(w.umask) : w.umask.toString(8).padStart(4, "0")) + "\n", stderr: "", exitCode: 0 };
    }
    const v = p.rest[0];
    if (/^[0-7]{1,4}$/.test(v)) {
      w.umask = parseInt(v, 8) & 0o777;
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (/^\d+$/.test(v)) return fail(`bash: umask: ${v}: octal number out of range`);
    // символьная запись: то, что разрешено
    const allowed = applyMode(v, ~w.umask & 0o777, true, 0);
    if (allowed === null) return fail(`bash: umask: \`${v[0]}': invalid symbolic mode operator`);
    w.umask = ~allowed & 0o777;
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}
