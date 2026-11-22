// Shell — сеанс терминала: just-bash + наш «мир», сессии su, история, Tab-дополнение.
import { Bash, getCommandNames } from "just-bash";
import type { Command } from "just-bash";
import { World } from "./world";
import type { PendingSu, User } from "./world";
import { basename, resolve } from "./path";
import { catCommand, headCommand, lsCommand, statCommand } from "./commands/files";
import { chgrpCommand, chmodCommand, chownCommand, umaskCommand } from "./commands/perms";
import { userCommands } from "./commands/users";
import { miscCommands } from "./commands/misc";
import { storageCommands } from "./commands/storage";
import { touchCommand } from "./commands/touch";
import { cpCommand, mkdirCommand, mvCommand, rmCommand } from "./commands/fileops";
import { linkCommands } from "./commands/links";
import { findCommand } from "./commands/find";
import { fileCommand } from "./commands/file";
import { tailCommand, wcCommand } from "./commands/text";
import { lsofCommand } from "./commands/lsof";
import { procCommands } from "./commands/procs";
import { syncProc } from "./procfs";
import { registerBaseServices } from "./commands/services";
import { fixGlobs } from "./globs";
import { aliasBuiltin, fixAliases, fixArgv0, fixCdP, fixTilde } from "./expand";

export type RunKind = "ok" | "error" | "notfound" | "unsupported" | "danger" | "sudo" | "clear" | "empty" | "su" | "exit";

export interface RunResult {
  out: string;
  code: number;
  kind: RunKind;
  /** Имя первой команды в строке (для реакций талисмана). */
  cmd: string;
}

const ERRNO: Record<string, string> = {
  EACCES: "Permission denied",
  EPERM: "Operation not permitted",
  ENOENT: "No such file or directory",
  EEXIST: "File exists",
  ENOTDIR: "Not a directory",
  EISDIR: "Is a directory",
  ENOTEMPTY: "Directory not empty",
  ENOSPC: "No space left on device",
  EROFS: "Read-only file system",
  EXDEV: "Invalid cross-device link",
};

/** Привести «сырые» ошибки ФС к виду, как в настоящем Linux. */
export function normalizeErrors(s: string): string {
  return s.replace(/(?:Error: )?(E[A-Z]+): [a-z ,]+?, \w+ '[^']*'/g, (m, code: string) => ERRNO[code] ?? m);
}

/** `${X:?текст}`: bash пишет «bash: X: текст» (или «X: parameter null or not set»), just-bash теряет имя переменной. */
export function fixParamErrors(line: string, stderr: string): string {
  if (!stderr.includes("bash: ")) return stderr;
  for (const m of line.matchAll(/\$\{(\w+)(:?)\?([^}$]*)\}/g)) {
    const [, name, colon, msg] = m;
    const bare = `bash: ${msg}`;
    const fixed = `bash: ${name}: ${msg || (colon ? "parameter null or not set" : "parameter not set")}`;
    const lines = stderr.split("\n");
    const i = lines.findIndex((l) => l === bare);
    if (i >= 0) {
      lines[i] = fixed;
      stderr = lines.join("\n");
    } else if (!colon && !msg) {
      // `${X?}` (без двоеточия): just-bash пишет «null or not set», bash — просто «not set»
      stderr = stderr.replace(`bash: ${name}: parameter null or not set`, `bash: ${name}: parameter not set`);
    }
  }
  return stderr;
}

/** setuid/setgid-утилиты как на Rocky 9 (passwd меняет /etc/shadow за обычного пользователя). Вызывается после создания Bash — он пишет свои заглушки в /usr/bin. */
export async function applySpecialBits(w: World): Promise<void> {
  const special: [string, number, number?][] = [
    ["/usr/bin/passwd", 0o4755], ["/usr/bin/su", 0o4755], ["/usr/bin/sudo", 0o4111], ["/usr/bin/chage", 0o4755], ["/usr/bin/gpasswd", 0o4755],
    ["/usr/bin/newgrp", 0o4755], ["/usr/bin/mount", 0o4755], ["/usr/bin/umount", 0o4755], ["/usr/sbin/unix_chkpwd", 0o4755], ["/usr/bin/write", 0o2755, 5],
  ];
  for (const [path, mode, gid] of special) {
    if (!(await w.base.exists(path))) await w.write(path, "#!/bin/bash\n# Built-in command: " + path.replace(/^.*\//, "") + "\n", mode, 0, gid ?? 0);
    else {
      await w.base.chmod(path, mode);
      if (gid) w.owners.set(path, { uid: 0, gid });
    }
  }
}

/** Сервер по умолчанию: Rocky Linux 9, пользователи root, alice (wheel), bob. */
export async function createServer(): Promise<World> {
  const w = new World();
  const sys: [string, number][] = [
    ["root", 0], ["bin", 1], ["daemon", 2], ["sys", 3], ["adm", 4], ["tty", 5], ["disk", 6], ["wheel", 10],
    ["users", 100], ["mail", 12], ["sshd", 74], ["nobody", 65534],
  ];
  for (const [name, gid] of sys) w.addGroup(name, gid);
  await w.mkdir("/root", 0o550);
  await w.mkdir("/home", 0o755);
  await w.mkdir("/tmp", 0o1777);
  await w.mkdir("/var/tmp", 0o1777);
  for (const d of ["/etc", "/srv", "/opt", "/mnt", "/var/log", "/usr/bin", "/usr/sbin", "/usr/share/doc", "/boot", "/media"]) await w.mkdir(d);
  // usrmerge, как в Rocky 9: /bin, /sbin, /lib, /lib64 — символические ссылки в /usr
  for (const [lnk, tgt] of [["bin", "bin"], ["sbin", "sbin"], ["lib", "lib"], ["lib64", "lib64"]]) {
    await w.mkdir(`/usr/${tgt}`);
    for (const e of (await w.base.exists(`/${lnk}`)) ? await w.base.readdir(`/${lnk}`) : []) {
      if (!(await w.base.exists(`/usr/${tgt}/${e}`))) await w.base.writeFile(`/usr/${tgt}/${e}`, await w.base.readFile(`/${lnk}/${e}`));
    }
    await w.base.rm(`/${lnk}`, { recursive: true, force: true });
    await w.base.symlink(`usr/${tgt}`, `/${lnk}`);
  }
  await w.mkdir("/var/spool/mail", 0o775);
  await w.mkdir("/etc/skel", 0o755);
  await w.mkdir("/etc/sudoers.d", 0o750);
  await w.write("/etc/skel/.bash_logout", "# ~/.bash_logout\n", 0o644);
  await w.write("/etc/skel/.bash_profile", "# .bash_profile\n\n# Get the aliases and functions\nif [ -f ~/.bashrc ]; then\n\t. ~/.bashrc\nfi\n\n# User specific environment and startup programs\n", 0o644);
  await w.write(
    "/etc/skel/.bashrc",
    '# .bashrc\n\n# Source global definitions\nif [ -f /etc/bashrc ]; then\n\t. /etc/bashrc\nfi\n\n# User specific environment\nif ! [[ "$PATH" =~ "$HOME/.local/bin:$HOME/bin:" ]]\nthen\n    PATH="$HOME/.local/bin:$HOME/bin:$PATH"\nfi\nexport PATH\n\n# Uncomment the following line if you don\'t like systemctl\'s auto-paging feature:\n# export SYSTEMD_PAGER=\n\n# User specific aliases and functions\nif [ -d ~/.bashrc.d ]; then\n\tfor rc in ~/.bashrc.d/*; do\n\t\tif [ -f "$rc" ]; then\n\t\t\t. "$rc"\n\t\tfi\n\tdone\nfi\n\nunset rc\n',
    0o644,
  );
  await w.write("/etc/profile", "# /etc/profile\n\n# System wide environment and startup programs, for login setup\n# Functions and aliases go in /etc/bashrc\n\nHISTSIZE=1000\nexport HISTSIZE\n", 0o644);
  await w.write("/etc/bashrc", "# /etc/bashrc\n\n# System wide functions and aliases\n# Environment stuff goes in /etc/profile\n", 0o644);
  await w.write(
    "/etc/login.defs",
    "MAIL_DIR\t/var/spool/mail\nUMASK\t\t022\nHOME_MODE\t0700\nPASS_MAX_DAYS\t99999\nPASS_MIN_DAYS\t0\nPASS_WARN_AGE\t7\nUID_MIN                  1000\nUID_MAX                 60000\nSYS_UID_MIN               201\nSYS_UID_MAX               999\nGID_MIN                  1000\nGID_MAX                 60000\nSYS_GID_MIN               201\nSYS_GID_MAX               999\nENCRYPT_METHOD SHA512\nUSERGROUPS_ENAB yes\nCREATE_HOME\tyes\n",
    0o644,
  );
  await w.write("/etc/sudoers", "## Sudoers allows particular users to run various commands as\n## the root user, without needing the root password.\n\nroot\tALL=(ALL) \tALL\n\n## Allows people in group wheel to run all commands\n%wheel\tALL=(ALL)\tALL\n\n## Read drop-in files from /etc/sudoers.d (the # here does not mean a comment)\n#includedir /etc/sudoers.d\n", 0o440);
  await w.addUser("root", { uid: 0, gid: 0, home: "/root", comment: "root", createHome: false });
  await w.addUser("bin", { uid: 1, gid: 1, home: "/bin", shell: "/sbin/nologin", comment: "bin", createHome: false });
  await w.addUser("daemon", { uid: 2, gid: 2, home: "/sbin", shell: "/sbin/nologin", comment: "daemon", createHome: false });
  await w.addUser("adm", { uid: 3, gid: 4, home: "/var/adm", shell: "/sbin/nologin", comment: "adm", createHome: false });
  await w.addUser("sshd", { uid: 74, gid: 74, home: "/usr/share/empty.sshd", shell: "/sbin/nologin", comment: "Privilege-separated SSH", createHome: false });
  await w.addUser("nobody", { uid: 65534, gid: 65534, home: "/", shell: "/sbin/nologin", comment: "Kernel Overflow User", createHome: false });
  await w.addUser("alice", { uid: 1000, groups: ["wheel"], comment: "Alice" });
  await w.addUser("bob", { uid: 1001, comment: "Bob" });
  for (const f of [".bash_profile", ".bashrc"]) await w.write(`/root/${f}`, `# ${f}\n`, 0o644);
  await w.write("/root/anaconda-ks.cfg", "#version=RHEL9\ntext\nreboot\n", 0o600);
  await w.write("/etc/hostname", w.hostname + "\n");
  await w.write("/etc/redhat-release", "Rocky Linux release 9.6 (Blue Onyx)\n");
  await w.write(
    "/etc/os-release",
    'NAME="Rocky Linux"\nVERSION="9.6 (Blue Onyx)"\nID="rocky"\nID_LIKE="rhel centos fedora"\nVERSION_ID="9.6"\nPRETTY_NAME="Rocky Linux 9.6 (Blue Onyx)"\n',
  );
  await w.write("/etc/hosts", "127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n");
  await w.write("/etc/motd", "");
  await w.write("/var/log/messages", "Oct 26 08:00:01 server1 systemd[1]: Started Session 1 of User root.\n", 0o600);
  await w.write("/var/log/secure", "Oct 26 08:00:01 server1 sshd[812]: Accepted publickey for alice\n", 0o600);
  await w.storage.init(); // диски, ФС, /etc/fstab, /dev, /proc/mounts
  registerBaseServices(w);
  return w;
}

interface Frame {
  argv0: string;
  user: string;
  env: Record<string, string>;
  login: boolean;
}

export class Shell {
  readonly bash: Bash;
  env: Record<string, string>;
  history: string[] = [];
  private stack: Frame[] = [];
  /** set -o noclobber включён (переживает строки терминала). */
  private noclobber = false;
  /** alias name='...' (переживают строки терминала, как в интерактивном bash). */
  private aliases = new Map<string, string>();
  /** $0 сессии: «-bash» у login shell, «bash» после su без дефиса. */
  private argv0 = "-bash";
  private names: string[];

  constructor(
    readonly world: World,
    opts: { user?: string; cwd?: string; onUnsupported?: (name: string) => void; onNotFound?: (name: string) => void } = {},
  ) {
    this.onNotFound = opts.onNotFound ?? (() => {});
    const custom: Command[] = [
      lsCommand(world),
      statCommand(world),
      catCommand(world),
      chmodCommand(world),
      chownCommand(world),
      chgrpCommand(world),
      umaskCommand(world),
      touchCommand(world),
      rmCommand(world),
      mkdirCommand(world),
      findCommand(world),
      headCommand(world),
      cpCommand(world),
      mvCommand(world),
      ...linkCommands(world),
      ...userCommands(world),
      ...miscCommands(world, opts.onUnsupported ?? (() => {})),
      lsofCommand(world),
      fileCommand(world),
      tailCommand(world),
      wcCommand(world),
      // ps/pgrep/pkill/pidof/kill/killall — на модели процессов (procs.ts); jobs/nice/top требуют отдельной интеграции с оболочкой
      ...procCommands(world, opts.onUnsupported ?? (() => {})).filter((c) => ["ps", "pgrep", "pkill", "pidof", "kill", "killall"].includes(c.name)),
      ...storageCommands(world, opts.onUnsupported ?? (() => {})),
    ];
    world.current = "root";
    const user = world.user(opts.user ?? "root")!;
    const cwd = opts.cwd ?? user.home;
    this.env = this.loginEnv(user, cwd);
    this.bash = new Bash({
      fs: world.fs,
      cwd,
      env: this.env,
      customCommands: custom,
      executionLimits: { maxLoopIterations: 5000, maxCommandCount: 5000, maxCallDepth: 50 },
    });
    this.ready = applySpecialBits(world);
    world.current = user.name;
    world.shellPid = world.procs.login(user.name);
    this.names = [...new Set([...getCommandNames(), ...custom.map((c) => c.name), "cd", "export", "history", "exit", "type"])]
      .filter((n) => !["python", "python3", "js-exec", "sqlite3", "html-to-markdown", "xan", "rg"].includes(n))
      .sort();
  }

  private onNotFound: (name: string) => void;
  private ready: Promise<void> = Promise.resolve();

  private loginEnv(u: User, cwd: string): Record<string, string> {
    return {
      HOME: u.home,
      USER: u.name,
      LOGNAME: u.name,
      SHELL: u.shell,
      PATH: u.uid === 0 ? "/root/.local/bin:/root/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin" : `${u.home}/.local/bin:${u.home}/bin:/usr/local/bin:/usr/bin`,
      HOSTNAME: this.world.hostname,
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      PWD: cwd,
    };
  }

  get cwd(): string {
    return this.env.PWD || "/";
  }

  get user(): User {
    return this.world.cur;
  }

  /** Приглашение как в RHEL: [alice@server1 ~]$ */
  prompt(): string {
    const u = this.user;
    const home = this.env.HOME;
    const dir = this.cwd === home ? "~" : basename(this.cwd);
    return `[${u.name}@${this.world.hostname.split(".")[0]} ${dir}]${u.uid === 0 ? "#" : "$"} `;
  }

  async run(line: string): Promise<RunResult> {
    await this.ready;
    const trimmed = line.trim();
    const cmd = (/^(?:sudo\s+)?(\S+)/.exec(trimmed)?.[1] ?? "").replace(/^.*\//, "");
    if (!trimmed) return { out: "", code: 0, kind: "empty", cmd };
    this.history.push(trimmed);

    if (/^(exit|logout)(\s+\d+)?$/.test(trimmed)) {
      const frame = this.stack.pop();
      if (!frame) return { out: "тренажёр: это основная сессия, выходить некуда 🙂\n", code: 1, kind: "error", cmd };
      this.world.current = frame.user;
      this.env = frame.env;
      this.argv0 = frame.argv0;
      return { out: frame.login ? "logout\n" : "", code: 0, kind: "exit", cmd };
    }
    if (/:\(\)\s*\{/.test(trimmed)) {
      return { out: "тренажёр: форк-бомба обезврежена. Палыч поседел (ещё сильнее).\n", code: 1, kind: "danger", cmd };
    }
    if (trimmed === "history" || /^history\s+-c$/.test(trimmed)) {
      if (trimmed.endsWith("-c")) this.history = [];
      const out = this.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join("\n");
      return { out: out ? out + "\n" : "", code: 0, kind: "ok", cmd };
    }

    const ab = aliasBuiltin(this.aliases, trimmed);
    if (ab) return { out: ab.out, code: ab.code, kind: ab.code ? "error" : "ok", cmd };

    const w = this.world;
    w.tty = !/[|>]/.test(trimmed.replace(/'[^']*'|"[^"]*"/g, ""));
    w.pendingSu = null;
    w.unsupported = [];
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      // set -o noclobber живёт между строками (just-bash изолирует каждый exec): запоминаем и подставляем в начало
      const clobberOn = [...trimmed.matchAll(/(?:^|[;&|]\s*)set\s+(-[a-zA-Z]*C[a-zA-Z]*|\+[a-zA-Z]*C[a-zA-Z]*|-o\s+noclobber|\+o\s+noclobber)(?=\s|;|&|\||$)/g)].map((m) => m[1].startsWith("-"));
      const prefix = this.noclobber ? "set -C\n" : "";
      await syncProc(w);
      w.activatePaths();
      const r = await this.bash.exec(prefix + (await fixGlobs(w, this.cwd, fixCdP(fixTilde(w, fixAliases(this.aliases, fixArgv0(trimmed, this.argv0))), this.cwd), this.env)), { cwd: this.cwd, env: this.env });
      if (clobberOn.length) this.noclobber = clobberOn[clobberOn.length - 1];
      stdout = r.stdout;
      stderr = r.stderr;
      code = r.exitCode;
      this.env = { ...r.env };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const m = /^E[A-Z]+: [a-z ,]+?, \w+ '([^']*)'/.exec(msg);
      stderr = m ? `bash: ${m[1]}: ${ERRNO[msg.slice(0, msg.indexOf(":"))] ?? msg}\n` : `bash: ${msg}\n`;
      code = 1;
    }

    let kind: RunKind = code === 0 ? "ok" : "error";
    // su/sudo -i выставляют pendingSu во время exec
    const pending = w.pendingSu as PendingSu | null;
    if (pending) {
      const target = w.user(pending.user)!;
      this.stack.push({ user: w.current, env: this.env, login: pending.login, argv0: this.argv0 });
      w.current = target.name;
      const prevEnv = this.env;
      this.env = pending.login
        ? this.loginEnv(target, target.home)
        : { ...prevEnv, HOME: target.home, USER: target.name, LOGNAME: target.name, SHELL: target.shell };
      this.argv0 = pending.login ? "-bash" : "bash";
      w.pendingSu = null;
      // как настоящий bash: login — /etc/profile и ~/.bash_profile (он зовёт ~/.bashrc), без login — только ~/.bashrc
      const init = pending.login ? "[ -f /etc/profile ] && . /etc/profile; [ -f ~/.bash_profile ] && . ~/.bash_profile" : "[ -f ~/.bashrc ] && . ~/.bashrc";
      try {
        const ir = await this.bash.exec(init, { cwd: this.env.PWD || target.home, env: this.env });
        this.env = { ...ir.env, PWD: this.env.PWD };
      } catch {
        /* битый rc-файл не должен ломать su */
      }
      kind = "su";
    }
    stderr = fixParamErrors(trimmed, normalizeErrors(stderr));
    const nf = /(?:^|\n)bash: (?:line \d+: )?([^:\s]+): command not found/.exec(stderr);
    if (nf) {
      this.onNotFound(nf[1]);
      kind = "notfound";
    }
    if (w.unsupported.length) kind = "unsupported";
    if (trimmed === "clear") kind = "clear";
    else if (/^sudo\s/.test(trimmed) && code === 0) kind = "sudo";
    if (/\brm\s+(-\S+\s+)*(\/|\/\*)(\s|$)/.test(trimmed) || /chmod\s+(-R\s+)?777\s+\/(\s|$)/.test(trimmed)) kind = "danger";
    return { out: stdout + stderr, code, kind, cmd };
  }

  /** Tab-дополнение: команды в начале строки, пути — дальше. */
  async complete(line: string): Promise<{ line: string; options: string[] }> {
    const word = /(\S*)$/.exec(line)![1];
    const before = line.slice(0, line.length - word.length);
    const isCmd = !before.trim() || /(?:[|;&]|\bsudo)\s*$/.test(before);
    let cands: string[] = [];
    if (isCmd && !word.includes("/")) {
      cands = this.names.filter((n) => n.startsWith(word));
    } else {
      const slash = word.lastIndexOf("/");
      const dirPart = slash >= 0 ? word.slice(0, slash + 1) : "";
      const prefix = word.slice(slash + 1);
      const dirReal = dirPart.startsWith("~") ? this.env.HOME + dirPart.slice(1) : dirPart;
      const abs = resolve(this.cwd, dirReal || ".");
      try {
        const names = await this.world.base.readdir(abs);
        for (const n of names.sort()) {
          if (!n.startsWith(prefix) || (n.startsWith(".") && !prefix.startsWith("."))) continue;
          const inf = await this.world.info(resolve(abs, n), true);
          cands.push(dirPart + n + (inf?.isDir ? "/" : ""));
        }
      } catch {
        /* нет каталога */
      }
    }
    if (!cands.length) return { line, options: [] };
    if (cands.length === 1) {
      const c = cands[0];
      return { line: before + c + (c.endsWith("/") ? "" : " "), options: [] };
    }
    let common = cands[0];
    for (const c of cands) while (!c.startsWith(common)) common = common.slice(0, -1);
    const show = cands.map((c) => c.replace(/^.*\/(?=.)/, ""));
    return { line: before + (common.length > word.length ? common : word), options: show };
  }
}
