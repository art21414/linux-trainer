// setfacl и getfacl (RHCSA): m/x/b/k/d/R/n/M, --set; маска, default ACL.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { resolve } from "../path";
import { bytesToText, fail } from "../util";
import { extended, formatAcl, parseEntry } from "../acl";
import type { Acl, DefAcl, Entry } from "../acl";

const SETFACL_USAGE = "Usage: setfacl [-bkndRLP] { -m|-M|-x|-X ... } file ...\nTry `setfacl --help' for more information.";

export function aclCommands(w: World): Command[] {
  const lookup = (kind: "user" | "group", name: string) => (kind === "user" ? w.user(name)?.uid : w.group(name)?.gid);

  const setfacl = defineCommand("setfacl", async (args, ctx) => {
    type Op = { op: "m" | "x" | "set"; entries: Entry[] };
    const ops: Op[] = [];
    const files: string[] = [];
    let removeAll = false;
    let removeDefault = false;
    let noMask = false;
    let defaultOpt = false;
    let recursive = false;
    const parseList = (opt: string, text: string, remove: boolean): Entry[] | string => {
      const entries: Entry[] = [];
      let offset = 0;
      for (const spec of text.split(",")) {
        if (!spec.trim()) continue;
        const e = parseEntry(spec.trim(), remove, lookup);
        if ("err" in e) return `setfacl: Option ${opt}: Invalid argument near character ${offset + e.err}`;
        entries.push(e);
        offset += spec.length + 1;
      }
      return entries;
    };
    const need = (i: number): string | undefined => args[i];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      let val: string | undefined;
      const takeVal = (): string | undefined => {
        const m = /^--[a-z-]+=(.*)$/s.exec(a);
        if (m) return m[1];
        if (/^-[a-zA-Z]./.test(a)) return a.slice(2);
        return need(++i);
      };
      if (a === "--") {
        files.push(...args.slice(i + 1));
        break;
      } else if (a === "-m" || a === "--modify" || a.startsWith("--modify=") || /^-m./.test(a)) {
        val = takeVal();
        if (val === undefined) return fail(SETFACL_USAGE, 2);
        const r = parseList("-m", val, false);
        if (typeof r === "string") return fail(r, 2);
        ops.push({ op: "m", entries: r });
      } else if (a === "-x" || a === "--remove" || a.startsWith("--remove=") || /^-x./.test(a)) {
        val = takeVal();
        if (val === undefined) return fail(SETFACL_USAGE, 2);
        const r = parseList("-x", val, true);
        if (typeof r === "string") return fail(r, 2);
        ops.push({ op: "x", entries: r });
      } else if (a === "--set" || a.startsWith("--set=")) {
        val = takeVal();
        if (val === undefined) return fail(SETFACL_USAGE, 2);
        const r = parseList("--set", val, false);
        if (typeof r === "string") return fail(r, 2);
        ops.push({ op: "set", entries: r });
      } else if (a === "-M" || a === "-X" || /^--(modify|remove)-file(=|$)/.test(a) || /^-[MX]./.test(a)) {
        const remove = a.startsWith("-X") || a.startsWith("--remove-file");
        val = takeVal();
        if (val === undefined) return fail(SETFACL_USAGE, 2);
        let text: string | null;
        if (val === "-") text = bytesToText(ctx.stdin);
        else text = await w.read(resolve(ctx.cwd, val));
        if (text === null) return fail(`setfacl: ${val}: No such file or directory`, 1);
        const r = parseList(remove ? "-X" : "-M", text.split("\n").map((l) => l.replace(/#.*$/, "").trim()).filter(Boolean).join(","), remove);
        if (typeof r === "string") return fail(r, 2);
        ops.push({ op: remove ? "x" : "m", entries: r });
      } else if (a === "--remove-all") removeAll = true;
      else if (a === "--remove-default") removeDefault = true;
      else if (a === "--no-mask") noMask = true;
      else if (a === "--default") defaultOpt = true;
      else if (a === "--recursive") recursive = true;
      else if (/^-[bkndRLPv]+$/.test(a)) {
        for (const c of a.slice(1)) {
          if (c === "b") removeAll = true;
          else if (c === "k") removeDefault = true;
          else if (c === "n") noMask = true;
          else if (c === "d") defaultOpt = true;
          else if (c === "R") recursive = true;
        }
      } else if (a.startsWith("-") && a.length > 1) {
        return fail(a.startsWith("--") ? `setfacl: unrecognized option '${a}'\n${SETFACL_USAGE}` : `setfacl: invalid option -- '${a.slice(1)}'\n${SETFACL_USAGE}`, 2);
      } else files.push(a);
    }
    if (!files.length || (!ops.length && !removeAll && !removeDefault)) return fail(SETFACL_USAGE, 2);

    let err = "";
    let code = 0;
    const me = w.cur;
    for (const f of files) {
      const abs = resolve(ctx.cwd, f);
      if (!(await w.canTraverse(abs))) {
        err += `setfacl: ${f}: Permission denied\n`;
        code = 1;
        continue;
      }
      const top = await w.resolveFinal(abs);
      if (!(await w.info(top, true))) {
        err += `setfacl: ${f}: No such file or directory\n`;
        code = 1;
        continue;
      }
      const targets = recursive ? w.subtree(top) : [top];
      for (const path of targets) {
        const inf = await w.info(path, true);
        if (!inf || inf.isLink) continue;
        const shown = path === top ? f : f.replace(/\/$/, "") + path.slice(top.length);
        if (me.uid !== 0 && me.uid !== inf.uid) {
          err += `setfacl: ${shown}: Operation not permitted\n`;
          code = 1;
          continue;
        }
        const old = w.aclOf(path);
        const acl: Acl = old
          ? { users: new Map(old.users), groups: new Map(old.groups), mask: old.mask, groupObj: old.groupObj, def: old.def ? { ...old.def, users: new Map(old.def.users), groups: new Map(old.def.groups) } : undefined }
          : { users: new Map(), groups: new Map(), mask: 0, groupObj: 0 };
        let mode = inf.mode;
        if (!extended(old)) acl.groupObj = (mode >> 3) & 7;
        let explicitMask = false;
        let explicitDefMask = false;
        let bad = false;
        if (removeAll) {
          acl.users.clear();
          acl.groups.clear();
          acl.def = undefined;
        }
        if (removeDefault) acl.def = undefined;
        const ensureDef = (): DefAcl => {
          if (!acl.def) acl.def = { user: (mode >> 6) & 7, group: acl.groupObj, other: mode & 7, users: new Map(), groups: new Map(), mask: 0 };
          return acl.def;
        };
        for (const op of ops) {
          if (op.op === "set") {
            acl.users.clear();
            acl.groups.clear();
            acl.def = undefined;
          }
          for (const e of op.entries) {
            const toDef = e.def || defaultOpt;
            if (toDef && !inf.isDir) {
              if (!recursive) {
                err += `setfacl: ${shown}: Only directories can have default ACLs\n`;
                code = 1;
              }
              bad = true;
              break;
            }
            const val = e.perm ?? 0;
            if (op.op === "x") {
              if (toDef) {
                const d = ensureDef();
                if (e.kind === "user" && e.id !== undefined) d.users.delete(e.id);
                if (e.kind === "group" && e.id !== undefined) d.groups.delete(e.id);
              } else {
                if (e.kind === "user" && e.id !== undefined) acl.users.delete(e.id);
                if (e.kind === "group" && e.id !== undefined) acl.groups.delete(e.id);
              }
              continue;
            }
            if (toDef) {
              const d = ensureDef();
              if (e.kind === "user") (e.id === undefined ? (d.user = val) : d.users.set(e.id, val));
              else if (e.kind === "group") (e.id === undefined ? (d.group = val) : d.groups.set(e.id, val));
              else if (e.kind === "mask") {
                d.mask = val;
                explicitDefMask = true;
              } else d.other = val;
            } else if (e.kind === "user") {
              if (e.id === undefined) mode = (mode & ~0o700) | (val << 6);
              else acl.users.set(e.id, val);
            } else if (e.kind === "group") {
              if (e.id === undefined) acl.groupObj = val;
              else acl.groups.set(e.id, val);
            } else if (e.kind === "mask") {
              acl.mask = val;
              explicitMask = true;
            } else mode = (mode & ~7) | val;
          }
          if (bad) break;
        }
        if (bad) continue;
        const recalc = (users: Map<number, number>, groups: Map<number, number>, gobj: number) => {
          let m = gobj;
          for (const p of users.values()) m |= p;
          for (const p of groups.values()) m |= p;
          return m;
        };
        if (!noMask && !explicitMask) acl.mask = recalc(acl.users, acl.groups, acl.groupObj);
        if (acl.def && !explicitDefMask) acl.def.mask = recalc(acl.def.users, acl.def.groups, acl.def.group);
        // запись в mode: при расширенном ACL группа = маска, иначе group::
        const ext = extended(acl);
        mode = (mode & ~0o070) | ((ext ? acl.mask : acl.groupObj) << 3);
        if (!ext && !acl.def) w.acls.delete(w.inodes.ino(path));
        else w.acls.set(w.inodes.ino(path), acl);
        await w.setModeRaw(path, mode);
      }
    }
    return { stdout: "", stderr: err, exitCode: code };
  });

  const getfacl = defineCommand("getfacl", async (args, ctx) => {
    const flags = new Set<string>();
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") {
        files.push(...args.slice(i + 1));
        break;
      }
      const long: Record<string, string> = { "--access": "a", "--default": "d", "--omit-header": "c", "--recursive": "R", "--absolute-names": "p", "--numeric": "n", "--skip-base": "s", "--no-effective": "E", "--all-effective": "e", "--physical": "P", "--logical": "L", "--tabular": "t" };
      if (a.startsWith("--")) {
        if (!long[a]) return fail(`getfacl: unrecognized option '${a}'\nUsage: getfacl [-aceEsRLPtpndvh] file ...`, 1);
        flags.add(long[a]);
      } else if (a.startsWith("-") && a.length > 1) {
        for (const c of a.slice(1)) {
          if (!"acdeEsRLPtpnvh".includes(c)) return fail(`getfacl: invalid option -- '${c}'\nUsage: getfacl [-aceEsRLPtpndvh] file ...`, 1);
          flags.add(c);
        }
      } else files.push(a);
    }
    if (!files.length) return fail("Usage: getfacl [-aceEsRLPtpndvh] file ...\nTry `getfacl --help' for more information.", 1);
    let out = "";
    let err = "";
    let code = 0;
    let stripped = false;
    const numeric = flags.has("n");
    const un = (id: number) => (numeric ? String(id) : (w.userByUid(id)?.name ?? String(id)));
    const gn = (id: number) => (numeric ? String(id) : (w.groupByGid(id)?.name ?? String(id)));
    for (const f of files) {
      const abs = resolve(ctx.cwd, f);
      if (!(await w.canTraverse(abs))) {
        err += `getfacl: ${f}: Permission denied\n`;
        code = 1;
        continue;
      }
      const top = await w.resolveFinal(abs);
      if (!(await w.info(top, true))) {
        err += `getfacl: ${f}: No such file or directory\n`;
        code = 1;
        continue;
      }
      for (const path of flags.has("R") ? w.subtree(top) : [top]) {
        const inf = await w.info(path, true);
        if (!inf) continue;
        const acl = w.aclOf(path);
        if (flags.has("s") && !(extended(acl) || acl?.def)) continue;
        let shown = path === top ? f : f.replace(/\/$/, "") + path.slice(top.length);
        if (shown.startsWith("/") && !flags.has("p")) {
          shown = shown.replace(/^\/+/, "");
          stripped = true;
        }
        if (!flags.has("c")) {
          out += `# file: ${shown}\n# owner: ${un(inf.uid)}\n# group: ${gn(inf.gid)}\n`;
          const sp = inf.mode & 0o7000;
          if (sp) out += `# flags: ${sp & 0o4000 ? "s" : "-"}${sp & 0o2000 ? "s" : "-"}${sp & 0o1000 ? "t" : "-"}\n`;
        }
        const onlyDef = flags.has("d") && !flags.has("a");
        out += formatAcl(acl, inf.mode, inf.isDir, { user: un, group: gn }, un(inf.uid), gn(inf.gid), { access: !onlyDef, defaults: !flags.has("a") || flags.has("d") }) + "\n";
      }
    }
    if (stripped) err = "getfacl: Removing leading '/' from absolute path names\n" + err;
    return { stdout: out, stderr: err, exitCode: code };
  });

  return [setfacl, getfacl];
}
