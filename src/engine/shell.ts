// Shell — сеанс терминала: just-bash + наш «мир», сессии su, история, Tab-дополнение.
import { Bash, getCommandNames } from "just-bash";
import type { Command } from "just-bash";
import { World } from "./world";
import type { PendingSu, User } from "./world";
import { basename, resolve } from "./path";
import { catCommand, lsCommand, statCommand } from "./commands/files";
import { chgrpCommand, chmodCommand, chownCommand, umaskCommand } from "./commands/perms";
import { userCommands } from "./commands/users";
import { miscCommands } from "./commands/misc";

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
};

/** Привести «сырые» ошибки ФС к виду, как в настоящем Linux. */
export function normalizeErrors(s: string): string {
  return s.replace(/(?:Error: )?(E[A-Z]+): [a-z ,]+?, \w+ '[^']*'/g, (m, code: string) => ERRNO[code] ?? m);
}

/** Сервер по умолчанию: Rocky Linux 9, пользователи root, alice (wheel), bob. */
export async function createServer(): Promise<World> {
  const w = new World();
  const sys: [string, number][] = [
    ["root", 0], ["bin", 1], ["daemon", 2], ["sys", 3], ["adm", 4], ["tty", 5], ["disk", 6], ["wheel", 10],
    ["users", 100], ["sshd", 74], ["nobody", 65534],
  ];
  for (const [name, gid] of sys) w.addGroup(name, gid);
  await w.mkdir("/root", 0o550);
  await w.mkdir("/home", 0o755);
  await w.mkdir("/tmp", 0o1777);
  await w.mkdir("/var/tmp", 0o1777);
  for (const d of ["/etc", "/srv", "/opt", "/mnt", "/var/log", "/usr/bin", "/usr/sbin", "/usr/share/doc", "/boot", "/media"]) await w.mkdir(d);
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
  await w.write("/etc/shadow", "root:!::0:99999:7:::\nalice:$6$xyz::0:99999:7:::\nbob:$6$abc::0:99999:7:::\n", 0o000);
  await w.write("/etc/hosts", "127.0.0.1   localhost localhost.localdomain\n::1         localhost localhost.localdomain\n");
  await w.write(
    "/etc/fstab",
    "/dev/mapper/rl-root     /                       xfs     defaults        0 0\nUUID=3c6d1e2a-boot      /boot                   xfs     defaults        0 0\n/dev/mapper/rl-swap     none                    swap    defaults        0 0\n",
  );
  await w.write("/etc/motd", "");
  await w.write("/var/log/messages", "Oct 26 08:00:01 server1 systemd[1]: Started Session 1 of User root.\n", 0o600);
  await w.write("/var/log/secure", "Oct 26 08:00:01 server1 sshd[812]: Accepted publickey for alice\n", 0o600);
  return w;
}

interface Frame {
  user: string;
  env: Record<string, string>;
  login: boolean;
}

export class Shell {
  readonly bash: Bash;
  env: Record<string, string>;
  history: string[] = [];
  private stack: Frame[] = [];
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
      ...userCommands(world),
      ...miscCommands(world, opts.onUnsupported ?? (() => {})),
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
    world.current = user.name;
    this.names = [...new Set([...getCommandNames(), ...custom.map((c) => c.name), "cd", "export", "history", "exit", "type"])]
      .filter((n) => !["python", "python3", "js-exec", "sqlite3", "html-to-markdown", "xan", "rg"].includes(n))
      .sort();
  }

  private onNotFound: (name: string) => void;

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
    const trimmed = line.trim();
    const cmd = (/^(?:sudo\s+)?(\S+)/.exec(trimmed)?.[1] ?? "").replace(/^.*\//, "");
    if (!trimmed) return { out: "", code: 0, kind: "empty", cmd };
    this.history.push(trimmed);

    if (/^(exit|logout)(\s+\d+)?$/.test(trimmed)) {
      const frame = this.stack.pop();
      if (!frame) return { out: "тренажёр: это основная сессия, выходить некуда 🙂\n", code: 1, kind: "error", cmd };
      this.world.current = frame.user;
      this.env = frame.env;
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

    const w = this.world;
    w.tty = !/[|>]/.test(trimmed.replace(/'[^']*'|"[^"]*"/g, ""));
    w.pendingSu = null;
    w.unsupported = [];
    let stdout = "";
    let stderr = "";
    let code = 0;
    try {
      const r = await this.bash.exec(trimmed, { cwd: this.cwd, env: this.env });
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
      this.stack.push({ user: w.current, env: this.env, login: pending.login });
      w.current = target.name;
      this.env = this.loginEnv(target, pending.login ? target.home : this.cwd);
      w.pendingSu = null;
      kind = "su";
    }
    stderr = normalizeErrors(stderr);
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
