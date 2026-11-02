import { describe, expect, it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";
import { applyMode } from "../src/engine/commands/perms";

async function sh(user = "root") {
  const w = await createServer();
  return new Shell(w, { user });
}

describe("chmod applyMode", () => {
  it("octal and symbolic", () => {
    expect(applyMode("750", 0o644, false, 0o022)).toBe(0o750);
    expect(applyMode("g+w,o-rx", 0o755, true, 0o022)).toBe(0o770);
    expect(applyMode("u=rwx,g=rx,o=", 0o644, false, 0o022)).toBe(0o750);
    expect(applyMode("+x", 0o644, false, 0o022)).toBe(0o755);
    expect(applyMode("g+s", 0o755, true, 0o022)).toBe(0o2755);
    expect(applyMode("a-w", 0o664, false, 0o022)).toBe(0o444);
    expect(applyMode("o+t", 0o777, true, 0o022)).toBe(0o1777);
    expect(applyMode("755", 0o2775, true, 0o022)).toBe(0o2755);
    expect(applyMode("bad", 0o644, false, 0o022)).toBeNull();
  });
});

describe("shell", () => {
  it("prompt and cd persist", async () => {
    const s = await sh("alice");
    expect(s.prompt()).toBe("[alice@server1 ~]$ ");
    await s.run("cd /tmp");
    expect(s.prompt()).toBe("[alice@server1 tmp]$ ");
    expect((await s.run("pwd")).out).toBe("/tmp\n");
  });

  it("ls -l shows owners and modes", async () => {
    const s = await sh();
    await s.run("mkdir -p /srv/project && chown alice:wheel /srv/project && chmod 2775 /srv/project");
    const r = await s.run("ls -ld /srv/project | cat");
    expect(r.out).toMatch(/^drwxrwsr-x\. 2 alice wheel +\d+ \w{3} [ \d]\d \d\d:\d\d \/srv\/project\n$/);
  });

  it("new files get owner and umask", async () => {
    const s = await sh("alice");
    await s.run("touch f1; umask 027; touch f2; mkdir d2");
    const r = await s.run("stat -c '%a %U %G %n' f1 f2 d2");
    expect(r.out).toBe("644 alice alice f1\n640 alice alice f2\n750 alice alice d2\n");
  });

  it("setgid dir inheritance", async () => {
    const s = await sh();
    await s.run("groupadd dev; mkdir /srv/p; chgrp dev /srv/p; chmod 2775 /srv/p; usermod -aG dev alice");
    await s.run("su - alice");
    await s.run("touch /srv/p/x");
    expect((await s.run("stat -c '%U:%G' /srv/p/x")).out).toBe("alice:dev\n");
  });

  it("permission denied as regular user", async () => {
    const s = await sh("bob");
    expect((await s.run("cat /etc/shadow")).out).toBe("cat: /etc/shadow: Permission denied\n");
    expect((await s.run("ls /root")).out).toBe("ls: cannot open directory '/root': Permission denied\n");
    expect((await s.run("touch /etc/x")).out).toContain("Permission denied");
    expect((await s.run("mkdir /srv/x")).out).toBe("mkdir: cannot create directory '/srv/x': Permission denied\n");
    const r = await s.run("echo hi > /etc/y");
    expect(r.out).toContain("Permission denied");
    expect(r.code).not.toBe(0);
    expect((await s.run("chmod 777 /etc/passwd")).out).toBe("chmod: changing permissions of '/etc/passwd': Operation not permitted\n");
    expect((await s.run("chown bob /etc/passwd")).out).toBe("chown: changing ownership of '/etc/passwd': Operation not permitted\n");
  });

  it("users and groups", async () => {
    const s = await sh();
    await s.run("groupadd dev; useradd -G dev carol");
    // как в RHEL: gid=uid занят группой dev, поэтому личная группа получает следующий
    expect((await s.run("id carol")).out).toBe("uid=1002(carol) gid=1003(carol) groups=1003(carol),1002(dev)\n");
    expect((await s.run("grep carol /etc/passwd")).out).toBe("carol:x:1002:1003::/home/carol:/bin/bash\n");
    expect((await s.run("useradd carol")).out).toBe("useradd: user 'carol' already exists\n");
    expect((await s.run("ls -ld /home/carol")).out).toMatch(/^drwx------\. \d carol carol/);
  });

  it("su and exit", async () => {
    const s = await sh();
    expect((await s.run("su - alice")).kind).toBe("su");
    expect((await s.run("whoami")).out).toBe("alice\n");
    expect(s.cwd).toBe("/home/alice");
    await s.run("exit");
    expect((await s.run("whoami")).out).toBe("root\n");
  });

  it("sudo for wheel, denied for bob", async () => {
    const a = await sh("alice");
    expect((await a.run("sudo cat /etc/shadow")).code).toBe(0);
    const b = await sh("bob");
    expect((await b.run("sudo ls")).out).toContain("not in the sudoers file");
  });

  it("not found, unsupported, rm -rf /", async () => {
    const s = await sh();
    expect((await s.run("fooo")).kind).toBe("notfound");
    expect((await s.run("systemctl status sshd")).kind).toBe("unsupported");
    const r = await s.run("rm -rf /");
    expect(r.out).toContain("dangerous");
    expect(r.kind).toBe("danger");
    expect((await s.run("ls /etc")).code).toBe(0);
  });

  it("pipes and text utils work", async () => {
    const s = await sh();
    expect((await s.run("cat /etc/passwd | grep -c nologin")).out).toBe("5\n");
    expect((await s.run("ls /etc | wc -l")).out.trim()).toMatch(/^\d+$/);
  });

  it("mv and cp keep/assign owners", async () => {
    const s = await sh();
    await s.run("touch /tmp/a; chown bob /tmp/a; mv /tmp/a /srv/; cp /srv/a /srv/b");
    expect((await s.run("stat -c '%U %n' /srv/a /srv/b")).out).toBe("bob /srv/a\nroot /srv/b\n");
  });

  it("tab completion", async () => {
    const s = await sh();
    expect((await s.complete("chm")).line).toBe("chmod ");
    expect((await s.complete("ls /et")).line).toBe("ls /etc/");
    expect((await s.complete("cat /etc/pas")).line).toBe("cat /etc/passwd ");
  });
});

// ---------------------------------------------------------------------------------------------
// Файлы и каталоги: времена (atime/ctime/mtime), touch, ls, cp, mv, rm, ссылки, шаблоны имён.
// Ожидаемый вывод сверен с настоящим Rocky Linux 9 (rockylinux/rockylinux:9-ubi-init, coreutils 8.32, bash 5.1).
// ---------------------------------------------------------------------------------------------

const THIS_YEAR = String(new Date().getUTCFullYear());
const T2020 = "2020-01-01 10:00:00.000000000 +0000";

const plain = (x: string) => x.replace(/\x1b\[[0-9;]*m/g, "");

async function run(s: Shell, ...lines: string[]): Promise<string> {
  let out = "";
  for (const l of lines) out += (await s.run(l)).out;
  return out;
}

/** Каталог /tmp/t как рабочий, root. */
async function work(user = "root") {
  const s = await sh(user);
  await run(s, "mkdir -p /tmp/t && chmod 777 /tmp/t && cd /tmp/t");
  return s;
}

describe("времена файлов: atime, ctime, mtime", () => {
  it("touch -d задаёт atime и mtime, ctime — всегда «сейчас»", async () => {
    const s = await work();
    expect(await run(s, "touch -d '2020-01-01 10:00:00' a", "stat -c '%x|%y' a")).toBe(`${T2020}|${T2020}\n`);
    expect(await run(s, "stat -c %z a | cut -c1-4")).toBe(THIS_YEAR + "\n");
  });

  it("чтение обновляет только atime (relatime)", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a");
    await run(s, "cat a");
    expect(await run(s, "stat -c %x a | cut -c1-4")).toBe(THIS_YEAR + "\n");
    expect(await run(s, "stat -c %y a")).toBe(T2020 + "\n");
  });

  it("relatime: повторное чтение сразу после первого atime не трогает", async () => {
    const s = await work();
    await run(s, "touch a");
    const w = s.world;
    const t = new Date(Date.now() - 3600_000);
    await w.setTimes("/tmp/t/a", { atime: t, mtime: new Date(t.getTime() - 7200_000) });
    // ctime сейчас (setTimes), atime час назад — старше ctime, поэтому первое чтение обновляет...
    await run(s, "cat a");
    const first = (await w.info("/tmp/t/a"))!.atime.getTime();
    expect(first).toBeGreaterThan(t.getTime());
    // ...а второе уже нет: atime новее и mtime, и ctime, суток не прошло
    await new Promise((r) => setTimeout(r, 15));
    await run(s, "cat a");
    expect((await w.info("/tmp/t/a"))!.atime.getTime()).toBe(first);
  });

  it("chmod и mv меняют только ctime", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a", "chmod 600 a");
    expect(await run(s, "stat -c '%x|%y' a")).toBe(`${T2020}|${T2020}\n`);
    expect(await run(s, "stat -c %z a | cut -c1-4")).toBe(THIS_YEAR + "\n");
    await run(s, "touch -d '2020-01-01 10:00:00' b", "mv b c");
    expect(await run(s, "stat -c '%x|%y' c")).toBe(`${T2020}|${T2020}\n`);
    expect(await run(s, "stat -c %z c | cut -c1-4")).toBe(THIS_YEAR + "\n");
  });

  it("chown меняет ctime, запись — mtime и ctime", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a", "chown bob a");
    expect(await run(s, "stat -c %y a")).toBe(T2020 + "\n");
    expect(await run(s, "stat -c %z a | cut -c1-4")).toBe(THIS_YEAR + "\n");
    await run(s, "touch -d '2020-01-01 10:00:00' b", "echo hi > b");
    expect(await run(s, "stat -c %y b | cut -c1-4; stat -c %z b | cut -c1-4")).toBe(`${THIS_YEAR}\n${THIS_YEAR}\n`);
  });

  it("ls читает каталог: у каталога обновляется atime; создание файла — mtime и ctime каталога", async () => {
    const s = await work();
    await run(s, "mkdir d", "touch -d '2020-01-01 10:00:00' d");
    await run(s, "ls d");
    expect(await run(s, "stat -c %x d | cut -c1-4")).toBe(THIS_YEAR + "\n");
    await run(s, "touch -d '2020-01-01 10:00:00' d", "touch d/new");
    expect(await run(s, "stat -c %y d | cut -c1-4")).toBe(THIS_YEAR + "\n");
  });

  it("stat -c: %w/%W/%X/%Y/%Z и неизвестный формат", async () => {
    const s = await work();
    await run(s, "touch -d '@86400' a");
    expect(await run(s, "stat -c '%X %Y' a")).toBe("86400 86400\n");
    expect(await run(s, "stat -c '%w' a | cut -c1-4")).toBe(THIS_YEAR + "\n");
    expect(await run(s, "stat -c '%Q' a")).toBe("?\n");
    expect(await run(s, "stat --printf '%n|%s\\n' a")).toBe("a|0\n");
    expect(await run(s, "stat --printf '%n' a; echo X")).toBe("aX\n");
    expect(await run(s, "stat -c")).toBe("stat: option requires an argument -- 'c'\nTry 'stat --help' for more information.\n");
  });

  it("stat: полный вывод содержит все четыре времени", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a");
    const out = await run(s, "stat a");
    expect(out).toContain(`Access: ${T2020}\nModify: ${T2020}\nChange: ${THIS_YEAR}-`);
    expect(out).toMatch(/\n Birth: \d{4}-/);
  });
});

describe("touch", () => {
  it("-t в трёх форматах", async () => {
    const s = await work();
    expect(await run(s, "touch -t 202301020304.05 a", "stat -c '%x|%y' a")).toBe("2023-01-02 03:04:05.000000000 +0000|2023-01-02 03:04:05.000000000 +0000\n");
    expect(await run(s, "touch -t 202301020304 b", "stat -c '%y' b")).toBe("2023-01-02 03:04:00.000000000 +0000\n");
    expect(await run(s, "touch -t 0301020304 c", "stat -c '%y' c | cut -c1-19")).toBe("2003-01-02 03:04:00\n");
  });

  it("-r копирует atime и mtime эталона", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' r", "touch -r r a");
    expect(await run(s, "stat -c '%x|%y' a")).toBe(`${T2020}|${T2020}\n`);
  });

  it("-a и -m меняют каждое время отдельно", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a", "touch -a -d '2021-02-03 04:05:06' a");
    expect(await run(s, "stat -c '%x|%y' a")).toBe(`2021-02-03 04:05:06.000000000 +0000|${T2020}\n`);
    await run(s, "touch -d '2020-01-01 10:00:00' b", "touch -m -d '2021-02-03 04:05:06' b");
    expect(await run(s, "stat -c '%x|%y' b")).toBe(`${T2020}|2021-02-03 04:05:06.000000000 +0000\n`);
    await run(s, "touch -d '2020-01-01 10:00:00' c", "touch -am -d '2021-02-03 04:05:06' c");
    expect(await run(s, "stat -c '%x|%y' c")).toBe("2021-02-03 04:05:06.000000000 +0000|2021-02-03 04:05:06.000000000 +0000\n");
    await run(s, "touch -d '2020-01-01 10:00:00' d", "touch -a d");
    expect(await run(s, "stat -c %x d | cut -c1-4; stat -c %y d")).toBe(`${THIS_YEAR}\n${T2020}\n`);
  });

  it("-d: @секунды, yesterday, «N days ago», --date, --time=atime", async () => {
    const s = await work();
    expect(await run(s, "touch -d '@86400' a", "stat -c %y a")).toBe("1970-01-02 00:00:00.000000000 +0000\n");
    await run(s, "touch -d yesterday y", "touch -d '2 days ago' z");
    expect(await run(s, "echo $(stat -c %Y y)-$(stat -c %Y z)")).toMatch(/^\d+-\d+\n$/);
    const w = s.world;
    const y = (await w.info("/tmp/t/y"))!.mtime.getTime();
    const z = (await w.info("/tmp/t/z"))!.mtime.getTime();
    expect(Math.round((y - z) / 3600_000)).toBe(24);
    expect(await run(s, "touch --date='2020-05-05 05:05:05' b", "stat -c %y b")).toBe("2020-05-05 05:05:05.000000000 +0000\n");
    expect(await run(s, "touch --time=atime -d '2020-05-05 05:05:05' c", "stat -c %x c")).toBe("2020-05-05 05:05:05.000000000 +0000\n");
  });

  it("ошибки: нет операнда, плохая дата, нет эталона, неизвестная опция, -c, нет каталога", async () => {
    const s = await work();
    expect(await run(s, "touch")).toBe("touch: missing file operand\nTry 'touch --help' for more information.\n");
    expect(await run(s, "touch -d garbage a")).toBe("touch: invalid date format ‘garbage’\n");
    expect(await run(s, "touch -t 99 a")).toBe("touch: invalid date format ‘99’\n");
    expect(await run(s, "touch -r nofile a")).toBe("touch: failed to get attributes of 'nofile': No such file or directory\n");
    expect(await run(s, "touch -z a")).toBe("touch: invalid option -- 'z'\nTry 'touch --help' for more information.\n");
    expect(await run(s, "touch -c nofile; ls nofile")).toBe("ls: cannot access 'nofile': No such file or directory\n");
    expect(await run(s, "touch nodir/x")).toBe("touch: cannot touch 'nodir/x': No such file or directory\n");
  });

  it("обычный пользователь: чужой файл — Permission denied, с -d на доступный на запись — Operation not permitted", async () => {
    const s = await work("bob");
    await s.world.write("/tmp/t/rootfile", "", 0o644, 0, 0);
    expect(await run(s, "touch /tmp/t/rootfile")).toBe("touch: cannot touch '/tmp/t/rootfile': Permission denied\n");
    await s.world.setMode("/tmp/t/rootfile", 0o666);
    expect((await s.run("touch /tmp/t/rootfile")).code).toBe(0);
    expect(await run(s, "touch -d '2020-01-01' /tmp/t/rootfile")).toBe("touch: setting times of '/tmp/t/rootfile': Operation not permitted\n");
  });
});

describe("ls: ключи и форматы", () => {
  const mk3 = async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch -d '2020-01-01 10:00:00' a", "touch -d '2021-01-01 10:00:00' b", "touch -d '2022-01-01 10:00:00' c");
    return s;
  };

  it("-1, -1t, -ltr, сортировка по времени", async () => {
    const s = await mk3();
    expect(await run(s, "ls -1")).toBe("a\nb\nc\n");
    expect(await run(s, "ls -1t")).toBe("c\nb\na\n");
    expect(await run(s, "ls -t")).toBe("c  b  a\n");
    expect(await run(s, "ls -ltr | tail -n +2 | awk '{print $NF}'")).toBe("a\nb\nc\n");
    expect(await run(s, "ls -t --sort=none -1 | wc -l")).toBe("3\n");
  });

  it("-lu и -lc показывают atime и ctime", async () => {
    const s = await mk3();
    await run(s, "cat a > /dev/null");
    expect(await run(s, "ls -lu --time-style=long-iso | tail -n +2")).toMatch(new RegExp(`^-rw-r--r--\\.? 1 root root 0 ${THIS_YEAR}-\\d\\d-\\d\\d \\d\\d:\\d\\d a\\n-rw-r--r--\\.? 1 root root 0 2021-01-01 10:00 b\\n`));
    await run(s, "chmod 600 a");
    expect(await run(s, "ls -lc --time-style=+%Y a")).toMatch(new RegExp(`^-rw-------\\.? 1 root root 0 ${THIS_YEAR} a\\n$`));
    // без -l и без -t: -u/-c сортируют по соответствующему времени, самое новое первым
    await run(s, "touch -a -d '2030-01-01' b");
    expect(await run(s, "ls -u -1 | head -1")).toBe("b\n");
  });

  it("--full-time, --time-style", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a");
    const cut = (x: string) => x.replace(/^-rw-r--r--\.? /, "-rw-r--r-- ");
    expect(cut(await run(s, "ls -l --full-time a"))).toBe(`-rw-r--r-- 1 root root 0 ${T2020} a\n`);
    expect(cut(await run(s, "ls -l --time-style=full-iso a"))).toBe(`-rw-r--r-- 1 root root 0 ${T2020} a\n`);
    expect(cut(await run(s, "ls -l --time-style=long-iso a"))).toBe("-rw-r--r-- 1 root root 0 2020-01-01 10:00 a\n");
    expect(cut(await run(s, "ls -l --time-style=iso a"))).toBe("-rw-r--r-- 1 root root 0 2020-01-01  a\n");
    expect(cut(await run(s, "ls -l --time-style=locale a"))).toBe("-rw-r--r-- 1 root root 0 Jan  1  2020 a\n");
    expect(cut(await run(s, "ls -l --time-style=+%F a"))).toBe("-rw-r--r-- 1 root root 0 2020-01-01 a\n");
    expect(await run(s, "ls -l --time-style=bogus a")).toBe(
      "ls: invalid argument ‘bogus’ for ‘time style’\nValid arguments are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\nTry 'ls --help' for more information.\n",
    );
    await run(s, "touch -d '2026-10-01 10:00:00' r");
    // «свежий» файл в формате iso — без года; тест не привязан к сегодняшней дате: берём файл «сейчас»
    await run(s, "touch now");
    expect(await run(s, "ls -l --time-style=iso now")).toMatch(/ \d\d-\d\d \d\d:\d\d now\n$/);
  });

  it("-F, -p, -i, -s", async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch a; chmod +x a; mkdir d; ln -s a l");
    expect(plain(await run(s, "ls -F"))).toBe("a*  d/  l@\n");
    expect(plain(await run(s, "ls -p"))).toBe("a  d/  l\n");
    expect(plain(await run(s, "ls -F -d d a"))).toBe("a*  d/\n");
    expect(await run(s, "ls -i | awk '{print NF}'")).toBe("1\n1\n1\n".replace(/1/g, "2"));
    expect((await run(s, "ls -l -F | tail -n +2")).replace(/\.? /g, " ")).toMatch(/l@ -> a/);
    await run(s, "echo hello > b");
    expect(await run(s, "ls -s | head -1")).toBe("total 4\n");
    expect(await run(s, "ls -ls b | awk '{print $1}'")).toBe("4\n");
  });

  it("-n, -g, -o, -G", async () => {
    const s = await work();
    await run(s, "touch a");
    const norm = (x: string) => x.replace(/^(\S+?)\.? /, "$1 ").replace(/\d\d:\d\d/, "HH:MM").replace(/[A-Z][a-z]{2} [ \d]\d /, "Mon D ");
    expect(norm(await run(s, "ls -n a"))).toBe("-rw-r--r-- 1 0 0 0 Mon D HH:MM a\n");
    expect(norm(await run(s, "ls -g a"))).toBe("-rw-r--r-- 1 root 0 Mon D HH:MM a\n");
    expect(norm(await run(s, "ls -o a"))).toBe("-rw-r--r-- 1 root 0 Mon D HH:MM a\n");
    expect(norm(await run(s, "ls -lG a"))).toBe("-rw-r--r-- 1 root 0 Mon D HH:MM a\n");
  });

  it("-m, -x, -C, -w, -Q, -b, -q", async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch a b c");
    expect(await run(s, "ls -m")).toBe("a, b, c\n");
    expect(await run(s, "ls -x")).toBe("a  b  c\n");
    expect(await run(s, "ls -C")).toBe("a  b  c\n");
    expect(await run(s, "ls -w 5 -C")).toBe("a\nb\nc\n");
    expect(await run(s, "ls -Q")).toBe('"a"  "b"  "c"\n');
    expect(await run(s, "ls -m | cat")).toBe("a, b, c\n");
    expect(await run(s, "ls -1 | cat")).toBe("a\nb\nc\n");
    expect(await run(s, "ls -C | cat")).toBe("a  b  c\n");
  });

  it("имена с пробелами и спецсимволами: кавычки в терминале, без кавычек в канале", async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch 'a b' c \"it's\" 'x\"y' 'd$' '~t' '#h' 'e=f' 'p%q' 'n!'", "mkdir 'dir 1'");
    expect(plain(await run(s, "ls"))).toBe(`'#h'  'a b'   c  'd$'  'dir 1'  'e=f'  "it's"  'n!'   p%q  'x"y'  '~t'\n`);
    expect(plain(await run(s, "ls -1"))).toBe(`'#h'\n'a b'\nc\n'd$'\n'dir 1'\n'e=f'\n"it's"\n'n!'\np%q\n'x"y'\n'~t'\n`);
    expect(plain(await run(s, "ls | cat"))).toBe("#h\na b\nc\nd$\ndir 1\ne=f\nit's\nn!\np%q\nx\"y\n~t\n");
    expect(plain(await run(s, "ls -Q"))).toBe(`"#h"  "a b"  "c"  "d$"  "dir 1"  "e=f"  "it's"  "n!"  "p%q"  "x\\"y"  "~t"\n`);
    expect(plain(await run(s, "ls -b"))).toBe(`#h  a\\ b  c  d$  dir\\ 1  e=f  it's  n!  p%q  x"y  ~t\n`);
    expect(plain(await run(s, "ls -m"))).toBe(`'#h', 'a b', c, 'd$', 'dir 1', 'e=f', "it's", 'n!', p%q, 'x"y', '~t'\n`);
    // в длинном формате у неquoted имён появляется пробел-выравнивание
    const long = plain(await run(s, "ls -l 'a b' c")).split("\n");
    expect(long[0]).toMatch(/ 'a b'$/);
    expect(long[1]).toMatch(/ {2}c$/);
  });

  it("неверные аргументы и опции", async () => {
    const s = await work();
    expect(await run(s, "ls -z")).toBe("ls: invalid option -- 'z'\nTry 'ls --help' for more information.\n");
    expect(await run(s, "ls --bogus")).toBe("ls: unrecognized option '--bogus'\nTry 'ls --help' for more information.\n");
    expect(await run(s, "ls --sort=x")).toBe("ls: invalid argument ‘x’ for ‘--sort’\nValid arguments are:\n  - ‘none’\n  - ‘time’\n  - ‘size’\n  - ‘extension’\n  - ‘version’\nTry 'ls --help' for more information.\n");
    await run(s, "touch a");
    expect(await run(s, "ls a/")).toBe("ls: cannot access 'a/': Not a directory\n");
  });

  it("ls -a: . и .. первыми, -A без них; -d для каталога; ссылка на каталог", async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch .h a; mkdir d; ln -s d l");
    expect(plain(await run(s, "ls -a"))).toBe(".  ..  a  d  .h  l\n"); // сортировка en_US: точка в начале имени не учитывается
    expect(await run(s, "ls -A | grep -c '^\\.\\.\\?$'")).toBe("0\n");
    expect((await run(s, "ls -l l | awk '{print $NF}'")).trim()).toBe("d");
    expect(await run(s, "ls -l l/")).toBe("total 0\n");
    expect(await run(s, "ls -lL l | head -1")).toBe("total 0\n");
  });

  it("ls на битую ссылку показывает её", async () => {
    const s = await work();
    await run(s, "ln -s nofile l");
    expect(await run(s, "ls l")).toMatch(/l/);
    expect((await run(s, "ls -l l | awk '{print $NF}'")).trim()).toBe("nofile");
    expect(await run(s, "ls -L l")).toBe("ls: cannot access 'l': No such file or directory\n");
  });
});

describe("cp", () => {
  it("копия — новый файл: mtime сейчас, права по umask, владелец — копирующий", async () => {
    const s = await work();
    await run(s, "touch -d '2020-01-01 10:00:00' a", "chmod 755 a", "chown bin:daemon a", "umask 077", "cp a b");
    expect(await run(s, "stat -c '%y' b | cut -c1-4; stat -c %a b; stat -c %U:%G b")).toBe(`${THIS_YEAR}\n700\nroot:root\n`);
  });

  it("-p и -a сохраняют владельца, права и время", async () => {
    const s = await work();
    // у каждой копии свой свежий источник: чтение обновляет atime источника, а cp -p берёт его до чтения
    for (const n of "abcdef") await run(s, `touch -d '2020-01-01 10:00:00' ${n}`, `chmod 640 ${n}`, `chown bin:daemon ${n}`);
    expect(await run(s, "cp -p a a2", "stat -c '%x|%y|%a|%U:%G' a2")).toBe(`${T2020}|${T2020}|640|bin:daemon\n`);
    expect(await run(s, "cp -a b b2", "stat -c '%x|%y|%a|%U:%G' b2")).toBe(`${T2020}|${T2020}|640|bin:daemon\n`);
    expect(await run(s, "cp --preserve=timestamps c c2", "stat -c '%y|%U' c2")).toBe(`${T2020}|root\n`);
    expect(await run(s, "cp --preserve=ownership d d2", "stat -c '%a|%U:%G' d2")).toBe("640|bin:daemon\n");
    expect(await run(s, "cp --preserve=mode e e2", "stat -c '%a|%U:%G' e2")).toBe("640|root:root\n");
    expect(await run(s, "cp --preserve=all --no-preserve=ownership f f2", "stat -c '%a|%U:%G' f2")).toBe("640|root:root\n");
  });

  it("обычный пользователь с -p: владельца не меняет, группу — только свою", async () => {
    const s = await work("bob");
    await run(s, "echo x > a");
    expect(await run(s, "cp -p a b", "stat -c '%U:%G' b")).toBe("bob:bob\n");
  });

  it("cp -a копирует дерево и ссылки как ссылки", async () => {
    const s = await work();
    await run(s, "mkdir d; touch d/x; ln -s x d/l; chmod 700 d");
    expect(await run(s, "cp -a d e", "ls -l e | tail -n +2 | awk '{print $1, $NF}' | tr -d .")).toBe("lrwxrwxrwx x\n-rw-r--r-- x\n");
    expect(await run(s, "stat -c %a e")).toBe("700\n");
  });

  it("-T: источник как есть, без вложения в каталог", async () => {
    const s = await work();
    await run(s, "mkdir d e; touch d/x");
    expect(await run(s, "cp -rT d e", "ls e")).toBe("x\n");
    expect(await run(s, "ls e/d")).toBe("ls: cannot access 'e/d': No such file or directory\n");
    expect(await run(s, "touch f; mkdir g; cp -T f g")).toBe("cp: cannot overwrite directory 'g' with non-directory\n");
    expect(await run(s, "touch h; cp -T f h; echo $?")).toBe("0\n");
    expect(await run(s, "cp -T f nonexist; ls nonexist")).toBe("nonexist\n");
    expect(await run(s, "cp -T f h i")).toBe("cp: extra operand 'i'\nTry 'cp --help' for more information.\n");
    expect(await run(s, "cp -T f")).toBe("cp: missing destination file operand after 'f'\nTry 'cp --help' for more information.\n");
  });

  it("без -T cp -r в существующий каталог кладёт внутрь; `d/.` копирует содержимое", async () => {
    const s = await work();
    await run(s, "mkdir d e; touch d/x");
    expect(plain(await run(s, "cp -r d e", "ls e e/d"))).toBe("e:\nd\n\ne/d:\nx\n");
    await run(s, "mkdir g; touch d/.h");
    expect(plain(await run(s, "cp -r d/. g", "ls -A g"))).toBe(".h  x\n");
  });

  it("-t и --target-directory", async () => {
    const s = await work();
    await run(s, "touch a; mkdir e");
    expect(await run(s, "cp -t e a", "ls e")).toBe("a\n");
    expect(await run(s, "cp --target-directory=e a", "ls e")).toBe("a\n");
    expect(await run(s, "cp -t nodir a")).toBe("cp: failed to access 'nodir': No such file or directory\n");
  });

  it("ошибки: те же файлы, нет источника, каталог без -r, нет родителя, цель не каталог, мало операндов", async () => {
    const s = await work();
    await run(s, "touch a b c; ln -s a l; mkdir d");
    expect(await run(s, "cp a a")).toBe("cp: 'a' and 'a' are the same file\n");
    expect(await run(s, "cp a l")).toBe("cp: 'a' and 'l' are the same file\n");
    expect(await run(s, "cp nofile x")).toBe("cp: cannot stat 'nofile': No such file or directory\n");
    expect(await run(s, "cp d e")).toBe("cp: -r not specified; omitting directory 'd'\n");
    expect(await run(s, "cp a nodir/b")).toBe("cp: cannot create regular file 'nodir/b': No such file or directory\n");
    expect(await run(s, "cp a b c")).toBe("cp: target 'c' is not a directory\n");
    expect(await run(s, "cp")).toBe("cp: missing file operand\nTry 'cp --help' for more information.\n");
    expect(await run(s, "cp a")).toBe("cp: missing destination file operand after 'a'\nTry 'cp --help' for more information.\n");
    expect(await run(s, "cp -z a b")).toBe("cp: invalid option -- 'z'\nTry 'cp --help' for more information.\n");
    expect(await run(s, "cp -r d d/sub")).toBe("cp: cannot copy a directory, 'd', into itself, 'd/sub'\n");
  });

  it("-i, -n, -f, -u, -v, -b", async () => {
    const s = await work();
    await run(s, "echo a > a; echo b > b");
    // -i без ответа (EOF) — «нет»
    expect(await run(s, "cp -i a b < /dev/null")).toBe("cp: overwrite 'b'? ");
    expect(await run(s, "cat b")).toBe("b\n");
    expect(await run(s, "echo y | cp -i a b")).toBe("cp: overwrite 'b'? ");
    expect(await run(s, "cat b")).toBe("a\n");
    await run(s, "echo b > b");
    expect(await run(s, "cp -n a b; cat b")).toBe("b\n");
    expect(await run(s, "cp -v a c")).toBe("'a' -> 'c'\n");
    await run(s, "mkdir d; touch d/x");
    expect(await run(s, "cp -rv d e")).toBe("'d' -> 'e'\n'd/x' -> 'e/x'\n");
    await run(s, "echo old > old; sleep 0.01; touch -d '2000-01-01' older");
    expect(await run(s, "cp -u older old; cat old")).toBe("old\n");
    await run(s, "chmod 444 b");
    expect((await s.run("cp -f a b")).code).toBe(0);
    expect(await run(s, "cp -b a b; cp -b a b; ls")).toMatch(/b~/);
  });

  it("-l, -s, --parents, --attributes-only", async () => {
    const s = await work();
    await run(s, "echo hi > a; mkdir -p x/y; touch x/y/f; mkdir t");
    expect(await run(s, "cp -l a h", "stat -c %h a")).toBe("2\n");
    expect(await run(s, "cp -s $PWD/a sl", "readlink sl")).toBe("/tmp/t/a\n");
    expect(await run(s, "cp --parents x/y/f t", "find t | sort")).toBe("t\nt/x\nt/x/y\nt/x/y/f\n");
    expect(await run(s, "cp --attributes-only a z", "ls -l z | awk '{print $5}'")).toBe("0\n");
    expect(await run(s, "cp --parents a b")).toBe("cp: with --parents, the destination must be a directory\nTry 'cp --help' for more information.\n");
  });

  it("ссылки: cp l m копирует содержимое, -P/-d/-a — саму ссылку", async () => {
    const s = await work();
    await run(s, "echo hi > a; ln -s a l");
    expect(await run(s, "cp l m", "ls -l m | cut -c1")).toBe("-\n");
    expect(await run(s, "cp -P l m2", "ls -l m2 | cut -c1")).toBe("l\n");
    expect(await run(s, "cp -L l m3", "ls -l m3 | cut -c1")).toBe("-\n");
  });
});

describe("mv", () => {
  it("-v, -n, -i, -T, -t, -b и ошибки", async () => {
    const s = await work();
    await run(s, "echo a > a; echo b > b; mkdir d");
    expect(await run(s, "mv -v a c")).toBe("renamed 'a' -> 'c'\n");
    expect(await run(s, "mv -n c b; cat b")).toBe("b\n");
    expect(await run(s, "echo y | mv -i c b")).toBe("mv: overwrite 'b'? ");
    expect(await run(s, "cat b")).toBe("a\n");
    expect(await run(s, "mv nofile x")).toBe("mv: cannot stat 'nofile': No such file or directory\n");
    expect(await run(s, "mv b b")).toBe("mv: 'b' and 'b' are the same file\n");
    expect(await run(s, "mv d d/sub")).toBe("mv: cannot move 'd' to a subdirectory of itself, 'd/sub'\n");
    expect(await run(s, "touch x y; mv x y z")).toBe("mv: target 'z' is not a directory\n");
    expect(await run(s, "mv -t d x y; ls -1 d")).toBe("x\ny\n");
    expect(await run(s, "mv")).toBe("mv: missing file operand\nTry 'mv --help' for more information.\n");
    expect(await run(s, "mv b")).toBe("mv: missing destination file operand after 'b'\nTry 'mv --help' for more information.\n");
  });
});

describe("rm", () => {
  it("подсказка Try 'rm ./-x' только если такой файл существует", async () => {
    const s = await work();
    expect(await run(s, "rm -x")).toBe("rm: invalid option -- 'x'\nTry 'rm --help' for more information.\n");
    await run(s, "touch -- -x");
    expect(await run(s, "rm -x")).toBe("rm: invalid option -- 'x'\nTry 'rm ./-x' to remove the file '-x'.\nTry 'rm --help' for more information.\n");
    expect(await run(s, "rm ./-x; ls")).toBe("");
    await run(s, "touch -- -x");
    expect(await run(s, "rm -- -x; ls")).toBe("");
  });

  it("-d удаляет пустой каталог, непустой — ошибка; без -d — Is a directory", async () => {
    const s = await work();
    await run(s, "mkdir d e; touch e/x");
    expect(await run(s, "rm d")).toBe("rm: cannot remove 'd': Is a directory\n");
    expect(await run(s, "rm -d d")).toBe("");
    expect(plain(await run(s, "ls"))).toBe("e\n");
    expect(await run(s, "rm -d e")).toBe("rm: cannot remove 'e': Directory not empty\n");
  });

  it("-i: вопросы по одному, ответ из канала или EOF = нет", async () => {
    const s = await work();
    await run(s, "touch a; echo foo > f; mkdir d; touch d/x");
    expect(await run(s, "echo y | rm -i a")).toBe("rm: remove regular empty file 'a'? ");
    expect(await run(s, "ls a")).toBe("ls: cannot access 'a': No such file or directory\n");
    await run(s, "touch a");
    expect(await run(s, "rm -i a < /dev/null")).toBe("rm: remove regular empty file 'a'? ");
    expect(await run(s, "ls a")).toBe("a\n");
    expect(await run(s, "echo y | rm -i f")).toBe("rm: remove regular file 'f'? ");
    expect(await run(s, "printf 'y\\ny\\ny\\n' | rm -ri d")).toBe("rm: descend into directory 'd'? rm: remove regular empty file 'd/x'? rm: remove directory 'd'? ");
    expect(await run(s, "ls -1")).toBe("a\n");
  });

  it("-I: один вопрос, если больше трёх файлов или есть -r", async () => {
    const s = await work();
    await run(s, "touch a b c d");
    expect(await run(s, "rm -I a b c; ls")).toBe("d\n");
    await run(s, "touch a b c");
    expect(await run(s, "echo n | rm -I a b c d")).toBe("rm: remove 4 arguments? ");
    expect(await run(s, "ls -1")).toBe("a\nb\nc\nd\n");
    expect(await run(s, "echo y | rm -I a b c d")).toBe("rm: remove 4 arguments? ");
    expect(await run(s, "ls -1")).toBe("");
    await run(s, "mkdir e; touch e/x");
    expect(await run(s, "echo y | rm -I -r e")).toBe("rm: remove 1 argument recursively? ");
    expect(await run(s, "ls -1")).toBe("");
  });

  it("интерактивный вопрос в терминале: ответ приходит через world.readLine", async () => {
    const s = await work();
    await run(s, "touch a b");
    const asked: string[] = [];
    s.world.readLine = async (q) => {
      asked.push(q);
      return asked.length === 1 ? "y" : "n";
    };
    await run(s, "rm -i a b");
    s.world.readLine = null;
    expect(asked).toEqual(["rm: remove regular empty file 'a'? ", "rm: remove regular empty file 'b'? "]);
    expect(await run(s, "ls")).toBe("b\n");
  });

  it("write-protected: обычный пользователь с терминала получает вопрос, root — нет", async () => {
    const s = await work("bob");
    await run(s, "touch a; chmod 444 a");
    const asked: string[] = [];
    s.world.readLine = async (q) => (asked.push(q), "n");
    await run(s, "rm a");
    expect(asked).toEqual(["rm: remove write-protected regular empty file 'a'? "]);
    expect(await run(s, "ls a")).toBe("a\n");
    s.world.readLine = async (q) => (asked.push(q), "y");
    await run(s, "rm a");
    expect(await run(s, "ls a")).toBe("ls: cannot access 'a': No such file or directory\n");
    // без терминала (скрипт/пайп) вопроса нет
    await run(s, "touch b; chmod 444 b");
    s.world.readLine = null;
    expect((await s.run("rm b")).code).toBe(0);
  });

  it("-v печатает каждое удаление", async () => {
    const s = await work();
    await run(s, "mkdir d; touch d/x a");
    expect(await run(s, "rm -v a")).toBe("removed 'a'\n");
    expect(await run(s, "rm -rv d")).toBe("removed 'd/x'\nremoved directory 'd'\n");
  });

  it("'.' и '..' нельзя удалить рекурсивно; `rm -r .*` — ловушка", async () => {
    const s = await work();
    await run(s, "mkdir d; cd d; touch a");
    expect(await run(s, "rm -r .")).toBe("rm: refusing to remove '.' or '..' directory: skipping '.'\n");
    expect(await run(s, "rm -rf ..")).toBe("rm: refusing to remove '.' or '..' directory: skipping '..'\n");
    const r = await s.run("rm -r .*");
    expect(r.out).toBe("rm: refusing to remove '.' or '..' directory: skipping '.'\nrm: refusing to remove '.' or '..' directory: skipping '..'\n");
    expect(r.code).toBe(1);
    expect(await run(s, "ls")).toBe("a\n");
  });

  it("мелочи: нет операнда, -f, несуществующий, -r на «/»", async () => {
    const s = await work();
    expect(await run(s, "rm")).toBe("rm: missing operand\nTry 'rm --help' for more information.\n");
    expect((await s.run("rm -f")).code).toBe(0);
    expect(await run(s, "rm nofile")).toBe("rm: cannot remove 'nofile': No such file or directory\n");
    expect(await run(s, "rm -f nofile; echo $?")).toBe("0\n");
    expect(await run(s, "rm -z a")).toBe("rm: invalid option -- 'z'\nTry 'rm --help' for more information.\n");
    expect(await run(s, "rm --bogus")).toBe("rm: unrecognized option '--bogus'\nTry 'rm --help' for more information.\n");
    expect(await run(s, "rm -r /")).toBe("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
  });
});

describe("жёсткие и символические ссылки", () => {
  it("счётчик ссылок в ls -l и stat; rm одной из ссылок", async () => {
    const s = await work();
    await run(s, "touch a; ln a b; ln a c");
    expect(await run(s, "ls -l | tail -n +2 | awk '{print $2, $NF}'")).toBe("3 a\n3 b\n3 c\n");
    expect(await run(s, "stat -c '%h %n' a b")).toBe("3 a\n3 b\n");
    await run(s, "rm b");
    expect(await run(s, "stat -c %h a")).toBe("2\n");
    await run(s, "ln -s a l");
    expect(await run(s, "ls -l l | awk '{print $2}'")).toBe("1\n");
  });

  it("счётчик ссылок каталога = 2 + число подкаталогов", async () => {
    const s = await work();
    await run(s, "mkdir d");
    expect(await run(s, "ls -ld d | awk '{print $2}'")).toBe("2\n");
    await run(s, "mkdir d/e d/f");
    expect(await run(s, "ls -ld d | awk '{print $2}'")).toBe("4\n");
  });

  it("ln: ошибки как у GNU", async () => {
    const s = await work();
    await run(s, "touch a b; mkdir d");
    expect(await run(s, "ln a b")).toBe("ln: failed to create hard link 'b': File exists\n");
    expect(await run(s, "ln a")).toBe("ln: failed to create hard link './a': File exists\n");
    expect(await run(s, "ln d e")).toBe("ln: d: hard link not allowed for directory\n");
    expect(await run(s, "ln nofile x")).toBe("ln: failed to access 'nofile': No such file or directory\n");
    expect(await run(s, "ln -v a h")).toBe("'h' => 'a'\n");
    expect(await run(s, "ln -sv a l")).toBe("'l' -> 'a'\n");
    expect(await run(s, "ln -f a a")).toBe("ln: 'a' and 'a' are the same file\n");
    expect(await run(s, "ln -rs a d/l; readlink d/l")).toBe("../a\n");
  });

  it("readlink -f / -e, запись через симлинк, chmod следует по ссылке", async () => {
    const s = await work();
    await run(s, "touch a; ln -s a l; ln -s nofile bad");
    expect(await run(s, "readlink l; readlink -f l")).toBe("a\n/tmp/t/a\n");
    expect(await run(s, "readlink -f bad")).toBe("/tmp/t/nofile\n");
    expect(await run(s, "readlink -e bad; echo $?")).toBe("1\n");
    await run(s, "echo hi > l");
    expect(await run(s, "cat a")).toBe("hi\n");
    await run(s, "chmod 600 l");
    expect(await run(s, "stat -c %a a l")).toBe("600\n777\n");
  });
});

describe("шаблоны имён (glob) и подстановки", () => {
  it("`*` при файле с именем `*` раскрывается во все файлы", async () => {
    const s = await work();
    s.world.cols = 80;
    await run(s, "touch '*' a b");
    expect(await run(s, "echo *")).toBe("* a b\n");
    expect(await run(s, "echo '*'")).toBe("*\n");
    expect(plain(await run(s, "ls *"))).toBe("'*'   a   b\n");
    await run(s, "rm '*'");
    expect(await run(s, "ls")).toBe("a  b\n");
  });

  it("`*/` — только каталоги, с косой чертой", async () => {
    const s = await work();
    await run(s, "mkdir d1 d2 'd 3'; touch f");
    expect(await run(s, "echo */")).toBe("d 3/ d1/ d2/\n");
    s.world.cols = 80;
    expect(plain(await run(s, "ls -d */"))).toBe("'d 3/'   d1/   d2/\n");
    await run(s, "touch d1/x");
    expect(await run(s, "echo */*")).toBe("d1/x\n");
  });

  it("`.*` включает . и .. (bash 5.1); `.[!.]*` и `.??*` — нет", async () => {
    const s = await work();
    await run(s, "touch .h ..x a");
    expect(await run(s, "echo .*")).toBe(". .. ..x .h\n");
    expect(await run(s, "echo .[!.]*")).toBe(".h\n");
    expect(await run(s, "echo .??*")).toBe("..x\n");
    expect(await run(s, "echo *")).toBe("a\n");
  });

  it("`${VAR:?}` и `${VAR?}`: текст ошибки как у bash", async () => {
    const s = await work();
    expect(await run(s, "unset X; echo ${X:?}")).toBe("bash: X: parameter null or not set\n");
    expect(await run(s, "unset X; echo ${X?}")).toBe("bash: X: parameter not set\n");
    expect(await run(s, "unset X; echo ${X:?no value}")).toBe("bash: X: no value\n");
    expect(await run(s, "X=; echo ${X:?empty}")).toBe("bash: X: empty\n");
    expect(await run(s, "unset X; rm -rf ${X:?}/foo; echo $?")).toBe("bash: X: parameter null or not set\n");
    expect(await run(s, "X=v; echo ${X:?e}")).toBe("v\n");
  });
});
