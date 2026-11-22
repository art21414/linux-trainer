import { describe, expect, it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";

async function two() {
  const w = await createServer();
  return { w, root: new Shell(w, { user: "root" }) };
}

describe("ACL: setfacl / getfacl", () => {
  it("getfacl базового файла и setfacl -m u: с маской и ls -l '+'", async () => {
    const { root: s } = await two();
    await s.run("cd /tmp && touch f && chmod 640 f");
    expect((await s.run("getfacl f")).out).toBe("# file: f\n# owner: root\n# group: root\nuser::rw-\ngroup::r--\nother::---\n\n");
    await s.run("setfacl -m u:alice:rw f");
    expect((await s.run("getfacl f")).out).toBe("# file: f\n# owner: root\n# group: root\nuser::rw-\nuser:alice:rw-\ngroup::r--\nmask::rw-\nother::---\n\n");
    expect((await s.run("ls -l f | cut -c1-11")).out).toBe("-rw-rw----+\n");
    expect((await s.run("stat -c '%a %A' f")).out).toBe("660 -rw-rw----\n");
  });

  it("маска ограничивает (#effective), chmod g меняет маску, -x и -b", async () => {
    const { root: s } = await two();
    await s.run("cd /tmp && touch f && chmod 640 f && setfacl -m u:alice:rw,g:wheel:r,m::r f");
    expect((await s.run("getfacl -c f")).out).toContain("user:alice:rw-\t#effective:r--\n");
    await s.run("setfacl -m u:bob:rwx f");
    expect((await s.run("getfacl -c f")).out).toContain("mask::rwx\n");
    await s.run("chmod 600 f");
    expect((await s.run("getfacl -c f")).out).toContain("user:bob:rwx\t#effective:---\n");
    expect((await s.run("getfacl -c f")).out).toContain("mask::---\n");
    await s.run("chmod 640 f; setfacl -x u:alice f; setfacl -x u:bob f; setfacl -x g:wheel f");
    expect((await s.run("ls -l f | cut -c1-11")).out).toBe("-rw-r-----.\n");
    await s.run("setfacl -m u:alice:r f; setfacl -b f");
    expect((await s.run("getfacl -c f")).out).toBe("user::rw-\ngroup::r--\nother::---\n\n");
  });

  it("доступ мира учитывает ACL и маску", async () => {
    const { w, root } = await two();
    await root.run("cd /tmp && echo secret > f && chmod 600 f && chown root:root f");
    void w;
    const asBob = async (cmd: string) => {
      await root.run("su bob");
      const r = await root.run(cmd);
      await root.run("exit");
      return r;
    };
    expect((await asBob("cat /tmp/f")).out).toBe("cat: /tmp/f: Permission denied\n");
    await root.run("setfacl -m u:bob:r /tmp/f");
    expect((await asBob("cat /tmp/f")).out).toBe("secret\n");
    expect((await asBob("echo x >> /tmp/f")).out).toContain("Permission denied");
    await root.run("setfacl -m m::- /tmp/f");
    expect((await asBob("cat /tmp/f")).out).toBe("cat: /tmp/f: Permission denied\n");
  });

  it("default ACL наследуется новыми файлами и каталогами; umask не применяется", async () => {
    const { w, root } = await two();
    await root.run("mkdir /srv/team && chmod 777 /srv/team && setfacl -d -m u:alice:rwx /srv/team");
    expect((await root.run("getfacl -p /srv/team")).out).toBe(
      "# file: /srv/team\n# owner: root\n# group: root\nuser::rwx\ngroup::rwx\nother::rwx\ndefault:user::rwx\ndefault:user:alice:rwx\ndefault:group::rwx\ndefault:mask::rwx\ndefault:other::rwx\n\n",
    );
    void w;
    await root.run("su bob");
    await root.run("touch /srv/team/n; mkdir /srv/team/d");
    await root.run("exit");
    expect((await root.run("getfacl -pc /srv/team/n")).out).toBe("user::rw-\nuser:alice:rwx\t#effective:rw-\ngroup::rwx\t#effective:rw-\nmask::rw-\nother::rw-\n\n");
    expect((await root.run("getfacl -pc /srv/team/d")).out).toContain("default:user:alice:rwx\n");
    expect((await root.run("ls -ld /srv/team/d | cut -c1-11")).out).toBe("drwxrwxrwx+\n");
  });

  it("-R, ошибки, cp -p сохраняет ACL, cp без -p — нет", async () => {
    const { root: s } = await two();
    await s.run("mkdir -p /tmp/t/sub && touch /tmp/t/sub/x && cd /tmp/t && setfacl -R -m u:alice:r .");
    expect((await s.run("getfacl -c sub/x | head -2")).out).toBe("user::rw-\nuser:alice:r--\n");
    expect((await s.run("setfacl -m u:nobodyx:r sub/x")).out).toBe("setfacl: Option -m: Invalid argument near character 3\n");
    expect((await s.run("setfacl -m u:alice:r nonex")).out).toBe("setfacl: nonex: No such file or directory\n");
    expect((await s.run("setfacl -m d:u:alice:r sub/x")).out).toBe("setfacl: sub/x: Only directories can have default ACLs\n");
    await s.run("cp sub/x y; cp -p sub/x z");
    expect((await s.run("ls -l y z | cut -c1-11")).out).toBe("-rw-r--r--.\n-rw-r--r--+\n");
    expect((await s.run("getfacl -c z | sed -n 2p")).out).toBe("user:alice:r--\n");
    await s.run("mv z z2");
    expect((await s.run("getfacl -c z2 | sed -n 2p")).out).toBe("user:alice:r--\n");
  });
});
