import { it } from "vitest";
import { createServer, Shell } from "../src/engine/shell";
const ago = (m: number) => new Date(Date.now() - m * 60000);
it("scratch", async () => {
  const w = await createServer();
  await w.mkdir("/srv/app/releases/v2/conf", 0o755);
  await w.mkdir("/srv/app/releases/v2/bin", 0o755);
  await w.fs.symlink("releases/v2", "/srv/app/current");
  await w.mkdir("/opt/tool/releases/2.4", 0o755);
  await w.fs.symlink("releases/2.4", "/opt/tool/stable");
  await w.fs.symlink("stable", "/opt/tool/current");
  await w.mkdir("/var/log/app");
  for (const n of ["", ".1", ".2", ".3", ".9", ".10", ".11", ".12"]) await w.write("/var/log/app/app.log" + n, "x\n");
  await w.write("/srv/projects/old.txt", "x\n", 0o644, 1005, 1005);
  await w.write("/srv/drop/report.txt ", "Q3\n");
  await w.mkdir("/srv/reports");
  await w.write("/srv/reports/a.csv", "x\n"); await w.setTimes("/srv/reports/a.csv", { atime: ago(10), mtime: ago(1000) });
  await w.write("/srv/reports/b.csv", "x\n"); await w.setTimes("/srv/reports/b.csv", { atime: ago(5000), mtime: ago(100) });
  await w.write("/srv/reports/c.csv", "x\n"); await w.setTimes("/srv/reports/c.csv", { atime: ago(100), mtime: ago(10) });
  await w.mkdir("/srv/www", 0o755, 1001, 1001); await w.fs.symlink("/srv/www", "/var/www");
  const sh = new Shell(w, { user: "root", cwd: "/srv/app/current" });
  const cmds = ["pwd", "cd -P .", "pwd", "cd /srv/app/current", "cd \"$(pwd -P)\"", "pwd", "cd /srv/app/current", "cd $(realpath .)", "pwd", "readlink /opt/tool/current", "readlink -f /opt/tool/current", "realpath /opt/tool/current", "ls /var/log/app | tail -3", "ls -v /var/log/app | tail -1", "ls /var/log/app", "ls -l /srv/projects", "ls -n /srv/projects", "stat -c %u /srv/projects/old.txt", "ls /srv/drop", "ls /srv/drop | cat", "cat /srv/drop/report.txt", "ls -u /srv/reports | cat", "ls -tu /srv/reports | cat", "ls -lu /srv/reports", "ls -ltu /srv/reports", "ls -t /srv/reports | cat", "ls -ldL /var/www", "ls -ld /var/www", "stat -L -c %U /var/www", "cd /srv/app; ls -d */ | cat", "ls -F /srv/app | grep /", "ls -p /srv/app | grep /", "ls -ld /srv/app/releases", "ls -l /srv/app", "ls -s /srv/app/", "ls -d .* | cat", "ls -at /srv/app | head -2", "mv /srv/drop/report.txt* /srv/drop/report.txt; ls /srv/drop", "cd /srv/drop; ls", "echo $BACKUP/app.conf"];
  for (const c of cmds) { const r = await sh.run(c); console.log("$ " + c + "\n" + r.out.replace(/\x1b\[[0-9;]*m/g, "") + "[" + sh.cwd + "]"); }
});
