import { describe, expect, it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";

async function mk() {
  const w = await createServer();
  return { w, s: new Shell(w, { user: "root" }) };
}

describe("storage", () => {
  it("df -h header", async () => {
    const { s } = await mk();
    const o = (await s.run("df -h")).out;
    expect(o.split("\n")[0]).toMatch(/^Filesystem\s+Size\s+Used\s+Avail\s+Use%\s+Mounted on$/);
  });
  it("du -sh sees big file, sort -h | head works", async () => {
    const { w, s } = await mk();
    await w.storage.createFile("/var/log/big/huge.log", "500M");
    const o = (await s.run("du -sh /var/log/big")).out;
    expect(o).toMatch(/^501?M?|^500M\s+\/var\/log\/big/);
    expect(o).toContain("/var/log/big");
    const t = (await s.run("du -h /var/log | sort -h | tail -n 1")).out;
    expect(t).toContain("/var/log");
  });
  it("du sees growth", async () => {
    const { w, s } = await mk();
    const before = parseInt((await s.run("du -s /var")).out);
    await w.storage.createFile("/var/grow.bin", "100M");
    const after = parseInt((await s.run("du -s /var")).out);
    expect(after - before).toBeGreaterThanOrEqual(100 * 1024);
  });
  it("lsblk shows vda and vdb", async () => {
    const { s } = await mk();
    const o = (await s.run("lsblk")).out;
    expect(o).toMatch(/^NAME\s+MAJ:MIN/);
    expect(o).toContain("vda");
    expect(o).toContain("vdb");
  });
  it("mount + df shows new fs", async () => {
    const { w, s } = await mk();
    await w.storage.addDisk("vdd", "1G");
    await w.storage.mkfs("/dev/vdd", "xfs");
    await s.run("mkdir /data");
    const r = await s.run("mount /dev/vdd /data");
    expect(r.out).toBe("");
    expect((await s.run("df -h /data")).out).toContain("/data");
    expect((await s.run("findmnt /data")).out).toContain("/dev/vdd");
    await s.run("umount /data");
    expect((await s.run("df -h /data")).out).not.toMatch(/vdd/);
  });
});
