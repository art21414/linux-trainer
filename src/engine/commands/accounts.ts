// getent, chage, chpasswd, groupmod, visudo и разбор sudoers (общий для sudo).
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { User, World } from "../world";
import { DAY_MS, todayDays } from "../world";
import { bytesToText, fail, ok, parseArgs } from "../util";

// ---------- sudoers ----------

export interface SudoRule {
  who: string;
  runas: string[];
  nopasswd: boolean;
  cmds: string[];
}

export interface SudoersInfo {
  rules: SudoRule[];
  errors: { file: string; line: number }[];
  files: string[];
}

/** Разобрать /etc/sudoers и /etc/sudoers.d/* (имена с точкой и ~ sudo пропускает). */
export async function readSudoers(w: World): Promise<SudoersInfo> {
  const files = ["/etc/sudoers"];
  try {
    for (const n of (await w.base.readdir("/etc/sudoers.d")).sort()) if (!n.includes(".") && !n.endsWith("~")) files.push(`/etc/sudoers.d/${n}`);
  } catch {
    /* нет каталога */
  }
  const rules: SudoRule[] = [];
  const errors: { file: string; line: number }[] = [];
  const done: string[] = [];
  for (const f of files) {
    const text = await w.read(f);
    if (text === null) continue;
    done.push(f);
    const lines = text.replace(/\\\n/g, " ").split("\n");
    lines.forEach((raw, i) => {
      const line = raw.replace(/^\s+/, "");
      if (!line || (line.startsWith("#") && !/^#(include|includedir)\b/.test(line)) || /^#(include|includedir)\b/.test(line)) return;
      if (/^(Defaults|(User|Runas|Host|Cmnd)_Alias)\b/.test(line)) return;
      const m = /^(%?[\w.\-]+|ALL)\s+([\w.*\-]+(?:\s*,\s*[\w.*\-]+)*)\s*=\s*(.+?)\s*$/.exec(line);
      if (!m) {
        errors.push({ file: f, line: i + 1 });
        return;
      }
      let rest = m[3];
      let runas = ["root"];
      const r = /^\(([^)]*)\)\s*/.exec(rest);
      if (r) {
        runas = r[1].split(":")[0].split(",").map((x) => x.trim()).filter(Boolean);
        if (!runas.length) runas = ["ALL"];
        rest = rest.slice(r[0].length);
      }
      let nopasswd = false;
      let t: RegExpExecArray | null;
      while ((t = /^(NOPASSWD|PASSWD|SETENV|NOSETENV|NOEXEC|EXEC|LOG_INPUT|LOG_OUTPUT):\s*/.exec(rest))) {
        if (t[1] === "NOPASSWD") nopasswd = true;
        if (t[1] === "PASSWD") nopasswd = false;
        rest = rest.slice(t[0].length);
      }
      const cmds = rest.split(",").map((x) => x.trim()).filter(Boolean);
      if (!cmds.length) {
        errors.push({ file: f, line: i + 1 });
        return;
      }
      rules.push({ who: m[1], runas, nopasswd, cmds });
    });
  }
  return { rules, errors, files: done };
}

const usrmerge = (p: string) => p.replace(/^\/s?bin\//, (m) => "/usr" + m);

/** Полный путь команды как его видит sudo (secure_path). */
export async function sudoCmdPath(w: World, cmd: string): Promise<string> {
  if (cmd.includes("/")) return cmd;
  for (const d of ["/sbin", "/bin", "/usr/sbin", "/usr/bin"]) if (await w.exists(`${d}/${cmd}`)) return `${d}/${cmd}`;
  return cmd;
}

function ruleApplies(w: World, u: User, r: SudoRule): boolean {
  if (r.who === "ALL" || r.who === u.name) return true;
  if (r.who.startsWith("%")) {
    const g = w.group(r.who.slice(1));
    return !!g && w.gidsOf(u).has(g.gid);
  }
  return false;
}

/** Подходящие правила для user → target; cmdPath — проверяемая команда (undefined — любые). */
export function matchRules(w: World, info: SudoersInfo, u: User, target: string, cmdPath?: string): SudoRule[] {
  return info.rules.filter((r) => {
    if (!ruleApplies(w, u, r)) return false;
    if (!(r.runas.includes("ALL") || r.runas.includes(target))) return false;
    if (cmdPath === undefined) return true;
    return r.cmds.some((c) => c === "ALL" || usrmerge(c.split(/\s+/)[0]) === usrmerge(cmdPath));
  });
}

// ---------- даты chage ----------

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayStr = (d: number, iso: boolean) => {
  const t = new Date(d * DAY_MS);
  const dd = String(t.getUTCDate()).padStart(2, "0");
  return iso ? `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${dd}` : `${MON[t.getUTCMonth()]} ${dd}, ${t.getUTCFullYear()}`;
};
const parseDay = (v: string): number | null => {
  if (/^-?\d+$/.test(v)) return Number(v);
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.floor(t / DAY_MS);
};

const CHAGE_USAGE = `Usage: chage [options] LOGIN

Options:
  -d, --lastday LAST_DAY        set date of last password change to LAST_DAY
  -E, --expiredate EXPIRE_DATE  set account expiration date to EXPIRE_DATE
  -h, --help                    display this help message and exit
  -i, --iso8601                 use YYYY-MM-DD when printing dates
  -I, --inactive INACTIVE       set password inactive after expiration
                                to INACTIVE
  -l, --list                    show account aging information
  -m, --mindays MIN_DAYS        set minimum number of days before password
                                change to MIN_DAYS
  -M, --maxdays MAX_DAYS        set maximum number of days before password
                                change to MAX_DAYS
  -R, --root CHROOT_DIR         directory to chroot into
  -W, --warndays WARN_DAYS      set expiration warning days to WARN_DAYS
`;

export function accountCommands(w: World): Command[] {
  const getent = defineCommand("getent", async (args) => {
    const [db, ...keys] = args;
    if (!db) return fail("Usage: getent [OPTION...] database [key ...]\nTry `getent --help' or `getent --usage' for more information.", 64);
    const groupLine = (g: { name: string; gid: number }) => `${g.name}:x:${g.gid}:${[...w.users.values()].filter((u) => u.groups.includes(g.name)).map((u) => u.name).join(",")}`;
    const rows: { keys: string[]; line: string }[] = [];
    if (db === "passwd") {
      for (const u of [...w.users.values()].sort((a, b) => a.uid - b.uid)) rows.push({ keys: [u.name, String(u.uid)], line: `${u.name}:x:${u.uid}:${u.gid}:${u.comment}:${u.home}:${u.shell}` });
    } else if (db === "group") {
      for (const g of [...w.groups.values()].sort((a, b) => a.gid - b.gid)) rows.push({ keys: [g.name, String(g.gid)], line: groupLine(g) });
    } else if (db === "shadow") {
      if (w.cur.uid !== 0) return { stdout: "", stderr: "", exitCode: 2 };
      const text = (await w.read("/etc/shadow")) ?? "";
      for (const l of text.split("\n").filter(Boolean)) rows.push({ keys: [l.split(":")[0]], line: l });
    } else if (db === "hosts") {
      const text = (await w.read("/etc/hosts")) ?? "";
      for (const l of text.split("\n").filter((x) => x && !x.startsWith("#"))) {
        const f = l.split(/\s+/);
        rows.push({ keys: f.slice(1), line: `${f[0].padEnd(15)} ${f.slice(1).join(" ")}` });
      }
    } else return fail(`Unknown database: ${db}\nTry \`getent --help' or \`getent --usage' for more information.`, 1);
    if (!keys.length) return ok(rows.map((r) => r.line + "\n").join(""));
    let out = "";
    let code = 0;
    for (const k of keys) {
      const r = rows.find((x) => x.keys.includes(k));
      if (r) out += r.line + "\n";
      else code = 2;
    }
    return { stdout: out, stderr: "", exitCode: code };
  });

  const chage = defineCommand("chage", async (args) => {
    const p = parseArgs(args, {
      short: "liIdEmMWh",
      withValue: ["d", "E", "I", "m", "M", "W"],
      long: { list: "l", iso8601: "i", lastday: "d", expiredate: "E", inactive: "I", mindays: "m", maxdays: "M", warndays: "W" },
    });
    if (p.bad) return fail(`chage: ${p.bad.startsWith("--") ? `unrecognized option '${p.bad}'` : `invalid option -- '${p.bad}'`}\n${CHAGE_USAGE}`, 2);
    const name = p.rest[0];
    if (!name || p.rest.length > 1) return fail(CHAGE_USAGE.trimEnd(), 2);
    const u = w.user(name);
    if (!u) return fail(`chage: user '${name}' does not exist in /etc/passwd`, 1);
    const list = p.flags.has("l");
    if (w.cur.uid !== 0 && (!list || u.name !== w.cur.name)) return fail("chage: Permission denied.", 1);
    const a = w.agingOf(u);
    if (list) {
      const iso = p.flags.has("i");
      const never = "never";
      const must = "password must be changed";
      const expiry = a.lastChange === 0 ? null : a.max >= 99999 || a.max < 0 ? never : dayStr(a.lastChange + a.max, iso);
      const inactive = a.lastChange === 0 ? never : expiry === never || a.inactive < 0 ? never : dayStr(a.lastChange + a.max + a.inactive, iso);
      const rows: [string, string][] = [
        ["Last password change", a.lastChange === 0 ? must : dayStr(a.lastChange, iso)],
        ["Password expires", a.lastChange === 0 ? must : (expiry ?? never)],
        ["Password inactive", a.lastChange === 0 ? must : inactive],
        ["Account expires", a.expire < 0 ? never : dayStr(a.expire, iso)],
        ["Minimum number of days between password change", String(a.min)],
        ["Maximum number of days between password change", String(a.max)],
        ["Number of days of warning before password expires", String(a.warn)],
      ];
      // число табуляций у каждой строки зафиксировано в shadow-utils (сверено с Rocky 9)
      const tabs = [5, 5, 5, 6, 2, 2, 1];
      const out = rows.map(([k, v], i) => `${k}${"\t".repeat(tabs[i])}: ${v}\n`).join("");
      return ok(out);
    }
    if (w.cur.uid !== 0) return fail("chage: Permission denied.", 1);
    const set = (flag: string, apply: (n: number) => void, date = false): string | null => {
      if (!p.values.has(flag)) return null;
      const v = p.values.get(flag)!;
      const n = date ? parseDay(v) : /^-?\d+$/.test(v) ? Number(v) : null;
      if (n === null || (!date && n < -1)) return `chage: ${date ? "invalid date" : "invalid numeric argument"} '${v}'\n${CHAGE_USAGE}`;
      apply(n);
      return null;
    };
    for (const e of [
      set("d", (n) => (a.lastChange = n), true),
      set("E", (n) => (a.expire = n), true),
      set("I", (n) => (a.inactive = n)),
      set("m", (n) => (a.min = n)),
      set("M", (n) => (a.max = n)),
      set("W", (n) => (a.warn = n)),
    ])
      if (e) return fail(e.trimEnd(), 1);
    if (!["d", "E", "I", "m", "M", "W"].some((k) => p.values.has(k))) return fail(CHAGE_USAGE.trimEnd(), 2);
    await w.syncEtc();
    return ok();
  });

  const chpasswd = defineCommand("chpasswd", async (args, ctx) => {
    if (w.cur.uid !== 0) return fail("chpasswd: Permission denied.", 1);
    let out = "";
    let code = 0;
    const lines = bytesToText(ctx.stdin).split("\n").filter((l) => l.trim());
    lines.forEach((l, i) => {
      const k = l.indexOf(":");
      const name = k < 0 ? "" : l.slice(0, k);
      const pw = l.slice(k + 1);
      if (k < 0) {
        out += `chpasswd: line ${i + 1}: missing new password\n`;
        code = 1;
        return;
      }
      const u = w.user(name);
      if (!u) {
        out += `chpasswd: line ${i + 1}: user '${name}' does not exist\n`;
        code = 1;
        return;
      }
      u.password = pw;
      w.agingOf(u).lastChange = todayDays();
    });
    void args;
    await w.syncEtc();
    return { stdout: "", stderr: out, exitCode: code };
  });

  const groupmod = defineCommand("groupmod", async (args) => {
    if (w.cur.uid !== 0) return fail("groupmod: Permission denied.\ngroupmod: cannot lock /etc/group; try again later.", 1);
    const p = parseArgs(args, { short: "", withValue: ["n", "g"], long: { "new-name": "n", gid: "g" } });
    const name = p.rest[0];
    if (!name) return fail("Usage: groupmod [options] GROUP", 2);
    const g = w.group(name);
    if (!g) return fail(`groupmod: group '${name}' does not exist`, 6);
    if (p.values.has("g")) {
      const gid = Number(p.values.get("g"));
      if (w.groupByGid(gid) && gid !== g.gid) return fail(`groupmod: GID '${gid}' already exists`, 4);
      for (const u of w.users.values()) if (u.gid === g.gid) u.gid = gid;
      g.gid = gid;
    }
    if (p.values.has("n")) {
      const nn = p.values.get("n")!;
      if (w.group(nn)) return fail(`groupmod: group '${nn}' already exists`, 9);
      w.groups.delete(name);
      g.name = nn;
      w.groups.set(nn, g);
      for (const u of w.users.values()) u.groups = u.groups.map((x) => (x === name ? nn : x));
    }
    await w.syncEtc();
    return ok();
  });

  const visudo = defineCommand("visudo", async (args) => {
    if (w.cur.uid !== 0) return fail("visudo: /etc/sudoers: Permission denied", 1);
    const p = parseArgs(args, { short: "cqsVh", withValue: ["f"], long: { check: "c", quiet: "q", file: "f" } });
    if (p.bad) return fail(`visudo: invalid option -- '${p.bad}'`, 1);
    if (!p.flags.has("c")) return fail("visudo: интерактивный редактор в тренажёре не поддерживается. Правь файл напрямую (например, в /etc/sudoers.d/) и проверь командой `visudo -c`.", 1);
    const info = await readSudoers(w);
    let out = "";
    let bad = false;
    for (const f of info.files) {
      const errs = info.errors.filter((e) => e.file === f);
      if (errs.length) {
        bad = true;
        for (const e of errs) out += `>>> ${f}: syntax error near line ${e.line} <<<\nparse error in ${f} near line ${e.line}\n`;
        continue;
      }
      const st = await w.info(f);
      if (st && (st.mode & 0o777) !== 0o440) {
        out += `visudo: ${f}: bad permissions, should be mode 0440\n`;
        bad = true;
      }
      if (!p.flags.has("q")) out += `${f}: parsed OK\n`;
    }
    return { stdout: out, stderr: "", exitCode: bad ? 1 : 0 };
  });

  return [getent, chage, chpasswd, groupmod, visudo];
}
