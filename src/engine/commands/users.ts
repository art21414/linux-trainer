// Пользователи и группы: id, whoami, groups, useradd, groupadd, usermod, userdel, groupdel, passwd, su, sudo, hostname
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { User, World } from "../world";
import { bytesToText, fail, ok, parseArgs, shq } from "../util";

const CONTEXT = "context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023";

function needRoot(w: World, cmd: string): ReturnType<typeof fail> | null {
  if (w.cur.uid === 0) return null;
  return fail(`${cmd}: Permission denied.\n${cmd}: cannot lock /etc/${cmd.startsWith("group") ? "group" : "passwd"}; try again later.`);
}

function groupList(w: World, u: User): { gid: number; name: string }[] {
  const res = [{ gid: u.gid, name: w.groupByGid(u.gid)?.name ?? String(u.gid) }];
  for (const g of u.groups) {
    const gg = w.group(g);
    if (gg && gg.gid !== u.gid) res.push({ gid: gg.gid, name: gg.name });
  }
  return res;
}

export function userCommands(w: World): Command[] {
  const whoami = defineCommand("whoami", async () => ok(w.current + "\n"));

  const id = defineCommand("id", async (args) => {
    const p = parseArgs(args, { short: "ugGnrZ", long: { user: "u", group: "g", groups: "G", name: "n" } });
    if (p.bad) return fail(`id: invalid option -- '${p.bad.replace(/^-+/, "")}'\nTry 'id --help' for more information.`);
    const target = p.rest[0];
    const u = target ? w.user(target) : w.cur;
    if (!u) return fail(`id: ‘${target}’: no such user`);
    const gl = groupList(w, u);
    const n = p.flags.has("n");
    if (p.flags.has("u")) return ok((n ? u.name : String(u.uid)) + "\n");
    if (p.flags.has("g")) return ok((n ? gl[0].name : String(u.gid)) + "\n");
    if (p.flags.has("G")) return ok(gl.map((g) => (n ? g.name : String(g.gid))).join(" ") + "\n");
    const line = `uid=${u.uid}(${u.name}) gid=${u.gid}(${gl[0].name}) groups=${gl.map((g) => `${g.gid}(${g.name})`).join(",")}`;
    return ok(line + (target ? "" : " " + CONTEXT) + "\n");
  });

  const groups = defineCommand("groups", async (args) => {
    if (!args.length) return ok(groupList(w, w.cur).map((g) => g.name).join(" ") + "\n");
    let out = "";
    let err = "";
    for (const name of args) {
      const u = w.user(name);
      if (!u) err += `groups: ‘${name}’: no such user\n`;
      else out += `${name} : ${groupList(w, u).map((g) => g.name).join(" ")}\n`;
    }
    return { stdout: out, stderr: err, exitCode: err ? 1 : 0 };
  });

  const useradd = defineCommand("useradd", async (args) => {
    const deny = needRoot(w, "useradd");
    if (deny) return deny;
    const p = parseArgs(args, {
      short: "mMrN",
      withValue: ["u", "g", "G", "s", "c", "d"],
      long: { "create-home": "m", "no-create-home": "M", system: "r" },
    });
    const name = p.rest[0];
    if (!name) return fail("Usage: useradd [options] LOGIN", 2);
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(name)) return fail(`useradd: invalid user name '${name}': use --badname to ignore`, 3);
    if (w.user(name)) return fail(`useradd: user '${name}' already exists`, 9);
    let gid: number | undefined;
    if (p.values.has("g")) {
      const gv = p.values.get("g")!;
      const g = w.group(gv) ?? w.groupByGid(Number(gv));
      if (!g) return fail(`useradd: group '${gv}' does not exist`, 6);
      gid = g.gid;
    } else if (w.group(name)) {
      return fail(`useradd: group ${name} exists - if you want to add this user to that group, use -g.`, 9);
    }
    const extra = p.values.get("G")?.split(",").filter(Boolean) ?? [];
    for (const g of extra) if (!w.group(g)) return fail(`useradd: group '${g}' does not exist`, 6);
    const uid = p.values.has("u") ? Number(p.values.get("u")) : undefined;
    if (uid !== undefined && w.userByUid(uid)) return fail(`useradd: UID ${uid} is not unique`, 4);
    await w.addUser(name, {
      uid,
      gid,
      groups: extra,
      shell: p.values.get("s"),
      comment: p.values.get("c"),
      home: p.values.get("d"),
      createHome: !p.flags.has("M"),
    });
    return ok();
  });

  const groupadd = defineCommand("groupadd", async (args) => {
    const deny = needRoot(w, "groupadd");
    if (deny) return deny;
    const p = parseArgs(args, { short: "rf", withValue: ["g"] });
    const name = p.rest[0];
    if (!name) return fail("Usage: groupadd [options] GROUP", 2);
    if (w.group(name)) return p.flags.has("f") ? ok() : fail(`groupadd: group '${name}' already exists`, 9);
    const gid = p.values.has("g") ? Number(p.values.get("g")) : undefined;
    if (gid !== undefined && w.groupByGid(gid)) return fail(`groupadd: GID '${gid}' already exists`, 4);
    w.addGroup(name, gid);
    await w.syncEtc();
    return ok();
  });

  const usermod = defineCommand("usermod", async (args) => {
    const deny = needRoot(w, "usermod");
    if (deny) return deny;
    const p = parseArgs(args, { short: "aLU", withValue: ["G", "g", "s", "c", "d"], long: { append: "a", lock: "L", unlock: "U" } });
    const name = p.rest[0];
    if (!name) return fail("Usage: usermod [options] LOGIN", 2);
    const u = w.user(name);
    if (!u) return fail(`usermod: user '${name}' does not exist`, 6);
    if (p.flags.has("a") && !p.values.has("G")) return fail("usermod: -a flag is ONLY allowed with the -G flag\nUsage: usermod [options] LOGIN", 2);
    if (p.values.has("G")) {
      const list = p.values.get("G")!.split(",").filter(Boolean);
      for (const g of list) if (!w.group(g)) return fail(`usermod: group '${g}' does not exist`, 6);
      u.groups = p.flags.has("a") ? [...new Set([...u.groups, ...list])] : list;
    }
    if (p.values.has("g")) {
      const gv = p.values.get("g")!;
      const g = w.group(gv) ?? w.groupByGid(Number(gv));
      if (!g) return fail(`usermod: group '${gv}' does not exist`, 6);
      u.gid = g.gid;
    }
    if (p.values.has("s")) u.shell = p.values.get("s")!;
    if (p.values.has("c")) u.comment = p.values.get("c")!;
    if (p.values.has("d")) u.home = p.values.get("d")!;
    await w.syncEtc();
    return ok();
  });

  const userdel = defineCommand("userdel", async (args) => {
    const deny = needRoot(w, "userdel");
    if (deny) return deny;
    const p = parseArgs(args, { short: "rf", long: { remove: "r", force: "f" } });
    const name = p.rest[0];
    if (!name) return fail("Usage: userdel [options] LOGIN", 2);
    const u = w.user(name);
    if (!u) return fail(`userdel: user '${name}' does not exist`, 6);
    w.users.delete(name);
    const pg = w.groupByGid(u.gid);
    if (pg && pg.name === name && !w.membersOf(name).length) w.groups.delete(name);
    if (p.flags.has("r") && (await w.exists(u.home))) await w.base.rm(u.home, { recursive: true, force: true });
    await w.syncEtc();
    return ok();
  });

  const groupdel = defineCommand("groupdel", async (args) => {
    const deny = needRoot(w, "groupdel");
    if (deny) return deny;
    const name = args[0];
    if (!name) return fail("Usage: groupdel [options] GROUP", 2);
    const g = w.group(name);
    if (!g) return fail(`groupdel: group '${name}' does not exist`, 6);
    const primary = [...w.users.values()].find((u) => u.gid === g.gid);
    if (primary) return fail(`groupdel: cannot remove the primary group of user '${primary.name}'`, 8);
    w.groups.delete(name);
    for (const u of w.users.values()) u.groups = u.groups.filter((x) => x !== name);
    await w.syncEtc();
    return ok();
  });

  const passwd = defineCommand("passwd", async (args, ctx) => {
    const p = parseArgs(args, { short: "lud", long: { stdin: "stdin" } });
    const name = p.rest[0] ?? w.current;
    if (p.rest[0] && w.cur.uid !== 0) return fail("passwd: Only root can specify a user name.");
    if (!w.user(name)) return fail(`passwd: Unknown user name '${name}'.`);
    if (p.flags.has("stdin")) {
      if (!bytesToText(ctx.stdin).trim()) return fail("passwd: Authentication token manipulation error");
      return ok(`Changing password for user ${name}.\npasswd: all authentication tokens updated successfully.\n`);
    }
    if (p.flags.has("l")) return ok(`Locking password for user ${name}.\npasswd: Success\n`);
    if (p.flags.has("u")) return ok(`Unlocking password for user ${name}.\npasswd: Success\n`);
    return fail(`Changing password for user ${name}.\nтренажёр: интерактивный ввод пароля пока не поддерживается.\nИспользуй: echo 'пароль' | passwd --stdin ${name}`);
  });

  const su = defineCommand("su", async (args, ctx) => {
    let login = false;
    let command: string | undefined;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-" || a === "-l" || a === "--login") login = true;
      else if (a === "-c" || a === "--command") command = args[++i];
      else rest.push(a);
    }
    const name = rest[0] ?? "root";
    const u = w.user(name);
    if (!u) return fail(`su: user ${name} does not exist or the user entry does not contain all the required fields`);
    if (command !== undefined) {
      const prev = w.current;
      w.current = name;
      try {
        return await ctx.exec!(command, { cwd: login ? u.home : ctx.cwd, stdin: ctx.stdin as unknown as string });
      } finally {
        w.current = prev;
      }
    }
    w.pendingSu = { user: name, login };
    return ok();
  });

  const sudo = defineCommand("sudo", async (args, ctx) => {
    const me = w.cur;
    const inWheel = me.uid === 0 || w.gidsOf(me).has(w.group("wheel")?.gid ?? -1);
    if (!inWheel) return fail(`${me.name} is not in the sudoers file.  This incident will be reported.`);
    let target = "root";
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-u") target = args[++i];
      else if (a === "-i" || a === "-s") {
        w.pendingSu = { user: target, login: a === "-i" };
        return ok();
      } else if (!a.startsWith("-")) break;
    }
    const cmd = args.slice(i);
    if (!cmd.length) return fail("usage: sudo -h | -K | -k | -V\nusage: sudo [-u user] command", 1);
    if (!w.user(target)) return fail(`sudo: unknown user ${target}`);
    const prev = w.current;
    w.current = target;
    try {
      return await ctx.exec!(cmd.map(shq).join(" "), { cwd: ctx.cwd, stdin: ctx.stdin as unknown as string });
    } finally {
      w.current = prev;
    }
  });

  const hostname = defineCommand("hostname", async (args) => {
    if (args[0] === "-s" || args[0] === "--short") return ok(w.hostname.split(".")[0] + "\n");
    if (args[0] && !args[0].startsWith("-")) {
      if (w.cur.uid !== 0) return fail("hostname: you must be root to change the host name");
      w.hostname = args[0];
      return ok();
    }
    return ok(w.hostname + "\n");
  });

  const hostnamectl = defineCommand("hostnamectl", async (args) => {
    const sub = args[0] ?? "status";
    if (sub === "set-hostname" || sub === "hostname") {
      if (!args[1]) return ok(w.hostname + "\n");
      if (w.cur.uid !== 0) return fail("Could not set static hostname: Access denied");
      w.hostname = args[1];
      await w.write("/etc/hostname", w.hostname + "\n");
      return ok();
    }
    if (sub === "status") {
      return ok(
        [
          ` Static hostname: ${w.hostname}`,
          `       Icon name: computer-vm`,
          `         Chassis: vm 🖴`,
          `      Machine ID: 4f1c2a9e7b3d4c5e8f60718293a4b5c6`,
          `  Virtualization: kvm`,
          `Operating System: Rocky Linux 9.6 (Blue Onyx)`,
          `     CPE OS Name: cpe:/o:rocky:rocky:9::baseos`,
          `          Kernel: Linux 5.14.0-570.17.1.el9_6.x86_64`,
          `    Architecture: x86-64`,
          "",
        ].join("\n"),
      );
    }
    return fail(`Unknown command verb ${sub}.`);
  });

  return [whoami, id, groups, useradd, groupadd, usermod, userdel, groupdel, passwd, su, sudo, hostname, hostnamectl];
}
