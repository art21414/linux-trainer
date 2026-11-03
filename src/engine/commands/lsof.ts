// lsof (4.94): открытые файлы процессов из модели мира — cwd/rtd/txt, дескрипторы (World.files) и удалённые-но-открытые
// файлы (`lsof +L1`). Формат колонок сверен с настоящим lsof 4.95; на Rocky 9 пакета lsof в тестовом образе нет —
// помечено «по докам и образцу».
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { normalize, resolve } from "../path";
import { fail } from "../util";

interface Row {
  comm: string;
  pid: number;
  user: string;
  fd: string;
  acc: string;
  type: string;
  device: string;
  size: string;
  nlink: string;
  node: string;
  name: string;
  /** Путь файла (для фильтра по пути/ФС), без « (deleted)». */
  path: string;
  uid: number;
  deleted: boolean;
}

export function lsofCommand(w: World): Command {
  return defineCommand("lsof", async (args, ctx) => {
    // -p 1,2  -u user  -c cmd  -d fd  -a  -t  -n -P -w (игнорируем)  +L1 / +L  путь…
    let showNlink = false;
    let onlyDeleted = false;
    let terse = false;
    let andMode = false;
    const pids: number[] = [];
    const users: string[] = [];
    const cmds: string[] = [];
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "+L1" || a === "+L") {
        showNlink = true;
        onlyDeleted = a === "+L1";
      } else if (/^\+L\d+$/.test(a)) showNlink = true;
      else if (a === "-a") andMode = true;
      else if (a === "-t") terse = true;
      else if (a === "-n" || a === "-P" || a === "-w" || a === "-l" || a === "-V") continue;
      else if (a === "-p") pids.push(...(args[++i] ?? "").split(",").map(Number));
      else if (a.startsWith("-p")) pids.push(...a.slice(2).split(",").map(Number));
      else if (a === "-u") users.push(...(args[++i] ?? "").split(","));
      else if (a.startsWith("-u")) users.push(...a.slice(2).split(","));
      else if (a === "-c") cmds.push(args[++i] ?? "");
      else if (a.startsWith("-c")) cmds.push(a.slice(2));
      else if (a === "--") paths.push(...args.slice(i + 1));
      else if (a.startsWith("-") || a.startsWith("+")) return fail(`lsof: illegal option character: ${a.replace(/^[-+]+/, "")[0]}`, 1);
      else paths.push(a);
    }
    const cwd = ctx.cwd;
    const st = w.storage;
    const me = w.cur;
    const rows: Row[] = [];
    const devOf = (path: string): string => {
      const m = st.mountFor(path);
      const d = m.dev ? st.dev(m.dev) : undefined;
      return d ? `${d.major},${d.minor}` : `0,${40 + (m.id % 20)}`;
    };
    const userOf = (uid: number) => w.userByUid(uid)?.name ?? String(uid);
    const procList = w.procs.list().filter((p) => !p.kernel && p.state !== "Z" && !p.transient);

    const add = async (p: { comm: string; pid: number; uid: number }, fd: string, acc: string, path: string, deletedPath?: string) => {
      const inf = await w.info(path, true);
      if (!inf) return;
      const shown = deletedPath ?? path;
      const isDeleted = !!deletedPath;
      rows.push({
        comm: p.comm.slice(0, 9),
        pid: p.pid,
        user: userOf(p.uid),
        fd,
        acc,
        type: inf.isDir ? "DIR" : /^\/dev\//.test(path) ? "CHR" : "REG",
        device: devOf(shown),
        size: /^\/dev\//.test(path) ? "0t0" : String(inf.isDir ? inf.size || 4096 : inf.size),
        nlink: isDeleted ? "0" : String(inf.isDir ? 2 : w.inodes.count(inf.path)),
        node: String(w.inodes.ino(inf.path)),
        name: isDeleted ? `${shown} (deleted)` : shown,
        path: shown,
        uid: p.uid,
        deleted: isDeleted,
      });
    };

    const selfPid = w.procs.nextPid;
    const everybody = [...procList.map((p) => ({ comm: p.comm, pid: p.pid, uid: p.uid, cwd: p.pid === w.shellPid ? cwd : p.cwd, exe: p.exe }))];
    everybody.push({ comm: "lsof", pid: selfPid, uid: me.uid, cwd, exe: "/usr/bin/lsof" });
    for (const p of everybody) {
      if (me.uid !== 0 && p.uid !== me.uid) continue; // чужие процессы обычному пользователю не видны
      if (!onlyDeleted) {
        await add(p, "cwd", " ", p.cwd || "/");
        await add(p, "rtd", " ", "/");
        if (p.exe) await add(p, "txt", " ", p.exe);
      }
      for (const e of w.files.list(p.pid)) {
        const acc = e.mode === "r" ? "r" : e.mode === "rw" ? "u" : "w";
        if (e.held) await add(p, String(e.fd), acc, e.held, e.path);
        else if (!onlyDeleted) await add(p, String(e.fd), acc, e.path);
      }
    }
    // «утечки» из старого API заданий (storage.leakDeleted)
    if (onlyDeleted || !pids.length) {
      for (const l of st.allLeaks()) {
        if (me.uid !== 0 && l.user !== me.name) continue;
        const u = w.user(l.user);
        rows.push({
          comm: l.cmd.slice(0, 9), pid: l.pid, user: l.user, fd: "4", acc: "w", type: "REG", device: "253,0", size: String(l.bytes), nlink: "0",
          node: String(1000000 + l.pid), name: `${l.path} (deleted)`, path: l.path, uid: u?.uid ?? 0, deleted: true,
        });
      }
    }

    // фильтры
    const absPaths = paths.map((x) => resolve(cwd, x));
    for (const [i, ap] of absPaths.entries()) {
      if (!(await w.info(ap, true))) return fail(`lsof: status error on ${paths[i]}: No such file or directory`, 1);
    }
    const hasSel = pids.length + users.length + cmds.length + absPaths.length > 0;
    const matchPath = (r: Row): boolean => {
      for (const ap of absPaths) {
        const mount = st.mountAt(ap);
        if (mount) {
          if (st.mountFor(r.path).id === mount.id && r.path !== "/") return true;
        } else if (!r.deleted && normalize(r.path) === ap) return true; // у удалённого файла имени нет — по пути не находится
      }
      return false;
    };
    const sels: ((r: Row) => boolean)[] = [];
    if (pids.length) sels.push((r) => pids.includes(r.pid));
    if (users.length) sels.push((r) => users.some((u) => u === r.user || u === String(r.uid)));
    if (cmds.length) sels.push((r) => cmds.some((c) => r.comm.startsWith(c)));
    if (absPaths.length) sels.push(matchPath);
    let res = rows.filter((r) => (!hasSel ? true : andMode ? sels.every((f) => f(r)) : sels.some((f) => f(r))));
    if (onlyDeleted) res = res.filter((r) => r.deleted);
    res.sort((a, b) => a.pid - b.pid);

    if (terse) return { stdout: [...new Set(res.map((r) => r.pid))].map((p) => p + "\n").join(""), stderr: "", exitCode: res.length ? 0 : 1 };
    if (!res.length) return { stdout: "", stderr: "", exitCode: 1 };
    const colW = {
      comm: Math.max(7, ...res.map((r) => r.comm.length)),
      pid: Math.max(3, ...res.map((r) => String(r.pid).length)),
      user: Math.max(4, ...res.map((r) => r.user.length)),
      type: Math.max(4, ...res.map((r) => r.type.length)),
      device: Math.max(6, ...res.map((r) => r.device.length)),
      size: Math.max(8, ...res.map((r) => r.size.length)),
      node: Math.max(4, ...res.map((r) => r.node.length)),
    };
    const fdCell = (name: string, acc: string) => name.padStart(4) + acc + " ";
    const line = (r: { comm: string; pid: string; user: string; fd: string; type: string; device: string; size: string; nlink: string; node: string; name: string }) =>
      [
        r.comm.padEnd(colW.comm),
        r.pid.padStart(colW.pid),
        r.user.padEnd(colW.user),
        r.fd,
        r.type.padStart(colW.type),
        r.device.padStart(colW.device),
        r.size.padStart(colW.size),
        ...(showNlink ? [r.nlink.padStart(5)] : []),
        r.node.padStart(colW.node),
        r.name,
      ].join(" ");
    const head = line({ comm: "COMMAND", pid: "PID", user: "USER", fd: "  FD  ", type: "TYPE", device: "DEVICE", size: "SIZE/OFF", nlink: "NLINK", node: "NODE", name: "NAME" });
    const body = res.map((r) => line({ comm: r.comm, pid: String(r.pid), user: r.user, fd: fdCell(r.fd, r.acc), type: r.type, device: r.device, size: r.size, nlink: r.nlink, node: r.node, name: r.name }));
    return { stdout: [head, ...body].join("\n") + "\n", stderr: "", exitCode: 0 };
  });
}
