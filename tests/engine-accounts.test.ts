import { describe, expect, it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";

async function sh(user = "root") {
  const w = await createServer();
  return { s: new Shell(w, { user }), w };
}
const strip = (t: string) => t.replace(/ \w{3} [ \d]\d \d\d:\d\d/g, "");

describe("useradd / usermod / userdel", () => {
  it("useradd -m: skel, shadow с !!, почтовый ящик, группа", async () => {
    const { s } = await sh();
    expect((await s.run("useradd -m -u 1500 -c 'Al Ice' carol")).out).toBe("");
    expect((await s.run("grep carol /etc/passwd")).out).toBe("carol:x:1500:1500:Al Ice:/home/carol:/bin/bash\n");
    expect((await s.run("grep carol: /etc/shadow")).out).toMatch(/^carol:!!:\d+:0:99999:7:::\n$/);
    expect((await s.run("grep carol /etc/group")).out).toBe("carol:x:1500:\n");
    expect(strip((await s.run("ls -la /home/carol | cat")).out)).toContain(".bashrc");
    expect((await s.run("cat /home/carol/.bash_profile")).out).toContain("if [ -f ~/.bashrc ]");
    expect(strip((await s.run("ls -l /var/spool/mail/carol | cat")).out)).toBe("-rw-rw----. 1 carol mail 0 /var/spool/mail/carol\n");
  });

  it("useradd: ошибки и -r/-M/плохая оболочка", async () => {
    const { s } = await sh();
    expect((await s.run("useradd alice")).out).toBe("useradd: user 'alice' already exists\n");
    expect((await s.run("useradd -g nogrp x1")).out).toBe("useradd: group 'nogrp' does not exist\n");
    expect((await s.run("useradd -u 1000 x2")).out).toBe("useradd: UID 1000 is not unique\n");
    expect((await s.run("useradd -s /bin/nonexist q1")).out).toBe("useradd: Warning: missing or non-executable shell '/bin/nonexist'\n");
    await s.run("useradd -r svc && useradd -M nom");
    expect((await s.run("grep -E '^(svc|nom):' /etc/passwd")).out).toMatch(/^svc:x:999:999::\/var\/lib\/svc:\/sbin\/nologin\nnom:x:\d+:\d+::\/home\/nom:\/bin\/bash\n$/);
    expect((await s.run("ls -d /home/nom /home/svc")).out).toContain("cannot access");
    const { s: b } = await sh("bob");
    expect((await b.run("useradd z")).out).toContain("Permission denied.");
  });

  it("usermod -G без -a выкидывает из групп, -aG добавляет", async () => {
    const { s } = await sh();
    await s.run("groupadd dev; groupadd ops; usermod -aG wheel,dev bob");
    expect((await s.run("id bob")).out).toBe("uid=1001(bob) gid=1001(bob) groups=1001(bob),10(wheel),1002(dev)\n");
    await s.run("usermod -G ops bob");
    expect((await s.run("id -nG bob")).out).toBe("bob ops\n");
    expect((await s.run("usermod -a bob")).out).toContain("usermod: -a flag is only allowed with the -G flag");
    expect((await s.run("usermod -aG nog bob")).out).toBe("usermod: group 'nog' does not exist\n");
  });

  it("usermod -L/-U, passwd -l/-u/-S, shadow", async () => {
    const { s } = await sh();
    expect((await s.run("usermod -U bob")).out).toContain("unlocking the user's password would result in a passwordless account.");
    await s.run("echo secret | passwd --stdin bob");
    expect((await s.run("grep bob: /etc/shadow | cut -c1-7")).out).toBe("bob:$6$\n");
    await s.run("usermod -L bob");
    expect((await s.run("grep bob: /etc/shadow | cut -c1-8")).out).toBe("bob:!$6$\n");
    expect((await s.run("passwd -S bob")).out).toMatch(/^bob LK \d{4}-\d\d-\d\d 0 99999 7 -1 \(Password locked\.\)\n$/);
    await s.run("usermod -U bob");
    expect((await s.run("passwd -S bob")).out).toMatch(/^bob PS .* \(Password set, SHA512 crypt\.\)\n$/);
    expect((await s.run("passwd -l bob")).out).toBe("Locking password for user bob.\npasswd: Success\n");
    expect((await s.run("passwd -u bob")).out).toBe("Unlocking password for user bob.\npasswd: Success\n");
    expect((await s.run("ls -l /etc/shadow | cat")).out).toContain("----------.");
  });

  it("usermod -s/-l/-u и userdel -r", async () => {
    const { s } = await sh();
    await s.run("useradd -m dave");
    await s.run("usermod -s /sbin/nologin dave");
    expect((await s.run("getent passwd dave")).out).toMatch(/:\/home\/dave:\/sbin\/nologin\n$/);
    await s.run("usermod -u 1700 dave");
    expect((await s.run("stat -c '%u %U' /home/dave")).out).toBe("1700 dave\n");
    await s.run("usermod -l dave2 dave");
    expect((await s.run("id dave2 | cut -d' ' -f1")).out).toBe("uid=1700(dave2)\n");
    expect((await s.run("userdel -r dave2")).out).toBe("");
    expect((await s.run("ls /home | cat")).out).toBe("alice\nbob\n");
    expect((await s.run("grep -c dave2 /etc/passwd /etc/group /etc/shadow")).out).toBe("/etc/passwd:0\n/etc/group:0\n/etc/shadow:0\n");
    expect((await s.run("userdel nonex")).out).toBe("userdel: user 'nonex' does not exist\n");
    await s.run("useradd -m eve; rm -rf /home/eve");
    expect((await s.run("userdel -r eve")).out).toBe("userdel: eve home directory (/home/eve) not found\n");
  });

  it("chage -l и -E -M -m -W -I", async () => {
    const { s } = await sh();
    await s.run("chage -E 2027-01-01 -M 90 -m 7 -W 5 -I 10 bob");
    const out = (await s.run("chage -l bob")).out;
    expect(out).toContain("Account expires\t\t\t\t\t\t: Jan 01, 2027\n");
    expect(out).toContain("Minimum number of days between password change\t\t: 7\n");
    expect(out).toContain("Number of days of warning before password expires\t: 5\n");
    expect(out).toMatch(/Password expires\t\t\t\t\t: \w{3} \d\d, \d{4}\n/);
    expect((await s.run("grep ^bob: /etc/shadow")).out).toMatch(/^bob:!!:\d+:7:90:5:10:20819:\n$/);
    await s.run("chage -d 0 bob");
    expect((await s.run("chage -l bob | head -2")).out).toBe("Last password change\t\t\t\t\t: password must be changed\nPassword expires\t\t\t\t\t: password must be changed\n");
    expect((await s.run("chage -l nobodyx")).out).toBe("chage: user 'nobodyx' does not exist in /etc/passwd\n");
    const { s: a } = await sh("alice");
    expect((await a.run("chage -l bob")).out).toBe("chage: Permission denied.\n");
    expect((await a.run("chage -l alice | head -1")).out).toMatch(/^Last password change/);
  });

  it("getent и id", async () => {
    const { s } = await sh();
    expect((await s.run("getent passwd alice")).out).toBe("alice:x:1000:1000:Alice:/home/alice:/bin/bash\n");
    expect((await s.run("getent group wheel")).out).toBe("wheel:x:10:alice\n");
    expect((await s.run("getent passwd 1001")).out).toMatch(/^bob:/);
    expect((await s.run("getent passwd nobodyx; echo $?")).out).toBe("2\n");
    expect((await s.run("getent foo")).out).toContain("Unknown database: foo");
  });
});

describe("su: окружение, login shell, -c", () => {
  async function prepared() {
    const { s, w } = await sh();
    await s.run("useradd -m carol");
    await s.run("echo 'test1=T1' >> /home/carol/.bash_profile; echo 'test2=T2' >> /home/carol/.bashrc");
    return { s, w };
  }

  it("su user: cwd и PATH остаются, читается только .bashrc, $0=bash", async () => {
    const { s } = await prepared();
    await s.run("cd /tmp");
    await s.run("su carol");
    expect((await s.run("pwd")).out).toBe("/tmp\n");
    expect((await s.run("echo $test1-$test2")).out).toBe("-T2\n");
    expect((await s.run("echo $0")).out).toBe("bash\n");
    expect((await s.run("echo $PATH")).out).toContain("/root/.local/bin");
    expect((await s.run("whoami")).out).toBe("carol\n");
    expect((await s.run("exit")).kind).toBe("exit");
    expect((await s.run("echo $0")).out).toBe("-bash\n");
  });

  it("su - user: cwd = home, читаются .bash_profile и .bashrc, $0=-bash", async () => {
    const { s } = await prepared();
    await s.run("cd /tmp");
    await s.run("su - carol");
    expect((await s.run("pwd")).out).toBe("/home/carol\n");
    expect((await s.run("echo $test1-$test2")).out).toBe("T1-T2\n");
    expect((await s.run("echo $0")).out).toBe("-bash\n");
    expect((await s.run("echo $PATH")).out).not.toContain("/root/");
    expect((await s.run("echo $HOME $USER")).out).toBe("/home/carol carol\n");
  });

  it("su -c: touch в чужом cwd падает, у su - -c — нет", async () => {
    const { s } = await prepared();
    await s.run("mkdir /srv/x && chmod 755 /srv/x && cd /srv/x");
    expect((await s.run("su carol -c 'touch f1'")).out).toBe("touch: cannot touch 'f1': Permission denied\n");
    expect((await s.run("su - carol -c 'touch f1; pwd'")).out).toBe("/home/carol\n");
    expect((await s.run("ls -l /home/carol/f1 | cut -d' ' -f3")).out).toBe("carol\n");
    expect((await s.run("su - carol -c 'echo $test1 $0'")).out).toBe("T1 -bash\n");
    expect((await s.run("su carol -c 'echo $test1$HOME'")).out).toBe("/home/carol\n");
  });

  it("su: ошибки", async () => {
    const { s } = await prepared();
    expect((await s.run("su nobodyx")).out).toBe("su: user nobodyx does not exist or the user entry does not contain all the required fields\n");
    expect((await s.run("su - nobody")).out).toBe("This account is currently not available.\n");
  });

  it("su от обычного пользователя спрашивает пароль (интерактивно)", async () => {
    const { s, w } = await sh("alice");
    await w.setPassword("bob", "secret");
    const answers = ["wrong", "secret"];
    const asked: string[] = [];
    w.readLine = async (q) => {
      asked.push(q);
      return answers.shift() ?? null;
    };
    expect((await s.run("su bob")).out).toBe("su: Authentication failure\n");
    expect(asked).toEqual(["Password: "]);
    expect((await s.run("su - bob")).kind).toBe("su");
    expect((await s.run("whoami")).out).toBe("bob\n");
  });
});

describe("sudo: sudoers, -l, -u, visudo", () => {
  it("wheel по /etc/sudoers; не-член — отказ", async () => {
    const { s } = await sh("alice");
    expect((await s.run("sudo whoami")).out).toBe("root\n");
    const { s: b } = await sh("bob");
    expect((await b.run("sudo ls")).out).toBe("bob is not in the sudoers file.  This incident will be reported.\n");
  });

  it("sudo -l и sudoers.d с NOPASSWD", async () => {
    const { s, w } = await sh();
    await s.run("echo 'bob ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/bob; chmod 440 /etc/sudoers.d/bob");
    expect((await s.run("visudo -c")).out).toBe("/etc/sudoers: parsed OK\n/etc/sudoers.d/bob: parsed OK\n");
    await s.run("su - bob");
    const l = (await s.run("sudo -l")).out;
    expect(l).toContain("Matching Defaults entries for bob on server1:");
    expect(l).toContain("User bob may run the following commands on server1:\n    (ALL) NOPASSWD: ALL\n");
    expect((await s.run("sudo -u alice id -un")).out).toBe("alice\n");
    void w;
  });

  it("sudo -l без прав и ограниченные правила", async () => {
    const { s } = await sh();
    await s.run("echo 'bob ALL=(root) /usr/bin/systemctl' > /etc/sudoers.d/bob");
    await s.run("su - bob");
    expect((await s.run("sudo cat /etc/shadow")).out).toBe("Sorry, user bob is not allowed to execute '/bin/cat /etc/shadow' as root on server1.\n");
    expect((await s.run("sudo -l")).out).toContain("    (root) /usr/bin/systemctl\n");
  });

  it("visudo -c ловит ошибку и неверные права", async () => {
    const { s } = await sh();
    await s.run("echo 'garbage line' > /etc/sudoers.d/bad");
    expect((await s.run("visudo -c")).out).toBe("/etc/sudoers: parsed OK\n>>> /etc/sudoers.d/bad: syntax error near line 1 <<<\nparse error in /etc/sudoers.d/bad near line 1\n");
    await s.run("rm /etc/sudoers.d/bad; echo 'bob ALL=(ALL) ALL' > /etc/sudoers.d/bob");
    expect((await s.run("visudo -c")).out).toContain("visudo: /etc/sudoers.d/bob: bad permissions, should be mode 0440");
  });

  it("sudo просит пароль у пользователя с паролем и запоминает его", async () => {
    const { s, w } = await sh("alice");
    await w.setPassword("alice", "pw1");
    const asked: string[] = [];
    w.readLine = async (q) => {
      asked.push(q);
      return "pw1";
    };
    expect((await s.run("sudo whoami")).out).toBe("root\n");
    expect((await s.run("sudo whoami")).out).toBe("root\n");
    expect(asked).toEqual(["[sudo] password for alice: "]);
  });
});
