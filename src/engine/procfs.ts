// /proc: файлы генерируются из модели процессов (procs.ts) и кладутся в ФС мира.
import type { World } from "./world";
import { MEM_TOTAL_KB } from "./procs";
import type { Proc } from "./procs";

const synced = new WeakMap<World, { version: number; pids: Set<number> }>();

const STATE_TEXT: Record<string, string> = { R: "R (running)", S: "S (sleeping)", D: "D (disk sleep)", T: "T (stopped)", Z: "Z (zombie)", I: "I (idle)" };

const sigMask = (sigs: number[]) =>
  sigs.reduce((m, s) => m | (1n << BigInt(s - 1)), 0n).toString(16).padStart(16, "0");

export function statusOf(w: World, p: Proc): string {
  const groups = w.userByUid(p.uid)?.groups.map((g) => w.group(g)?.gid).filter((x) => x !== undefined) ?? [];
  const lines = [
    `Name:\t${p.comm}`,
    "Umask:\t0022",
    `State:\t${STATE_TEXT[p.state]}`,
    `Tgid:\t${p.pid}`,
    "Ngid:\t0",
    `Pid:\t${p.pid}`,
    `PPid:\t${p.ppid}`,
    "TracerPid:\t0",
    `Uid:\t${p.uid}\t${p.uid}\t${p.uid}\t${p.uid}`,
    `Gid:\t${p.gid}\t${p.gid}\t${p.gid}\t${p.gid}`,
    "FDSize:\t" + (p.kernel ? "64" : "256"),
    `Groups:\t${[p.gid, ...groups].join(" ")} `,
  ];
  if (!p.kernel && p.state !== "Z") {
    lines.push(
      `VmPeak:\t${String(p.vsz).padStart(8)} kB`,
      `VmSize:\t${String(p.vsz).padStart(8)} kB`,
      `VmRSS:\t${String(p.rss).padStart(8)} kB`,
    );
  }
  lines.push(
    `Threads:\t${p.threads}`,
    "SigQ:\t0/14999",
    `SigPnd:\t${sigMask(p.pending)}`,
    "SigBlk:\t0000000000000000",
    `SigIgn:\t${sigMask([...p.ignored])}`,
    `SigCgt:\t${sigMask(p.handlesHup ? [1] : [])}`,
    "Cpus_allowed_list:\t0-1",
    `voluntary_ctxt_switches:\t${p.pid % 97}`,
    "nonvoluntary_ctxt_switches:\t0",
  );
  return lines.join("\n") + "\n";
}

function statOf(w: World, p: Proc): string {
  const ticks = Math.floor(w.procs.cpuTime(p) * 100);
  const start = Math.floor((p.start - w.procs.bootAt) / 10);
  const tty = p.tty.startsWith("pts/") ? 34816 + Number(p.tty.slice(4)) : p.tty === "tty1" ? 1025 : 0;
  return `${p.pid} (${p.comm}) ${p.state === "I" ? "I" : p.state} ${p.ppid} ${p.pgid} ${p.sid} ${tty} ${p.tty === "?" ? -1 : p.pgid} 4194560 ${p.pid % 300} 0 0 0 ${ticks} 0 0 0 ${20 + p.nice} ${p.nice} ${p.threads} 0 ${start} ${p.vsz * 1024} ${Math.floor(p.rss / 4)} 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`;
}

const CPU_FLAGS =
  "fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ss syscall nx pdpe1gb rdtscp lm constant_tsc rep_good nopl xtopology cpuid tsc_known_freq pni pclmulqdq ssse3 fma cx16 pcid sse4_1 sse4_2 x2apic movbe popcnt aes xsave avx f16c rdrand hypervisor lahf_lm abm 3dnowprefetch invpcid_single ssbd ibrs ibpb stibp fsgsbase bmi1 avx2 smep bmi2 erms invpcid avx512f avx512dq rdseed adx smap clflushopt avx512cd avx512bw avx512vl xsaveopt xsavec xgetbv1 arat md_clear";

function cpuinfo(): string {
  const one = (i: number) =>
    [
      `processor\t: ${i}`,
      "vendor_id\t: GenuineIntel",
      "cpu family\t: 6",
      "model\t\t: 85",
      "model name\t: Intel(R) Xeon(R) Gold 6248 CPU @ 2.50GHz",
      "stepping\t: 7",
      "cpu MHz\t\t: 2494.140",
      "cache size\t: 28160 KB",
      `physical id\t: 0`,
      "siblings\t: 2",
      `core id\t\t: ${i}`,
      "cpu cores\t: 2",
      "fpu\t\t: yes",
      `flags\t\t: ${CPU_FLAGS}`,
      "bogomips\t: 4988.28",
      "address sizes\t: 45 bits physical, 48 bits virtual",
      "",
    ].join("\n");
  return one(0) + "\n" + one(1) + "\n";
}

function meminfo(w: World): string {
  const used = w.procs.list().reduce((s, p) => s + p.rss, 0) + 214_000;
  const free = Math.max(0, MEM_TOTAL_KB - used - 842_000);
  const kb = (n: number) => `${String(n).padStart(8)} kB`;
  return (
    [
      ["MemTotal:", MEM_TOTAL_KB], ["MemFree:", free], ["MemAvailable:", free + 700_000], ["Buffers:", 2_104], ["Cached:", 740_000],
      ["SwapCached:", 0], ["SwapTotal:", 2_097_148], ["SwapFree:", 2_097_148],
    ]
      .map(([k, v]) => `${String(k).padEnd(16)}${kb(v as number)}`)
      .join("\n") + "\n"
  );
}

/** Пересобрать /proc, если таблица процессов изменилась (или force). */
export async function syncProc(w: World, force = false): Promise<void> {
  const st = synced.get(w) ?? { version: -1, pids: new Set<number>() };
  const P = w.procs;
  if (!force && st.version === P.version && st.pids.size) return;
  const procs = P.list();
  const alive = new Set(procs.map((p) => p.pid));
  for (const pid of st.pids) {
    if (!alive.has(pid)) {
      await w.base.rm(`/proc/${pid}`, { recursive: true, force: true });
      for (const k of [...w.owners.keys()]) if (k === `/proc/${pid}` || k.startsWith(`/proc/${pid}/`)) w.owners.delete(k);
      w.inodes.forgetTree(`/proc/${pid}`);
    }
  }
  await w.mkdir("/proc", 0o555);
  const la = P.loadavg();
  const running = procs.filter((p) => p.state === "R").length;
  await w.write("/proc/loadavg", `${la.map((x) => x.toFixed(2)).join(" ")} ${running}/${procs.length} ${P.nextPid - 1}\n`, 0o444);
  const up = P.uptimeSec();
  await w.write("/proc/uptime", `${up}.${String(Math.floor(Math.random() * 90) + 10)} ${Math.floor(up * 1.9)}.12\n`, 0o444);
  await w.write("/proc/cpuinfo", cpuinfo(), 0o444);
  await w.write("/proc/meminfo", meminfo(w), 0o444);
  await w.write(
    "/proc/version",
    "Linux version 5.14.0-570.17.1.el9_6.x86_64 (mockbuild@iad1-prod-build001.bld.equ.rockylinux.org) (gcc (GCC) 11.5.0 20240719 (Red Hat 11.5.0-5), GNU ld version 2.35.2-59.el9) #1 SMP PREEMPT_DYNAMIC Wed May 21 10:08:46 UTC 2025\n",
    0o444,
  );
  for (const p of procs) {
    const d = `/proc/${p.pid}`;
    await w.mkdir(d, 0o555, p.uid, p.gid);
    await w.write(`${d}/status`, statusOf(w, p), 0o444, p.uid, p.gid);
    await w.write(`${d}/comm`, p.comm + "\n", 0o444, p.uid, p.gid);
    await w.write(`${d}/cmdline`, p.kernel || p.state === "Z" ? "" : p.cmd.split(" ").join("\0") + "\0", 0o444, p.uid, p.gid);
    await w.write(`${d}/stat`, statOf(w, p), 0o444, p.uid, p.gid);
    const home = w.userByUid(p.uid)?.home ?? "/";
    const env = p.kernel ? "" : `LANG=en_US.UTF-8\0HOME=${home}\0USER=${w.procs.userName(p.uid)}\0PATH=/usr/local/bin:/usr/bin\0` + (p.tty.startsWith("pts") ? "TERM=xterm-256color\0SHELL=/bin/bash\0" : "");
    await w.write(`${d}/environ`, env, 0o400, p.uid, p.gid);
    for (const [name, target] of [["cwd", p.cwd], ["exe", p.exe]] as const) {
      if (!target || p.kernel) continue;
      const lp = `${d}/${name}`;
      if (!(await w.base.exists(lp))) await w.base.symlink(target, lp);
    }
  }
  const self = "/proc/self";
  if (await w.exists(self)) await w.base.rm(self, { force: true });
  if (w.shellPid) await w.base.symlink(String(w.shellPid), self);
  st.version = P.version;
  st.pids = alive;
  synced.set(w, st);
}
