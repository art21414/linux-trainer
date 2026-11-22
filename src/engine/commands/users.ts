// Пользователи и группы: id, whoami, groups, useradd, groupadd, usermod, userdel, groupdel, passwd, su, sudo, hostname
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { User, World } from "../world";
import { bytesToText, fail, ok, parseArgs, shq } from "../util";
import { accountCommands, matchRules, readSudoers, rulesFor, sudoCmdPath } from "./accounts";
import { todayDays } from "../world";

const SHELLS = ["/bin/sh", "/bin/bash", "/sbin/nologin", "/usr/bin/sh", "/usr/bin/bash", "/usr/sbin/nologin", "/bin/false", "/usr/bin/false", "/bin/tcsh", "/bin/csh"];
async function shellOk(w: World, sh: string): Promise<boolean> {
  return SHELLS.includes(sh) || (await w.exists(sh));
}
const parseDay = (v: string): number | null => {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v);
  if (/^-?\d+$/.test(v)) return Number(v);
  return m ? Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000) : null;
};

const CONTEXT = "context=unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023";

function needRoot(w: World, cmd: string): ReturnType<typeof fail> | null {
  if (w.cur.uid === 0) return null;
  return fail(`${cmd}: Permission denied.\n${cmd}: cannot lock /etc/${cmd.startsWith("group") ? "group" : "passwd"}; try again later.`);
}

function groupList(w: World, u: User): { gid: number; name: string }[] {
  const res = [{ gid: u.gid, name: w.groupByGid(u.gid)?.name ?? String(u.gid) }];
  const extra: { gid: number; name: string }[] = [];
  for (const g of u.groups) {
    const gg = w.group(g);
    if (gg && gg.gid !== u.gid) extra.push({ gid: gg.gid, name: gg.name });
  }
  return res.concat(extra.sort((a, b) => a.gid - b.gid));
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

  const shellWarn = async (cmd: string, sh: string) => ((await shellOk(w, sh)) ? "" : `${cmd}: Warning: missing or non-executable shell '${sh}'\n`);

  const useradd = defineCommand("useradd", async (args) => {
    const deny = needRoot(w, "useradd");
    if (deny) return deny;
    const p = parseArgs(args, {
      short: "mMrNUo",
      withValue: ["u", "g", "G", "s", "c", "d", "e", "f", "k", "p"],
      long: { "create-home": "m", "no-create-home": "M", system: "r", "no-user-group": "N", "user-group": "U", "non-unique": "o", uid: "u", gid: "g", groups: "G", shell: "s", comment: "c", "home-dir": "d", expiredate: "e", inactive: "f", "skel": "k", password: "p" },
    });
    if (p.bad) return fail(`useradd: ${p.bad.startsWith("--") ? `unrecognized option '${p.bad}'` : `invalid option -- '${p.bad}'`}\nUsage: useradd [options] LOGIN\n       useradd -D\n       useradd -D [options]`, 2);
    const name = p.rest[0];
    if (!name) return fail("Usage: useradd [options] LOGIN\n       useradd -D\n       useradd -D [options]", 2);
    if (!/^[a-z_][a-z0-9_-]*\$?$/.test(name)) return fail(`useradd: invalid user name '${name}': use --badname to ignore`, 3);
    if (w.user(name)) return fail(`useradd: user '${name}' already exists`, 9);
    let gid: number | undefined;
    if (p.values.has("g")) {
      const gv = p.values.get("g")!;
      const g = w.group(gv) ?? w.groupByGid(Number(gv));
      if (!g) return fail(`useradd: group '${gv}' does not exist`, 6);
      gid = g.gid;
    } else if (p.flags.has("N")) {
      gid = w.group("users")?.gid ?? 100;
    } else if (w.group(name)) {
      return fail(`useradd: group ${name} exists - if you want to add this user to that group, use -g.`, 9);
    }
    const extra = p.values.get("G")?.split(",").filter(Boolean) ?? [];
    for (const g of extra) if (!w.group(g)) return fail(`useradd: group '${g}' does not exist`, 6);
    let uid: number | undefined;
    if (p.values.has("u")) {
      const raw = p.values.get("u")!;
      if (!/^\d+$/.test(raw)) return fail(`useradd: invalid user ID '${raw}'`, 3);
      uid = Number(raw);
      if (w.userByUid(uid) && !p.flags.has("o")) return fail(`useradd: UID ${uid} is not unique`, 4);
    }
    const system = p.flags.has("r");
    const shell = p.values.get("s");
    const home = p.values.get("d");
    // -r не создаёт домашний каталог, пока не указан -m; CREATE_HOME из login.defs
    const createHome = p.flags.has("m") || (!p.flags.has("M") && !system && (await w.loginDef("CREATE_HOME", "yes")) === "yes");
    const warn = shell !== undefined ? await shellWarn("useradd", shell) : "";
    const u = await w.addUser(name, { uid, gid, groups: extra, shell: shell ?? (system ? "/sbin/nologin" : undefined), comment: p.values.get("c"), home: home ?? (system ? `/var/lib/${name}` : undefined), createHome: false, system });
    if (createHome) {
      await w.mkdir(u.home, parseInt(await w.loginDef("HOME_MODE", "0700"), 8), u.uid, u.gid);
      await w.copySkel(u.home, u.uid, u.gid, p.values.get("k") ?? "/etc/skel");
    }
    const a = w.agingOf(u);
    a.min = Number(await w.loginDef("PASS_MIN_DAYS", "0"));
    a.max = Number(await w.loginDef("PASS_MAX_DAYS", "99999"));
    a.warn = Number(await w.loginDef("PASS_WARN_AGE", "7"));
    if (p.values.has("e")) a.expire = parseDay(p.values.get("e")!) ?? -1;
    if (p.values.has("f")) a.inactive = Number(p.values.get("f"));
    if (!system && (await w.exists("/var/spool/mail"))) {
      await w.write(`/var/spool/mail/${name}`, "", 0o660, u.uid, w.group("mail")?.gid ?? 12);
    }
    await w.syncEtc();
    return { stdout: "", stderr: warn, exitCode: 0 };
  });

  const groupadd = defineCommand("groupadd", async (args) => {
    const deny = needRoot(w, "groupadd");
    if (deny) return deny;
    const p = parseArgs(args, { short: "rfo", withValue: ["g"], long: { gid: "g", system: "r", force: "f" } });
    if (p.bad) return fail(`groupadd: invalid option -- '${p.bad.replace(/^-+/, "")}'\nUsage: groupadd [options] GROUP`, 2);
    const name = p.rest[0];
    if (!name) return fail("Usage: groupadd [options] GROUP", 2);
    if (w.group(name)) return p.flags.has("f") ? ok() : fail(`groupadd: group '${name}' already exists`, 9);
    const gid = p.values.has("g") ? Number(p.values.get("g")) : undefined;
    if (gid !== undefined && w.groupByGid(gid) && !p.flags.has("o")) return fail(`groupadd: GID '${gid}' already exists`, 4);
    w.addGroup(name, gid);
    await w.syncEtc();
    return ok();
  });

  const usermod = defineCommand("usermod", async (args) => {
    const deny = needRoot(w, "usermod");
    if (deny) return deny;
    const p = parseArgs(args, {
      short: "aLUmo",
      withValue: ["G", "g", "s", "c", "d", "l", "u", "e", "f", "p"],
      long: { append: "a", lock: "L", unlock: "U", groups: "G", gid: "g", shell: "s", comment: "c", home: "d", login: "l", uid: "u", expiredate: "e", inactive: "f", "move-home": "m" },
    });
    if (p.bad) return fail(`usermod: ${p.bad.startsWith("--") ? `unrecognized option '${p.bad}'` : `invalid option -- '${p.bad}'`}\nUsage: usermod [options] LOGIN`, 2);
    const name = p.rest[0];
    if (!name) return fail("Usage: usermod [options] LOGIN", 2);
    const u = w.user(name);
    if (!u) return fail(`usermod: user '${name}' does not exist`, 6);
    if (p.flags.has("a") && !p.values.has("G")) return fail("usermod: -a flag is only allowed with the -G flag\nUsage: usermod [options] LOGIN", 2);
    let err = "";
    if (p.flags.has("L") && p.flags.has("U")) return fail("usermod: the -L and -U options are mutually exclusive\nUsage: usermod [options] LOGIN", 2);
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
    if (p.values.has("s")) {
      u.shell = p.values.get("s")!;
      err += await shellWarn("usermod", u.shell);
    }
    if (p.values.has("c")) u.comment = p.values.get("c")!;
    if (p.values.has("u")) {
      const nu = Number(p.values.get("u"));
      if (w.userByUid(nu) && !p.flags.has("o") && nu !== u.uid) return fail(`usermod: UID '${nu}' already exists`, 4);
      const old = u.uid;
      u.uid = nu;
      // как настоящий usermod -u: владелец домашнего каталога и почты переезжает, остальные файлы остаются со старым uid
      for (const [path, o] of w.owners) if (o.uid === old && (path === u.home || path.startsWith(u.home + "/") || path === `/var/spool/mail/${name}`)) w.owners.set(path, { ...o, uid: nu });
    }
    if (p.values.has("d")) {
      const nd = p.values.get("d")!;
      if (p.flags.has("m") && u.home !== nd && (await w.exists(u.home))) {
        await w.base.mv(u.home, nd);
        for (const [path, o] of [...w.owners]) if (path === u.home || path.startsWith(u.home + "/")) {
          w.owners.delete(path);
          w.owners.set(nd + path.slice(u.home.length), o);
        }
      }
      u.home = nd;
    }
    if (p.values.has("e")) w.agingOf(u).expire = p.values.get("e") === "" ? -1 : (parseDay(p.values.get("e")!) ?? -1);
    if (p.values.has("f")) w.agingOf(u).inactive = Number(p.values.get("f"));
    if (p.flags.has("L")) u.locked = true;
    if (p.flags.has("U")) {
      if (u.password === undefined) {
        await w.syncEtc();
        return { stdout: "", stderr: "usermod: unlocking the user's password would result in a passwordless account.\nYou should set a password with usermod -p to unlock this user's password.\n", exitCode: 0 };
      }
      u.locked = false;
    }
    if (p.values.has("l")) {
      const nn = p.values.get("l")!;
      if (w.user(nn)) return fail(`usermod: user '${nn}' already exists`, 9);
      w.users.delete(name);
      u.name = nn;
      w.users.set(nn, u);
      if (await w.exists(`/var/spool/mail/${name}`)) await w.base.mv(`/var/spool/mail/${name}`, `/var/spool/mail/${nn}`);
    }
    await w.syncEtc();
    return { stdout: "", stderr: err, exitCode: 0 };
  });

  const userdel = defineCommand("userdel", async (args) => {
    const deny = needRoot(w, "userdel");
    if (deny) return deny;
    const p = parseArgs(args, { short: "rf", long: { remove: "r", force: "f" } });
    const name = p.rest[0];
    if (!name) return fail("Usage: userdel [options] LOGIN", 2);
    const u = w.user(name);
    if (!u) return fail(`userdel: user '${name}' does not exist`, 6);
    let err = "";
    w.users.delete(name);
    const pg = w.groupByGid(u.gid);
    if (pg && pg.name === name && !w.membersOf(name).length) w.groups.delete(name);
    if (p.flags.has("r")) {
      const mail = `/var/spool/mail/${name}`;
      if (await w.exists(mail)) await w.base.rm(mail, { force: true });
      else err += `userdel: ${name} mail spool (${mail}) not found\n`;
      if (await w.exists(u.home)) await w.base.rm(u.home, { recursive: true, force: true });
      else err += `userdel: ${name} home directory (${u.home}) not found\n`;
    }
    await w.syncEtc();
    return { stdout: "", stderr: err, exitCode: 0 };
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
    const p = parseArgs(args, { short: "ludSefk", withValue: ["n", "x", "w", "i"], long: { stdin: "stdin", lock: "l", unlock: "u", delete: "d", status: "S", expire: "e", force: "f" } });
    if (p.bad) return fail(`passwd: ${p.bad.startsWith("--") ? `unrecognized option '${p.bad}'` : `invalid option -- '${p.bad}'`}\nUsage: passwd [OPTION...] <accountName>`, 2);
    const name = p.rest[0] ?? w.current;
    const admin = ["l", "u", "d", "S", "e", "n", "x", "w", "i", "stdin"].some((k) => p.flags.has(k) || p.values.has(k));
    if (p.rest[0] && w.cur.uid !== 0) return fail("passwd: Only root can specify a user name.", 1);
    if (admin && w.cur.uid !== 0 && !(p.flags.has("S") && name === w.current)) return fail("passwd: Permission denied.", 1);
    const u = w.user(name);
    if (!u) return fail(`passwd: Unknown user name '${name}'.`, 1);
    const a = w.agingOf(u);
    const done = async (msg: string) => {
      await w.syncEtc();
      return ok(msg);
    };
    if (p.flags.has("S")) {
      const field = u.password === undefined || u.locked ? "LK" : u.password === "" ? "NP" : "PS";
      const txt = field === "LK" ? "Password locked." : field === "NP" ? "Empty password." : "Password set, SHA512 crypt.";
      return ok(`${u.name} ${field} ${new Date(a.lastChange * 86400000).toISOString().slice(0, 10)} ${a.min} ${a.max} ${a.warn} ${a.inactive} (${txt})\n`);
    }
    if (p.flags.has("l")) {
      u.locked = true;
      return done(`Locking password for user ${name}.\npasswd: Success\n`);
    }
    if (p.flags.has("u")) {
      if (u.password === undefined && !p.flags.has("f")) return fail(`Unlocking password for user ${name}.\npasswd: Warning: unlocked password would be empty.\npasswd: Unsafe operation (use -f option to override)`, 1);
      u.locked = false;
      return done(`Unlocking password for user ${name}.\npasswd: Success\n`);
    }
    if (p.flags.has("d")) {
      u.password = "";
      return done(`Removing password for user ${name}.\npasswd: Success\n`);
    }
    if (p.flags.has("e")) {
      a.lastChange = 0;
      return done(`Expiring password for user ${name}.\npasswd: Success\n`);
    }
    if (["n", "x", "w", "i"].some((k) => p.values.has(k))) {
      if (p.values.has("n")) a.min = Number(p.values.get("n"));
      if (p.values.has("x")) a.max = Number(p.values.get("x"));
      if (p.values.has("w")) a.warn = Number(p.values.get("w"));
      if (p.values.has("i")) a.inactive = Number(p.values.get("i"));
      return done(`Adjusting aging data for user ${name}.\npasswd: Success\n`);
    }
    if (p.flags.has("stdin")) {
      const pw = bytesToText(ctx.stdin).split("\n")[0];
      if (!pw) return fail("passwd: Authentication token manipulation error", 1);
      u.password = pw;
      a.lastChange = todayDays();
      return done(`Changing password for user ${name}.\npasswd: all authentication tokens updated successfully.\n`);
    }
    // интерактивно: вопросы через readLine (ввод виден — терминал не умеет скрывать)
    if (!w.readLine) return fail(`Changing password for user ${name}.\nтренажёр: интерактивный ввод пароля пока не поддерживается.\nИспользуй: echo 'пароль' | passwd --stdin ${name}`);
    let out = `Changing password for user ${name}.\n`;
    if (w.cur.uid !== 0) {
      const cur = await w.readLine("Current password: ");
      if (cur === null || u.password === undefined || cur !== u.password) return fail(out + "passwd: Authentication token manipulation error", 10);
    }
    const n1 = await w.readLine(w.cur.uid === 0 ? "New password: " : "New password: ");
    if (n1 === null) return fail(out + "passwd: Authentication token manipulation error", 10);
    if (n1.length < 8) out += n1.length === 0 ? "BAD PASSWORD: No password supplied\n" : "BAD PASSWORD: The password is shorter than 8 characters\n";
    if (n1.length === 0) return fail(out + "passwd: Authentication token manipulation error", 10);
    if (w.cur.uid !== 0 && n1.length < 8) return fail(out + "passwd: Authentication token manipulation error", 10);
    const n2 = await w.readLine("Retype new password: ");
    if (n2 !== n1) return fail(out + "Sorry, passwords do not match.\npasswd: Authentication token manipulation error", 10);
    u.password = n1;
    a.lastChange = todayDays();
    return done(out + "passwd: all authentication tokens updated successfully.\n");
  });

  const su = defineCommand("su", async (args, ctx) => {
    let login = false;
    let command: string | undefined;
    let keepEnv = false;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "-" || a === "-l" || a === "--login") login = true;
      else if (a === "-c" || a === "--command") command = args[++i] ?? "";
      else if (a === "-m" || a === "-p" || a === "--preserve-environment") keepEnv = true;
      else if (a === "-s" || a === "--shell") i++;
      else if (/^-[lmpc]+$/.test(a) && a.length > 2) {
        for (const c of a.slice(1)) {
          if (c === "l") login = true;
          if (c === "m" || c === "p") keepEnv = true;
        }
      } else if (a.startsWith("-") && a !== "--") return fail(`su: invalid option -- '${a.replace(/^-+/, "")}'\nTry 'su --help' for more information.`, 1);
      else rest.push(a);
    }
    const name = rest[0] ?? "root";
    const u = w.user(name);
    if (!u) return fail(`su: user ${name} does not exist or the user entry does not contain all the required fields`);
    // пароль нужен не-root; без терминала (тесты, -c из скриптов) проверка пропускается
    if (w.cur.uid !== 0 && w.readLine) {
      const pw = await w.readLine("Password: ");
      if (pw === null || u.password === undefined || u.locked || pw !== u.password) return fail("su: Authentication failure", 1);
    }
    if (/\/(nologin|false)$/.test(u.shell)) return fail("This account is currently not available.", 1);
    if (command !== undefined) {
      const prev = w.current;
      w.current = name;
      try {
        const cenv: Record<string, string> = ctx.env instanceof Map ? Object.fromEntries(ctx.env) : { ...(ctx.env as Record<string, string>) };
        const base = login ? {} : { ...cenv };
        const env: Record<string, string> = keepEnv ? { ...cenv } : { ...base, HOME: u.home, USER: name, LOGNAME: name, SHELL: u.shell };
        if (login && !keepEnv) {
          env.PATH = u.uid === 0 ? "/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin" : `${u.home}/.local/bin:${u.home}/bin:/usr/local/bin:/usr/bin`;
          env.TERM = cenv.TERM ?? "xterm-256color";
          env.LANG = cenv.LANG ?? "en_US.UTF-8";
          env.HOSTNAME = w.hostname;
        }
        const cmd = (login ? `[ -f /etc/profile ] && . /etc/profile; [ -f ~/.bash_profile ] && . ~/.bash_profile\n` : "") + command.replace(/\$\{?0\}?/g, login ? "-bash" : "bash");
        return await ctx.exec!(cmd, { cwd: login ? u.home : ctx.cwd, env, replaceEnv: true, stdin: ctx.stdin as unknown as string });
      } finally {
        w.current = prev;
      }
    }
    w.pendingSu = { user: name, login };
    return ok();
  });

  const sudoCache = new Set<string>();
  const sudo = defineCommand("sudo", async (args, ctx) => {
    const me = w.cur;
    let target = "root";
    let list = false;
    let listUser: string | undefined;
    let mode: "cmd" | "i" | "s" = "cmd";
    let i = 0;
    for (; i < args.length; i++) {
      const a = args[i];
      if (a === "-u" || a === "--user") target = args[++i] ?? "";
      else if (a === "-U") listUser = args[++i];
      else if (a === "-l" || a === "--list") list = true;
      else if (a === "-i" || a === "--login") mode = "i";
      else if (a === "-s" || a === "--shell") mode = "s";
      else if (a === "-k" || a === "-K" || a === "--reset-timestamp") {
        sudoCache.delete(me.name);
        if (i === args.length - 1) return ok();
      } else if (a === "-n" || a === "-H" || a === "-E" || a === "-S" || a === "-b" || a === "-A") continue;
      else if (a === "--") {
        i++;
        break;
      } else if (a.startsWith("-")) return fail(`sudo: invalid option -- '${a.replace(/^-+/, "")}'\nusage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]`, 1);
      else break;
    }
    const cmd = args.slice(i);
    const host = w.hostname.split(".")[0];
    const info = await readSudoers(w);
    if (list) {
      const who = listUser ? w.user(listUser) : me;
      if (listUser && me.uid !== 0) return fail(`Sorry, user ${me.name} is not allowed to execute 'list' as ${listUser} on ${host}.`, 1);
      if (!who) return fail(`sudo: unknown user ${listUser}`, 1);
      const rules = rulesFor(w, info, who);
      const own = listUser ? `User ${who.name} is not allowed to run sudo on ${host}.\n` : `Sorry, user ${who.name} may not run sudo on ${host}.\n`;
      if (!rules.length) return { stdout: listUser ? own : "", stderr: listUser ? "" : own, exitCode: listUser ? 0 : 1 };
      const defaults = `Matching Defaults entries for ${who.name} on ${host}:\n    !visiblepw, always_set_home, match_group_by_gid, always_query_group_plugin, env_reset, env_keep="COLORS DISPLAY HOSTNAME HISTSIZE KDEDIR LS_COLORS", env_keep+="MAIL PS1 PS2 QTDIR USERNAME LANG LC_ADDRESS LC_CTYPE", env_keep+="LC_COLLATE LC_IDENTIFICATION LC_MEASUREMENT LC_MESSAGES", env_keep+="LC_MONETARY LC_NAME LC_NUMERIC LC_PAPER LC_TELEPHONE", env_keep+="LC_TIME LC_ALL LANGUAGE LINGUAS _XKB_CHARSET XAUTHORITY", secure_path=/sbin\\:/bin\\:/usr/sbin\\:/usr/bin\n\n`;
      const lines = rules.map((r) => `    (${r.runas.join(", ")}) ${r.nopasswd ? "NOPASSWD: " : ""}${r.cmds.join(", ")}\n`).join("");
      return ok(`${defaults}User ${who.name} may run the following commands on ${host}:\n${lines}`);
    }
    if (mode === "cmd" && !cmd.length) return fail("usage: sudo -h | -K | -k | -V\nusage: sudo -v [-ABkNnS] [-g group] [-h host] [-p prompt] [-u user]", 1);
    if (!w.user(target)) return fail(`sudo: unknown user ${target}`, 1);
    const cmdPath = mode === "cmd" ? await sudoCmdPath(w, cmd[0]) : "/bin/bash";
    const anyRule = rulesFor(w, info, me);
    let rules = me.uid === 0 ? [{ who: "root", runas: ["ALL"], nopasswd: true, cmds: ["ALL"] }] : matchRules(w, info, me, target, mode === "cmd" ? cmdPath : undefined);
    if (me.uid !== 0 && mode !== "cmd") rules = rules.filter((r) => r.cmds.includes("ALL") || r.cmds.some((c) => /\/(ba)?sh$/.test(c)));
    if (!rules.length) {
      if (!anyRule.length) return fail(`${me.name} is not in the sudoers file.  This incident will be reported.`, 1);
      return fail(`Sorry, user ${me.name} is not allowed to execute '${mode === "cmd" ? cmd.join(" ").replace(cmd[0], cmdPath) : "/bin/bash"}' as ${target} on ${host}.`, 1);
    }
    // пароль: нужен, если у пользователя он задан и нет NOPASSWD; без пароля или терминала — пропускаем
    const needPw = me.uid !== 0 && !rules.some((r) => r.nopasswd) && !sudoCache.has(me.name) && w.readLine && me.password !== undefined;
    if (needPw) {
      let okPw = false;
      let tries = "";
      for (let t = 0; t < 3 && !okPw; t++) {
        const pw = await w.readLine!(`[sudo] password for ${me.name}: `);
        if (pw === null) break;
        okPw = pw === me.password;
        if (!okPw && t < 2) tries += "Sorry, try again.\n";
      }
      if (!okPw) return fail(tries + "sudo: 3 incorrect password attempts", 1);
    }
    if (me.uid !== 0) sudoCache.add(me.name);
    if (mode !== "cmd") {
      w.pendingSu = { user: target, login: mode === "i" };
      return ok();
    }
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

  return [whoami, id, groups, useradd, groupadd, usermod, userdel, groupdel, passwd, su, sudo, hostname, hostnamectl, ...accountCommands(w)];
}
