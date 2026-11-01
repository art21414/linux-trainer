// Подсистема «диски и монтирование»: блочные устройства, файловые системы, таблица монтирования,
// учёт занятого места и inode. Команды (lsblk, df, du, mount...) — в commands/storage.ts.
//
// Идея: ФС мира (InMemoryFs) одна, «диски» — это модель поверх неё. Каталог-точка монтирования
// принадлежит ФС примонтированного устройства. При монтировании то, что лежало в каталоге, «прячется»
// (снимок в Mount.hidden), при размонтировании — возвращается; содержимое устройства
// между монтированиями хранится в FsInfo.content. Занятое место считаем по реальным файлам.
import type { World } from "./world";
import { normalize, dirname } from "./path";

export const KiB = 1024;
export const MiB = 1024 ** 2;
export const GiB = 1024 ** 3;
export const BLOCK = 4096;

export type FsType = "xfs" | "ext4" | "swap" | "LVM2_member";
export type DevType = "disk" | "part" | "lvm";

export interface Virt {
  /** «Видимый» размер (ls -l, du --apparent-size). */
  apparent: number;
  /** Занято на диске (du, df). У разреженного файла меньше apparent. */
  alloc: number;
}

export interface SnapEntry {
  rel: string;
  kind: "file" | "dir" | "link";
  data?: Uint8Array;
  target?: string;
  mode: number;
  uid: number;
  gid: number;
  virt?: Virt;
}
export type Snapshot = SnapEntry[];

export interface Leak {
  bytes: number;
  path: string;
  pid: number;
  cmd: string;
  user: string;
}

export interface FsInfo {
  type: FsType;
  uuid: string;
  label: string;
  /** Занято «служебным» (журнал, метаданные, ядра в /boot...), байт. */
  baseUsed: number;
  /** Занято inode «из коробки». */
  baseInodes: number;
  /** Переопределение размера ФС для df (по умолчанию считается от размера устройства). */
  size?: number;
  /** Скрытое занятое место (fillTo без файла), du его не видит. */
  filler: number;
  /** Скрытые inode (fillInodes). */
  extraInodes: number;
  /** Удалённые, но открытые файлы: df видит, du — нет. */
  leaks: Leak[];
  /** Содержимое, пока ФС не смонтирована. */
  content: Snapshot;
}

export interface BlockDev {
  name: string;
  kname: string;
  type: DevType;
  parent?: string;
  size: number;
  major: number;
  minor: number;
  /** Идентификатор в /dev/mapper (для lvm). */
  dmName?: string;
  /** Для lvm: группа и том (путь /dev/VG/LV). */
  vg?: string;
  lv?: string;
  partuuid?: string;
  /** Идентификатор таблицы разделов диска (для PARTUUID). */
  diskId?: string;
  partNo?: number;
  fs: FsInfo | null;
}

export interface Mount {
  id: number;
  /** Что показывает mount в колонке «источник»: /dev/vda1, tmpfs, sysfs... */
  source: string;
  target: string;
  fstype: string;
  /** VFS-опции: rw/ro, nosuid, nodev, noexec, relatime. */
  vfs: string[];
  /** Опции ФС: rw/ro, seclabel, attr2... */
  fsopts: string[];
  /** Имя блочного устройства (BlockDev.name), если это диск. */
  dev?: string;
  /** Учитывать занятое место по файлам (false — proc/sysfs/devtmpfs...). */
  acct: boolean;
  /** Для tmpfs и псевдо-ФС с размером. */
  tmp?: { size: number; baseUsed: number; inodes: number; baseInodes: number };
  /** Скрыть из df без -a (нулевой размер). */
  dfHidden?: boolean;
  /** Снимок того, что лежало в каталоге до монтирования. */
  hidden?: Snapshot;
  /** Монтирование, содержавшее каталог в момент монтирования. */
  parentId?: number;
  /** Пользователь «держит» точку (lsof/fuser задания): umount скажет target is busy. */
  busy?: string;
}

export class StorageError extends Error {}

export function parseSize(v: number | string): number {
  if (typeof v === "number") return v;
  const m = /^(\d+(?:\.\d+)?)\s*([KMGTP]?)(i?B)?$/i.exec(v.trim());
  if (!m) throw new Error(`bad size: ${v}`);
  const mult: Record<string, number> = { "": 1, K: KiB, M: MiB, G: GiB, T: GiB * 1024, P: GiB * 1024 ** 2 };
  return Math.round(parseFloat(m[1]) * mult[m[2].toUpperCase()]);
}

// ---------- форматирование размеров ----------

/** Как human_readable у GNU df/du: округление вверх, одна цифра после запятой до 10. */
export function humanCeil(n: number, base = 1024): string {
  if (n < base) return String(Math.ceil(n));
  const units = base === 1024 ? ["K", "M", "G", "T", "P"] : ["k", "M", "G", "T", "P"];
  let v = n / base;
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  for (;;) {
    const r = v < 10 ? Math.ceil(v * 10 - 1e-9) / 10 : Math.ceil(v - 1e-9);
    if (r >= base && i < units.length - 1) {
      v = r / base;
      i++;
      continue;
    }
    return (r < 10 ? r.toFixed(1) : String(r)) + units[i];
  }
}

/** Как у lsblk: округление до десятых, «.0» отбрасывается. */
export function humanLsblk(n: number): string {
  if (n < KiB) return `${n}B`;
  const units = ["K", "M", "G", "T", "P"];
  let v = n / KiB;
  let i = 0;
  while (v >= KiB && i < units.length - 1) {
    v /= KiB;
    i++;
  }
  let s = v.toFixed(1);
  if (parseFloat(s) >= KiB && i < units.length - 1) {
    s = (parseFloat(s) / KiB).toFixed(1);
    i++;
  }
  return s.replace(/\.0$/, "") + units[i];
}

/** Как у free -h: Mi/Gi с одной цифрой. */
export function humanFree(kib: number): string {
  const b = kib * 1024;
  if (b < KiB) return `${b}B`;
  const units = ["Ki", "Mi", "Gi", "Ti"];
  let v = b / KiB;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= KiB;
    i++;
  }
  return (v < 10 ? (Math.floor(v * 10) / 10).toFixed(1) : String(Math.floor(v))) + units[i];
}

// ---------- детерминированные идентификаторы ----------

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function hex(n: number, len: number): string {
  return n.toString(16).padStart(8, "0").repeat(2).slice(0, len);
}

// ---------- размеры ФС ----------

export function xfsInodes(size: number): number {
  return Math.floor(size / 2048 / 64) * 64;
}
export function ext4Inodes(size: number): number {
  return Math.max(8192, Math.ceil(size / 16384 / 8192) * 8192);
}
export function ext4Journal(size: number): number {
  const b = size / BLOCK;
  if (b < 32768) return 1024;
  if (b < 256 * 1024) return 4096;
  if (b < 512 * 1024) return 8192;
  if (b < 4096 * 1024) return 16384;
  if (b < 8192 * 1024) return 32768;
  return 65536;
}

/** Размер ФС (то, что покажет df), байт. */
export function fsCapacity(f: FsInfo, devSize: number): number {
  if (f.size !== undefined) return f.size;
  if (f.type === "ext4") return Math.floor(devSize - ext4Inodes(devSize) * 256 - ext4Journal(devSize) * BLOCK - devSize * 0.0015);
  return devSize;
}

export function newFs(type: FsType, devSize: number, uuid: string, label = ""): FsInfo {
  const f: FsInfo = {
    type,
    uuid,
    label,
    baseUsed: 0,
    baseInodes: 0,
    filler: 0,
    extraInodes: 0,
    leaks: [],
    content: [],
  };
  if (type === "xfs") {
    f.baseUsed = Math.round(47 * MiB + 4.2 * MiB * (devSize / GiB));
    f.baseInodes = 3;
  } else if (type === "ext4") {
    f.baseUsed = 24 * KiB;
    f.baseInodes = 11;
    f.content = [{ rel: "lost+found", kind: "dir", mode: 0o700, uid: 0, gid: 0, virt: { apparent: 16384, alloc: 16384 } }];
  }
  return f;
}

export interface Usage {
  size: number;
  used: number;
  avail: number;
  itotal: number;
  iused: number;
  ifree: number;
}

// ---------- fstab ----------

export interface FstabEntry {
  spec: string;
  file: string;
  vfstype: string;
  opts: string;
  dump: string;
  pass: string;
}

export function parseFstab(text: string): FstabEntry[] {
  const out: FstabEntry[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const f = line.split(/\s+/);
    if (f.length < 4) continue;
    out.push({ spec: f[0], file: f[1], vfstype: f[2], opts: f[3], dump: f[4] ?? "0", pass: f[5] ?? "0" });
  }
  return out;
}

export function fstabLine(spec: string, file: string, type: string, opts = "defaults", dump = 0, pass = 0): string {
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(1, w - s.length));
  return `${pad(spec, 24)}${pad(file, 24)}${pad(type, 8)}${pad(opts, 16)}${dump} ${pass}`;
}

// ---------- опции монтирования ----------

const GENERIC_OPTS = new Set([
  "ro", "rw", "suid", "nosuid", "dev", "nodev", "exec", "noexec", "atime", "noatime", "relatime", "norelatime", "strictatime",
  "diratime", "nodiratime", "sync", "async", "dirsync", "defaults", "auto", "noauto", "nofail", "user", "nouser", "users", "owner",
  "group", "_netdev", "remount", "bind", "rbind", "loop", "silent", "quiet", "lazytime", "nolazytime", "mand", "nomand",
]);
const XFS_OPTS = /^(attr2|noattr2|inode64|inode32|logbufs=\d+|logbsize=\w+|noquota|usrquota|uquota|grpquota|gquota|prjquota|pquota|uqnoenforce|gqnoenforce|pqnoenforce|nouuid|largeio|nolargeio|allocsize=\w+|discard|nodiscard|noalign|wsync|swalloc|sunit=\d+|swidth=\d+|norecovery|ikeep|noikeep|dax=\w+|logdev=.+|rtdev=.+|filestreams|noattr2|nobarrier|barrier)$/;
const EXT4_OPTS = /^(acl|noacl|user_xattr|nouser_xattr|barrier(=\d)?|nobarrier|data=(ordered|writeback|journal)|errors=(continue|remount-ro|panic)|discard|nodiscard|commit=\d+|delalloc|nodelalloc|usrquota|grpquota|prjquota|quota|noquota|journal_checksum|nojournal_checksum|dioread_nolock|dioread_lock|i_version|stripe=\d+|resuid=\d+|resgid=\d+|noload|nombcache|init_itable=\d+|noinit_itable|auto_da_alloc|noauto_da_alloc|max_batch_time=\d+|min_batch_time=\d+|sb=\d+|journal_async_commit|nobh|bh|oldalloc|orlov|debug|grpid|bsdgroups|nogrpid|sysvgroups|minixdf|bsddf|block_validity|noblock_validity|inode_readahead_blks=\d+)$/;
const TMPFS_OPTS = /^(size=\w+%?|nr_inodes=\w+|nr_blocks=\w+|mode=[0-7]+|uid=\d+|gid=\d+|huge=\w+|mpol=.+|noswap|inode64|inode32)$/;
const X_OPTS = /^(x-[\w.-]+(=.*)?|comment=.*|context=.*|fscontext=.*|defcontext=.*|rootcontext=.*|loop=.*|offset=.*)$/;

function sizeKib(v: string): number {
  const m = /^(\d+)([kKmMgG%]?)$/.exec(v);
  if (!m) return 0;
  const n = parseInt(m[1], 10);
  const mult: Record<string, number> = { "": 1 / 1024, k: 1, K: 1, m: 1024, M: 1024, g: MiB, G: MiB };
  return Math.round(n * (mult[m[2]] ?? 1));
}

export interface BuiltOpts {
  vfs: string[];
  fsopts: string[];
  remount: boolean;
  bind: boolean;
  /** Список отброшенных/неизвестных опций (если непусто — mount откажет). */
  bad: string[];
  tmpSizeKib?: number;
  tmpInodes?: number;
}

/** Разобрать -o и собрать итоговые опции как их покажет mount/findmnt. */
export function buildOpts(fstype: string, list: string[], tmpDefaultKib = 0): BuiltOpts {
  const toks = list.flatMap((s) => s.split(",")).filter(Boolean);
  const set = new Set<string>();
  const bad: string[] = [];
  let remount = false;
  let bind = false;
  const fsSpecific = fstype === "xfs" ? XFS_OPTS : fstype === "ext4" ? EXT4_OPTS : fstype === "tmpfs" ? TMPFS_OPTS : /^$/;
  const extra: string[] = [];
  for (const t of toks) {
    if (t === "remount") remount = true;
    else if (t === "bind" || t === "rbind") bind = true;
    if (GENERIC_OPTS.has(t) || X_OPTS.test(t)) set.add(t);
    else if (fsSpecific.test(t)) extra.push(t);
    else bad.push(t);
  }
  const ro = set.has("ro") && !set.has("rw") ? true : set.has("rw") ? false : false;
  const vfs: string[] = [ro ? "ro" : "rw"];
  if (set.has("sync")) vfs.push("sync");
  if (set.has("nosuid")) vfs.push("nosuid");
  if (set.has("nodev")) vfs.push("nodev");
  if (set.has("noexec")) vfs.push("noexec");
  if (set.has("noatime")) vfs.push("noatime");
  else if (!set.has("strictatime")) vfs.push("relatime");
  if (set.has("nodiratime")) vfs.push("nodiratime");
  const fsopts: string[] = [ro ? "ro" : "rw"];
  let tmpSizeKib: number | undefined;
  let tmpInodes: number | undefined;
  if (fstype === "xfs") {
    fsopts.push("seclabel");
    if (extra.includes("nouuid")) fsopts.push("nouuid");
    fsopts.push(extra.includes("noattr2") ? "noattr2" : "attr2");
    fsopts.push(extra.includes("inode32") ? "inode32" : "inode64");
    fsopts.push(extra.find((x) => x.startsWith("logbufs=")) ?? "logbufs=8");
    fsopts.push(extra.find((x) => x.startsWith("logbsize=")) ?? "logbsize=32k");
    const q = extra.filter((x) => /quota$/.test(x) && x !== "noquota").map((x) => ({ uquota: "usrquota", gquota: "grpquota", pquota: "prjquota" })[x] ?? x);
    fsopts.push(...(q.length ? q : ["noquota"]));
    for (const x of extra) if (/^(discard|largeio|allocsize=|wsync|swalloc|noalign|sunit=|swidth=|ikeep|filestreams|norecovery)/.test(x)) fsopts.push(x);
  } else if (fstype === "ext4") {
    fsopts.push("seclabel");
    for (const x of extra) if (/^(discard|data=|errors=|commit=|nodelalloc|noacl|nouser_xattr|usrquota|grpquota|prjquota|nobarrier|barrier|stripe=|i_version|nojournal_checksum|journal_checksum|noload|nombcache|dioread_nolock|block_validity|init_itable=|noauto_da_alloc)/.test(x)) fsopts.push(x);
  } else if (fstype === "tmpfs") {
    fsopts.push("seclabel");
    const sz = extra.find((x) => x.startsWith("size="));
    tmpSizeKib = sz ? (sz.endsWith("%") ? tmpDefaultKib : sizeKib(sz.slice(5))) : tmpDefaultKib;
    fsopts.push(`size=${tmpSizeKib}k`);
    const ni = extra.find((x) => x.startsWith("nr_inodes="));
    if (ni) {
      tmpInodes = parseInt(ni.slice(10), 10) || undefined;
      fsopts.push(ni);
    }
    for (const x of extra) if (/^(mode=|uid=|gid=|huge=|mpol=|noswap)/.test(x)) fsopts.push(x);
    fsopts.push("inode64");
  }
  return { vfs, fsopts, remount, bind, bad, tmpSizeKib, tmpInodes };
}

export const fullOpts = (m: Pick<Mount, "vfs" | "fsopts">): string => [...new Set([...m.vfs, ...m.fsopts])].join(",");

// ---------- сама подсистема ----------

const VG = "rl";

export class Storage {
  devs: BlockDev[] = [];
  mounts: Mount[] = [];
  virt = new Map<string, Virt>();
  /** Активные swap (имена устройств). */
  swaps = new Set<string>();
  memTotalKib = 3815640;
  private nextMountId = 22;
  private rnd = prng(0x5eed1e);
  private counter = 0;

  constructor(private w: World) {}

  // ----- идентификаторы -----

  newUuid(): string {
    const r = () => this.rnd();
    const a = hex(r(), 8);
    const b = hex(r(), 8).slice(0, 4);
    const c = "4" + hex(r(), 8).slice(1, 4);
    const d = "89ab"[r() % 4] + hex(r(), 8).slice(1, 4);
    const e = hex(r(), 8) + hex(r(), 8).slice(0, 4);
    return `${a}-${b}-${c}-${d}-${e}`;
  }

  // ----- инициализация: Rocky 9 на VM -----

  async init(): Promise<void> {
    const mk = (d: Partial<BlockDev> & Pick<BlockDev, "name" | "type" | "size" | "major" | "minor">): BlockDev => {
      const dev: BlockDev = { kname: d.name, fs: null, ...d };
      this.devs.push(dev);
      return dev;
    };
    mk({ name: "vda", type: "disk", size: 20 * GiB, major: 252, minor: 0, diskId: "1c5ecd5f" });
    const boot = mk({ name: "vda1", type: "part", parent: "vda", size: 1 * GiB, major: 252, minor: 1, diskId: "1c5ecd5f", partNo: 1, partuuid: "1c5ecd5f-01" });
    mk({
      name: "vda2", type: "part", parent: "vda", size: 19 * GiB - MiB, major: 252, minor: 2, diskId: "1c5ecd5f", partNo: 2, partuuid: "1c5ecd5f-02",
      fs: { ...newFs("LVM2_member", 19 * GiB, "kQ7mXe-3VbT-yH2d-NwUa-pR8c-ZsLf-J1o4Dg"), baseUsed: 0 },
    });
    const root = mk({ name: "rl-root", kname: "dm-0", type: "lvm", parent: "vda2", size: 17 * GiB - 4 * MiB, major: 253, minor: 0, dmName: "rl-root", vg: VG, lv: "root" });
    const swap = mk({ name: "rl-swap", kname: "dm-1", type: "lvm", parent: "vda2", size: 2 * GiB, major: 253, minor: 1, dmName: "rl-swap", vg: VG, lv: "swap" });
    mk({ name: "vdb", type: "disk", size: 5 * GiB, major: 252, minor: 16, diskId: "5e7d3c1a" });
    mk({ name: "vdc", type: "disk", size: 2 * GiB, major: 252, minor: 32, diskId: "b04f92e6" });

    boot.fs = { ...newFs("xfs", boot.size, "4b2c9a1e-7d3f-4e58-9c1a-0f6e2d8b5a73"), size: 960 * MiB, baseUsed: 80 * MiB, baseInodes: 330 };
    root.fs = { ...newFs("xfs", root.size, "c1d84e07-5a2b-4f93-b6e0-83a7d915f2c4"), baseUsed: Math.round(2.1 * GiB), baseInodes: 35800 };
    swap.fs = { ...newFs("swap", swap.size, "e9a05b3d-1c78-4d2f-8a46-72b0f4c6d19e"), baseUsed: 0 };
    this.swaps.add("rl-swap");

    // /boot: пара «ядерных» файлов с виртуальным размером
    const kv = "5.14.0-570.17.1.el9_6.x86_64";
    await this.w.mkdir("/boot/grub2");
    await this.w.mkdir("/boot/loader");
    await this.w.mkdir("/boot/efi", 0o700);
    const bootFiles: [string, number][] = [
      [`config-${kv}`, 232 * KiB], [`System.map-${kv}`, 5.3 * MiB], [`symvers-${kv}.gz`, 380 * KiB],
      [`vmlinuz-${kv}`, 12.4 * MiB], [`initramfs-${kv}.img`, 35.8 * MiB],
      ["vmlinuz-0-rescue-a1b2c3d4e5f60718293a4b5c6d7e8f90", 12.4 * MiB], ["initramfs-0-rescue-a1b2c3d4e5f60718293a4b5c6d7e8f90.img", 101 * MiB],
    ];
    for (const [n, sz] of bootFiles) await this.createFile(`/boot/${n}`, Math.round(sz), { mode: n.startsWith("config") || n.startsWith("System") || n.startsWith("symvers") ? 0o600 : n.startsWith("vmlinuz") ? 0o755 : 0o600 });
    boot.fs.baseUsed = 24 * MiB;

    const sys: [string, string, string, string, Partial<Mount>?][] = [
      ["sysfs", "/sys", "sysfs", "rw,nosuid,nodev,noexec,relatime,seclabel"],
      ["proc", "/proc", "proc", "rw,nosuid,nodev,noexec,relatime"],
      ["devtmpfs", "/dev", "devtmpfs", "rw,nosuid,seclabel,size=4096k,nr_inodes=1017738,mode=755,inode64", { dfHidden: false, tmp: { size: 4 * MiB, baseUsed: 0, inodes: 1017738, baseInodes: 353 } }],
      ["securityfs", "/sys/kernel/security", "securityfs", "rw,nosuid,nodev,noexec,relatime"],
      ["tmpfs", "/dev/shm", "tmpfs", "rw,nosuid,nodev,seclabel,inode64", { acct: true, dfHidden: false, tmp: { size: 1907820 * KiB, baseUsed: 0, inodes: 1022946, baseInodes: 1 } }],
      ["devpts", "/dev/pts", "devpts", "rw,nosuid,noexec,relatime,seclabel,gid=5,mode=620,ptmxmode=000"],
      ["tmpfs", "/run", "tmpfs", "rw,nosuid,nodev,seclabel,size=763128k,nr_inodes=819200,mode=755,inode64", { acct: true, dfHidden: false, tmp: { size: 763128 * KiB, baseUsed: Math.round(5.2 * MiB), inodes: 819200, baseInodes: 712 } }],
      ["cgroup2", "/sys/fs/cgroup", "cgroup2", "rw,nosuid,nodev,noexec,relatime,seclabel,nsdelegate,memory_recursiveprot"],
      ["pstore", "/sys/fs/pstore", "pstore", "rw,nosuid,nodev,noexec,relatime,seclabel"],
      ["bpf", "/sys/fs/bpf", "bpf", "rw,nosuid,nodev,noexec,relatime,mode=700"],
      ["/dev/mapper/rl-root", "/", "xfs", "rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota", { dev: "rl-root", acct: true }],
      ["selinuxfs", "/sys/fs/selinux", "selinuxfs", "rw,nosuid,noexec,relatime"],
      ["systemd-1", "/proc/sys/fs/binfmt_misc", "autofs", "rw,relatime,fd=29,pgrp=1,timeout=0,minproto=5,maxproto=5,direct,pipe_ino=17519"],
      ["hugetlbfs", "/dev/hugepages", "hugetlbfs", "rw,nosuid,nodev,relatime,seclabel,pagesize=2M"],
      ["mqueue", "/dev/mqueue", "mqueue", "rw,nosuid,nodev,noexec,relatime,seclabel"],
      ["debugfs", "/sys/kernel/debug", "debugfs", "rw,nosuid,nodev,noexec,relatime,seclabel"],
      ["tracefs", "/sys/kernel/tracing", "tracefs", "rw,nosuid,nodev,noexec,relatime,seclabel"],
      ["fusectl", "/sys/fs/fuse/connections", "fusectl", "rw,nosuid,nodev,noexec,relatime"],
      ["configfs", "/sys/kernel/config", "configfs", "rw,nosuid,nodev,noexec,relatime"],
      ["/dev/vda1", "/boot", "xfs", "rw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota", { dev: "vda1", acct: true }],
      ["tmpfs", "/run/user/0", "tmpfs", "rw,nosuid,nodev,relatime,seclabel,size=381564k,nr_inodes=95391,mode=700,inode64", { acct: true, dfHidden: false, tmp: { size: 381564 * KiB, baseUsed: 0, inodes: 95391, baseInodes: 17 } }],
    ];
    let id = 22;
    for (const [source, target, fstype, opts, extra] of sys) {
      const toks = opts.split(",");
      const vfsSet = new Set(["rw", "ro", "nosuid", "nodev", "noexec", "relatime", "noatime", "sync"]);
      const vfs: string[] = [];
      let i = 0;
      while (i < toks.length && vfsSet.has(toks[i])) vfs.push(toks[i++]);
      const fsopts = [vfs[0] ?? "rw", ...toks.slice(i)];
      const m: Mount = { id: id++, source, target, fstype, vfs, fsopts, acct: false, dfHidden: true, ...extra };
      if (!extra?.tmp && !extra?.dev) m.dfHidden = true;
      this.mounts.push(m);
    }
    this.nextMountId = id;
    for (const m of this.mounts) if (m.dev) m.parentId = undefined;

    await this.writeFstab();
    await this.syncDev();
    await this.syncProc();
  }

  async writeFstab(): Promise<void> {
    const boot = this.devs.find((d) => d.name === "vda1")!;
    const text =
      "\n#\n# /etc/fstab\n# Created by anaconda on Mon Jun  2 09:12:15 2025\n#\n" +
      "# Accessible filesystems, by reference, are maintained under '/dev/disk/'.\n" +
      "# See man pages fstab(5), findfs(8), mount(8) and/or blkid(8) for more info.\n#\n" +
      "# After editing this file, run 'systemctl daemon-reload' to update systemd\n# units generated from this file.\n#\n" +
      fstabLine("/dev/mapper/rl-root", "/", "xfs") + "\n" +
      fstabLine(`UUID=${boot.fs!.uuid}`, "/boot", "xfs") + "\n" +
      fstabLine("/dev/mapper/rl-swap", "none", "swap") + "\n";
    await this.w.write("/etc/fstab", text, 0o644);
  }

  async readFstab(): Promise<FstabEntry[]> {
    return parseFstab((await this.w.read("/etc/fstab")) ?? "");
  }

  /** Дописать строку в /etc/fstab. */
  async addFstabLine(spec: string, file: string, type: string, opts = "defaults", dump = 0, pass = 0): Promise<void> {
    const cur = (await this.w.read("/etc/fstab")) ?? "";
    await this.w.write("/etc/fstab", cur + fstabLine(spec, file, type, opts, dump, pass) + "\n", 0o644);
  }

  // ----- /dev, /proc -----

  devPath(d: BlockDev): string {
    return d.type === "lvm" ? `/dev/mapper/${d.dmName}` : `/dev/${d.name}`;
  }

  /** Узлы /dev (пустые файлы) и симлинки /dev/disk/by-*, /dev/VG/LV. */
  async syncDev(): Promise<void> {
    const w = this.w;
    const base = w.base;
    for (const dir of ["/dev/disk", `/dev/${VG}`, "/dev/mapper"]) if (await base.exists(dir)) await base.rm(dir, { recursive: true, force: true });
    for (const p of base.getAllPaths()) if (/^\/dev\/(vd[a-z]+\d*|dm-\d+)$/.test(p)) await base.rm(p, { force: true });
    await w.mkdir("/dev", 0o755);
    const sym = async (target: string, path: string) => {
      await w.mkdir(dirname(path));
      await base.symlink(target, path);
      w.setOwner(path, 0, 0);
    };
    for (const d of this.devs) {
      const gid = 6;
      await w.write(d.type === "lvm" ? `/dev/${d.kname}` : this.devPath(d), "", 0o660, 0, gid);
      if (d.type === "lvm") {
        await sym(`../${d.kname}`, `/dev/mapper/${d.dmName}`);
        await sym(`../${d.kname}`, `/dev/${d.vg}/${d.lv}`);
      }
      const rel = d.type === "lvm" ? `../../${d.kname}` : `../../${d.name}`;
      if (d.fs?.uuid) await sym(rel, `/dev/disk/by-uuid/${d.fs.uuid}`);
      if (d.fs?.label) await sym(rel, `/dev/disk/by-label/${d.fs.label}`);
      if (d.partuuid) await sym(rel, `/dev/disk/by-partuuid/${d.partuuid}`);
    }
    await w.mkdir("/dev/mapper", 0o755);
    await w.write("/dev/mapper/control", "", 0o600);
  }

  /** /proc/mounts, /proc/self/mounts, /proc/swaps, /proc/partitions. */
  async syncProc(): Promise<void> {
    const w = this.w;
    const mounts = this.mounts.map((m) => `${m.source} ${m.target} ${m.fstype} ${fullOpts(m)} 0 0\n`).join("");
    await w.write("/proc/mounts", mounts, 0o444);
    await w.write("/proc/self/mounts", mounts, 0o444);
    const swaps = ["Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n"];
    for (const n of this.swaps) {
      const d = this.devs.find((x) => x.name === n)!;
      swaps.push(`/dev/${d.kname}`.padEnd(40) + `partition\t${Math.floor(d.size / KiB)}\t\t0\t\t-2\n`);
    }
    await w.write("/proc/swaps", swaps.join(""), 0o444);
    const parts = this.devs
      .map((d) => ` ${String(d.major).padStart(3)} ${String(d.minor).padStart(8)} ${String(Math.floor(d.size / KiB)).padStart(10)} ${d.kname}\n`)
      .join("");
    await w.write("/proc/partitions", "major minor  #blocks  name\n\n" + parts, 0o444);
  }

  // ----- поиск устройств и монтирований -----

  dev(name: string): BlockDev | undefined {
    return this.devs.find((d) => d.name === name);
  }

  children(name: string): BlockDev[] {
    return this.devs.filter((d) => d.parent === name).sort((a, b) => a.minor - b.minor);
  }

  /** Разрешить «/dev/vdb1», «/dev/mapper/rl-root», UUID=..., LABEL=... в устройство. */
  resolveDev(spec: string): BlockDev | null {
    const eq = /^(UUID|LABEL|PARTUUID)=(.*)$/.exec(spec);
    if (eq) {
      const v = eq[2].replace(/^"|"$/g, "");
      return (
        this.devs.find((d) => (eq[1] === "UUID" ? d.fs?.uuid.toLowerCase() === v.toLowerCase() : eq[1] === "LABEL" ? !!d.fs?.label && d.fs.label === v : d.partuuid?.toLowerCase() === v.toLowerCase())) ??
        null
      );
    }
    const by = /^\/dev\/disk\/by-(uuid|label|partuuid)\/(.+)$/.exec(spec);
    if (by) return this.resolveDev(`${by[1].toUpperCase()}=${by[2]}`);
    const p = normalize(spec);
    return (
      this.devs.find((d) => this.devPath(d) === p || `/dev/${d.kname}` === p || (d.type === "lvm" && p === `/dev/${d.vg}/${d.lv}`)) ?? null
    );
  }

  /** Монтирование, которому принадлежит путь (самый длинный префикс; из стопки — последнее). */
  mountFor(path: string): Mount {
    const p = normalize(path);
    let best: Mount | null = null;
    for (const m of this.mounts) {
      const t = m.target;
      if (t === "/" || p === t || p.startsWith(t + "/")) {
        if (!best || t.length >= best.target.length) best = m;
      }
    }
    return best ?? this.mounts.find((m) => m.target === "/")!;
  }

  mountsOf(devName: string): Mount[] {
    return this.mounts.filter((m) => m.dev === devName);
  }

  /** Самое верхнее монтирование в точке (если в одну точку смонтировано несколько). */
  mountAt(target: string): Mount | null {
    const t = normalize(target);
    for (let i = this.mounts.length - 1; i >= 0; i--) if (this.mounts[i].target === t) return this.mounts[i];
    return null;
  }

  // ----- размеры файлов и учёт места -----

  virtOf(path: string): Virt | undefined {
    return this.virt.get(normalize(path));
  }

  allocOf(fstype: string, kind: "file" | "dir" | "link", bytes: number, virt?: Virt): number {
    if (virt) return virt.alloc;
    if (kind === "link") return 0;
    if (kind === "dir") return fstype === "ext4" || fstype === "vfat" ? BLOCK : 0;
    return bytes === 0 ? 0 : Math.ceil(bytes / BLOCK) * BLOCK;
  }

  /** Видимый размер каталога (stat), как у ФС. */
  dirApparent(fstype: string, entries: number, names = 0): number {
    if (fstype === "ext4") return BLOCK;
    if (fstype === "tmpfs") return 40 + entries * 20;
    return 6 + names + entries * 8;
  }

  private snapSize(snap: Snapshot, fstype: string): { bytes: number; inodes: number } {
    let bytes = 0;
    for (const e of snap) bytes += this.allocOf(fstype, e.kind, e.data?.length ?? 0, e.virt);
    return { bytes, inodes: snap.length };
  }

  /** Занято по файлам на каждом монтировании: Map<mount.id, {bytes, inodes}>. */
  async scan(): Promise<Map<number, { bytes: number; inodes: number }>> {
    const res = new Map<number, { bytes: number; inodes: number }>();
    for (const m of this.mounts) res.set(m.id, { bytes: 0, inodes: 0 });
    for (const p of this.w.base.getAllPaths()) {
      const m = this.mountFor(p);
      if (!m.acct) continue;
      let st;
      try {
        st = await this.w.base.lstat(p);
      } catch {
        continue;
      }
      const kind = st.isSymbolicLink ? "link" : st.isDirectory ? "dir" : "file";
      const r = res.get(m.id)!;
      r.bytes += this.allocOf(m.fstype, kind, st.size, this.virt.get(p));
      r.inodes += 1;
    }
    // спрятанное под точками монтирования занимает место родителя
    for (const m of this.mounts) {
      if (!m.hidden || m.parentId === undefined) continue;
      const parent = this.mounts.find((x) => x.id === m.parentId);
      if (!parent) continue;
      const s = this.snapSize(m.hidden, parent.fstype);
      const r = res.get(parent.id)!;
      r.bytes += s.bytes;
      r.inodes += s.inodes;
    }
    return res;
  }

  /** Размеры и занятость одного монтирования (по готовому скану). */
  usageOf(m: Mount, scan: Map<number, { bytes: number; inodes: number }>): Usage {
    const s = scan.get(m.id) ?? { bytes: 0, inodes: 0 };
    if (m.dev) {
      const d = this.dev(m.dev)!;
      const f = d.fs!;
      const size = fsCapacity(f, d.size);
      const leaked = f.leaks.reduce((a, l) => a + l.bytes, 0);
      const used = Math.min(size, f.baseUsed + f.filler + leaked + s.bytes);
      const reserved = f.type === "ext4" ? Math.floor(size * 0.05) : 0;
      const avail = Math.max(0, size - used - reserved);
      const itotal = f.type === "xfs" ? xfsInodes(d.size) : ext4Inodes(d.size);
      const iused = Math.min(itotal, f.baseInodes + f.extraInodes + s.inodes);
      return { size, used, avail, itotal, iused, ifree: itotal - iused };
    }
    if (m.tmp) {
      const used = Math.min(m.tmp.size, m.tmp.baseUsed + s.bytes);
      const iused = m.tmp.baseInodes + s.inodes;
      return { size: m.tmp.size, used, avail: m.tmp.size - used, itotal: m.tmp.inodes, iused, ifree: m.tmp.inodes - iused };
    }
    return { size: 0, used: 0, avail: 0, itotal: 0, iused: 0, ifree: 0 };
  }

  async usage(m: Mount): Promise<Usage> {
    return this.usageOf(m, await this.scan());
  }

  /** Использование по пути/точке монтирования (для заданий: await w.storage.usageAt("/var")). */
  async usageAt(path: string): Promise<Usage & { mount: Mount }> {
    const m = this.mountFor(path);
    return { ...(await this.usage(m)), mount: m };
  }

  // ----- проверки, которые вызывает охраняемая ФС -----

  /** Вернуть код ошибки, если операцию над путём нельзя выполнить (ro-ФС, нет места). */
  async guardFs(op: string, args: unknown[]): Promise<{ code: "EROFS" | "ENOSPC"; path: string } | null> {
    const pathsFor = (): string[] => {
      const a = args.map((x) => (typeof x === "string" ? normalize(x) : ""));
      if (op === "symlink" || op === "link") return [a[1]];
      if (op === "cp") return [a[1]];
      if (op === "mv") return [a[0], a[1]];
      return [a[0]];
    };
    for (const p of pathsFor()) {
      if (!p) continue;
      const m = this.mountFor(p);
      if (m.vfs[0] === "ro") return { code: "EROFS", path: p };
    }
    if (!["writeFile", "appendFile", "createExclusive", "mkdir", "symlink", "link"].includes(op)) return null;
    const p = pathsFor()[0];
    const m = this.mountFor(p);
    if (!(m.dev || m.tmp) || !m.acct) return null;
    const u = await this.usage(m);
    if (op === "writeFile" || op === "appendFile") {
      const c = args[1];
      const len = typeof c === "string" ? new TextEncoder().encode(c).length : ((c as Uint8Array)?.length ?? 0);
      if (len > 0 && u.avail < Math.min(len, BLOCK)) return { code: "ENOSPC", path: p };
      if (len > 0 && u.avail < len) return { code: "ENOSPC", path: p };
    }
    if (u.ifree <= 0 && !(await this.w.base.exists(p))) return { code: "ENOSPC", path: p };
    return null;
  }

  /** Привести виртуальные размеры в порядок после операции. */
  afterFs(op: string, args: unknown[]): void {
    const a = args.map((x) => (typeof x === "string" ? normalize(x) : ""));
    const under = (p: string) => [...this.virt.keys()].filter((k) => k === p || k.startsWith(p + "/"));
    if (op === "rm") for (const k of under(a[0])) this.virt.delete(k);
    else if (op === "writeFile") this.virt.delete(a[0]);
    else if (op === "mv") {
      for (const k of under(a[0])) {
        const v = this.virt.get(k)!;
        this.virt.delete(k);
        this.virt.set(a[1] + k.slice(a[0].length), v);
      }
    } else if (op === "cp") {
      for (const k of under(a[0])) this.virt.set(a[1] + k.slice(a[0].length), { ...this.virt.get(k)! });
    }
  }

  // ----- API для заданий (setup) -----

  /** Новый диск. await w.storage.addDisk("vdd", "10G") */
  async addDisk(name: string, size: number | string): Promise<BlockDev> {
    if (this.dev(name)) throw new Error(`disk ${name} exists`);
    const letter = name.replace(/^vd/, "");
    const idx = letter.charCodeAt(0) - 97;
    const d: BlockDev = {
      name, kname: name, type: "disk", size: parseSize(size), major: 252, minor: idx * 16, fs: null,
      diskId: hex(this.rnd(), 8),
    };
    this.devs.push(d);
    await this.syncDev();
    await this.syncProc();
    return d;
  }

  /** Раздел на диске: следующий номер. await w.storage.addPartition("vdb", "2G") → vdb1 */
  async addPartition(disk: string, size: number | string): Promise<BlockDev> {
    const parent = this.dev(disk);
    if (!parent || parent.type !== "disk") throw new Error(`no disk ${disk}`);
    const sz = parseSize(size);
    const kids = this.children(disk);
    const used = kids.reduce((a, k) => a + k.size, 0) + MiB;
    if (used + sz > parent.size) throw new Error(`no space on ${disk}`);
    const no = kids.length ? Math.max(...kids.map((k) => k.partNo ?? 0)) + 1 : 1;
    const d: BlockDev = {
      name: `${disk}${no}`, kname: `${disk}${no}`, type: "part", parent: disk, size: sz, major: parent.major, minor: parent.minor + no,
      diskId: parent.diskId, partNo: no, partuuid: `${parent.diskId}-${String(no).padStart(2, "0")}`, fs: null,
    };
    this.devs.push(d);
    await this.syncDev();
    await this.syncProc();
    return d;
  }

  /** Создать ФС. await w.storage.mkfs("/dev/vdb1", "ext4", { label: "data" }). Не смонтированное устройство. */
  async mkfs(spec: string, type: "xfs" | "ext4", opts: { label?: string; uuid?: string } = {}): Promise<BlockDev> {
    const d = this.resolveDev(spec);
    if (!d) throw new Error(`no device ${spec}`);
    if (this.mountsOf(d.name).length) throw new Error(`${spec} is mounted`);
    d.fs = newFs(type, d.size, opts.uuid ?? this.newUuid(), opts.label ?? "");
    await this.syncDev();
    return d;
  }

  /** Примонтировать (без проверки прав). Бросает StorageError с текстом как у mount. */
  async mount(spec: string, target: string, opts: { type?: string; options?: string | string[]; cwd?: string } = {}): Promise<Mount> {
    const r = await this.doMount(spec, target, opts.type, Array.isArray(opts.options) ? opts.options : opts.options ? [opts.options] : []);
    if (typeof r === "string") throw new StorageError(r);
    return r;
  }

  async umount(target: string): Promise<void> {
    const m = this.mountAt(target) ?? (this.resolveDev(target) ? this.mounts.filter((x) => x.dev === this.resolveDev(target)!.name).pop() : undefined);
    if (!m) throw new StorageError("not mounted");
    const e = await this.doUmount(m, "/", false);
    if (e) throw new StorageError(e);
  }

  /** Файл заданного размера без хранения содержимого. await w.storage.createFile("/var/log/big.log", "1G", { owner: "root" }) */
  async createFile(path: string, size: number | string, opts: { mode?: number; uid?: number; gid?: number; sparse?: boolean; owner?: string } = {}): Promise<void> {
    const p = normalize(path);
    const n = parseSize(size);
    let uid = opts.uid ?? 0;
    let gid = opts.gid ?? 0;
    if (opts.owner) {
      const u = this.w.user(opts.owner);
      if (u) {
        uid = u.uid;
        gid = u.gid;
      }
    }
    await this.w.write(p, "", opts.mode ?? 0o644, uid, gid);
    this.virt.set(p, { apparent: n, alloc: opts.sparse ? 0 : Math.ceil(n / BLOCK) * BLOCK });
  }

  /** Разреженный файл (как truncate -s): виден n байт, занято alloc. */
  async createSparse(path: string, apparent: number | string, alloc: number | string = 0, opts: { mode?: number; owner?: string } = {}): Promise<void> {
    await this.createFile(path, apparent, { ...opts, sparse: true });
    this.virt.get(normalize(path))!.alloc = Math.ceil(parseSize(alloc) / BLOCK) * BLOCK;
  }

  /** Много файлов: dir/prefixN, count штук с виртуальным размером size каждый (для заданий «кто съел место»). */
  async createFiles(dir: string, count: number, size: number | string, prefix = "file"): Promise<void> {
    const d = normalize(dir);
    await this.w.mkdir(d);
    for (let i = 1; i <= count; i++) await this.createFile(`${d}/${prefix}${String(i).padStart(3, "0")}`, size);
  }

  /** Довести занятость ФС под точкой до pct %. Если задан path — создаётся виртуальный файл, иначе место «пропадает» (du не видит). */
  async fillTo(target: string, pct: number, opts: { path?: string } = {}): Promise<void> {
    const m = this.mountFor(target);
    const scan = await this.scan();
    const u = this.usageOf(m, scan);
    const f = m.dev ? this.dev(m.dev)!.fs! : null;
    const usable = f?.type === "ext4" ? u.size - Math.floor(u.size * 0.05) : u.size;
    const want = Math.floor((usable * pct) / 100);
    const add = Math.max(0, want - u.used);
    if (!add) return;
    if (opts.path) await this.createFile(opts.path, add);
    else if (f) f.filler += add;
    else if (m.tmp) m.tmp.baseUsed += add;
  }

  /** Довести занятость inode до pct %. */
  async fillInodes(target: string, pct: number): Promise<void> {
    const m = this.mountFor(target);
    if (!m.dev) return;
    const f = this.dev(m.dev)!.fs!;
    const u = this.usageOf(m, await this.scan());
    const want = Math.floor((u.itotal * pct) / 100);
    f.extraInodes += Math.max(0, want - u.iused);
  }

  /** Удалённый, но ещё открытый процессом файл: df видит место, du — нет. */
  async leakDeleted(target: string, size: number | string, who: { path?: string; pid?: number; cmd?: string; user?: string } = {}): Promise<void> {
    const m = this.mountFor(target);
    if (!m.dev) return;
    this.dev(m.dev)!.fs!.leaks.push({
      bytes: parseSize(size), path: who.path ?? `${normalize(target)}/old.log`, pid: who.pid ?? 1042, cmd: who.cmd ?? "rsyslogd", user: who.user ?? "root",
    });
  }

  /** Процесс завершён — освободить его удалённые файлы. */
  releaseLeaks(pid?: number): void {
    for (const d of this.devs) if (d.fs) d.fs.leaks = pid === undefined ? [] : d.fs.leaks.filter((l) => l.pid !== pid);
  }

  /** Все удалённые-но-открытые файлы (для lsof +L1). */
  allLeaks(): (Leak & { mount: string })[] {
    return this.mounts.flatMap((m) => (m.dev ? (this.dev(m.dev)!.fs?.leaks ?? []).map((l) => ({ ...l, mount: m.target })) : []));
  }

  // ----- монтирование -----

  /** Снять содержимое каталога (без самого каталога) в снимок и удалить его из ФС. */
  async snapshot(dir: string): Promise<Snapshot> {
    const w = this.w;
    const d = normalize(dir);
    const snap: Snapshot = [];
    const paths = w.subtree(d).filter((p) => p !== d).sort();
    for (const p of paths) {
      let st;
      try {
        st = await w.base.lstat(p);
      } catch {
        continue;
      }
      const o = w.owner(p);
      const rel = p.slice(d === "/" ? 1 : d.length + 1);
      const e: SnapEntry = { rel, kind: st.isSymbolicLink ? "link" : st.isDirectory ? "dir" : "file", mode: st.mode & 0o7777, uid: o.uid, gid: o.gid };
      if (e.kind === "file") e.data = await w.base.readFileBuffer(p);
      if (e.kind === "link") e.target = await w.base.readlink(p);
      const v = this.virt.get(p);
      if (v) e.virt = { ...v };
      snap.push(e);
    }
    for (const e of snap) {
      const p = normalize(`${d}/${e.rel}`);
      if (!e.rel.includes("/")) await w.base.rm(p, { recursive: true, force: true });
    }
    for (const e of snap) {
      const p = normalize(`${d}/${e.rel}`);
      w.owners.delete(p);
      this.virt.delete(p);
    }
    return snap;
  }

  async restore(dir: string, snap: Snapshot): Promise<void> {
    const w = this.w;
    const d = normalize(dir);
    for (const e of snap) {
      const p = normalize(`${d}/${e.rel}`);
      if (e.kind === "dir") {
        if (!(await w.base.exists(p))) await w.base.mkdir(p);
      } else if (e.kind === "link") await w.base.symlink(e.target ?? "", p);
      else await w.base.writeFile(p, e.data ?? new Uint8Array());
      if (e.kind !== "link") await w.base.chmod(p, e.mode);
      w.owners.set(p, { uid: e.uid, gid: e.gid });
      if (e.virt) this.virt.set(p, { ...e.virt });
    }
  }

  /** Служебный код ошибки mount: возвращает текст после «mount: цель: » либо Mount. */
  async doMount(spec: string, targetIn: string, type: string | undefined, optList: string[]): Promise<Mount | string> {
    const target = normalize(targetIn);
    const w = this.w;
    if (!(await w.base.exists(target))) return "mount point does not exist";
    const inf = await w.info(target, true);
    if (inf && !inf.isDir) return "mount point is not a directory";
    const wrong = (dev: string) =>
      `wrong fs type, bad option, bad superblock on ${dev}, missing codepage or helper program, or other error.\n       dmesg(1) may have more information after failed mount system call.`;

    if (type === "tmpfs") {
      const o = buildOpts("tmpfs", optList, Math.floor(this.memTotalKib / 2));
      if (o.bad.length) return `wrong fs type, bad option, bad superblock on ${spec}, missing codepage or helper program, or other error.`;
      const parent = this.mountFor(target);
      const hidden = await this.snapshot(target);
      const m: Mount = {
        id: this.nextMountId++, source: spec, target, fstype: "tmpfs", vfs: o.vfs, fsopts: o.fsopts, acct: true, parentId: parent.id,
        tmp: { size: (o.tmpSizeKib ?? 0) * KiB, baseUsed: 0, inodes: o.tmpInodes ?? 1022946, baseInodes: 1 },
        hidden: hidden.length ? hidden : undefined,
      };
      this.mounts.push(m);
      await this.syncProc();
      return m;
    }

    const dev = this.resolveDev(spec);
    if (!dev) {
      if (/^(UUID|LABEL|PARTUUID)=/.test(spec)) return `can't find ${spec}`;
      return `special device ${spec} does not exist`;
    }
    const fs = dev.fs;
    if (!fs) return wrong(this.devPath(dev));
    if (type && type !== "auto" && type !== fs.type) {
      if (!["xfs", "ext4", "ext3", "ext2", "vfat", "iso9660", "btrfs", "nfs", "tmpfs", "swap"].includes(type)) return `unknown filesystem type '${type}'`;
      return wrong(this.devPath(dev));
    }
    if (fs.type === "swap" || fs.type === "LVM2_member") return `unknown filesystem type '${fs.type}'`;
    const o = buildOpts(fs.type, optList);
    if (o.bad.length) return wrong(this.devPath(dev));
    const already = this.mounts.find((x) => x.dev === dev.name);
    if (already) return `${this.devPath(dev)} already mounted on ${already.target}`;
    const parent = this.mountFor(target);
    const hidden = await this.snapshot(target);
    await this.restore(target, fs.content);
    fs.content = [];
    const m: Mount = {
      id: this.nextMountId++, source: this.devPath(dev), target, fstype: fs.type, vfs: o.vfs, fsopts: o.fsopts, dev: dev.name, acct: true,
      parentId: parent.id, hidden: hidden.length ? hidden : undefined,
    };
    this.mounts.push(m);
    await this.syncProc();
    return m;
  }

  /** Размонтировать. Возвращает текст ошибки (без «umount: цель: ») или null. */
  async doUmount(m: Mount, cwd: string, lazy: boolean): Promise<string | null> {
    if (m.target === "/" || !(m.dev || m.tmp)) return "target is busy";
    if (!lazy) {
      const nested = this.mounts.some((x) => x.id !== m.id && (x.target + "/").startsWith(m.target + "/") && x.target !== m.target);
      const inside = cwd === m.target || cwd.startsWith(m.target + "/");
      if (nested || inside || m.busy) return "target is busy";
    }
    if (m.dev) {
      const f = this.dev(m.dev)!.fs!;
      f.content = await this.snapshot(m.target);
    } else await this.snapshot(m.target);
    if (m.hidden) await this.restore(m.target, m.hidden);
    this.mounts = this.mounts.filter((x) => x.id !== m.id);
    await this.syncProc();
    return null;
  }

  /** Список точек монтирования устройств (для lsblk): [SWAP] для активного swap. */
  mountpointsOf(d: BlockDev): string[] {
    const r = this.mountsOf(d.name).map((m) => m.target);
    if (this.swaps.has(d.name)) r.push("[SWAP]");
    return r;
  }
}
