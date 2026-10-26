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
