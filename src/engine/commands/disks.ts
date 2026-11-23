// Разделы и метки ФС: fdisk, parted, partprobe, udevadm, mkswap, tune2fs, e2label, xfs_admin.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { bytesToText, fail, ok } from "../util";
import { GiB, KiB, MiB, newFs, parseSize } from "../storage";
import type { BlockDev } from "../storage";

const SECTOR = 512;
const isRoot = (w: World) => w.cur.uid === 0;

/** Размер как у fdisk (size_to_human): одна цифра после запятой, без «.0». */
export function fdiskSize(bytes: number): string {
  const units = ["B", "K", "M", "G", "T", "P"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const r = Math.round(v * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)) + (i ? units[i] : "");
}

/** «1 GiB» / «512 MiB» — для сообщений fdisk. */
function iecSize(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const r = Math.round(v * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} ${units[i]}`;
}

/** Размер как у parted (SI): единица выбирается, пока значение >= 10 (1049kB, 1074MB, 5369MB, 21.5GB). */
export function partedSize(bytes: number): string {
  const units: [string, number][] = [["TB", 1e12], ["GB", 1e9], ["MB", 1e6], ["kB", 1e3]];
  for (const [u, f] of units) {
    if (bytes >= 10 * f) {
      const v = bytes / f;
      return `${v < 100 ? v.toFixed(1) : Math.round(v)}${u}`;
    }
  }
  return bytes >= 1000 ? `${Math.round(bytes / 1e3)}kB` : `${bytes}B`;
}

const DOS_TYPES: Record<string, string> = { "83": "Linux", "8e": "Linux LVM", "82": "Linux swap / Solaris", fd: "Linux raid autodetect", "5": "Extended", "7": "HPFS/NTFS/exFAT", b: "W95 FAT32", ef: "EFI (FAT-12/16/" };
const GPT_TYPES: Record<string, string> = { "83": "Linux filesystem", "8e": "Linux LVM", "82": "Linux swap", fd: "Linux RAID", ef: "EFI System" };
const typeName = (d: BlockDev, id: string) => ((d.ptable === "gpt" ? GPT_TYPES : DOS_TYPES)[id] ?? "Linux");

function diskHeader(d: BlockDev, path = `/dev/${d.name}`): string {
  const sectors = d.size / SECTOR;
  let t = `Disk ${path}: ${iecSize(d.size)}, ${d.size} bytes, ${sectors} sectors\n`;
  t += `Units: sectors of 1 * ${SECTOR} = ${SECTOR} bytes\nSector size (logical/physical): 512 bytes / 512 bytes\nI/O size (minimum/optimal): 512 bytes / 512 bytes\n`;
  if (d.ptable) {
    t += `Disklabel type: ${d.ptable}\n`;
    t += `Disk identifier: ${d.ptable === "dos" ? "0x" + d.diskId : (d.guid ?? "00000000-0000-0000-0000-000000000000").toUpperCase()}\n`;
  }
  return t;
}

function partTable(d: BlockDev, kids: BlockDev[]): string {
  if (!kids.length) return "";
  const gpt = d.ptable === "gpt";
  const anyBoot = kids.some((k) => k.bootable);
  const rows: string[][] = [[gpt ? "Device" : "Device", ...(anyBoot && !gpt ? ["Boot"] : []), "Start", "End", "Sectors", "Size", ...(gpt ? [] : ["Id"]), "Type"]];
  for (const k of kids) {
    const st = (k.start ?? MiB) / SECTOR;
    const sec = k.size / SECTOR;
    rows.push([`/dev/${k.name}`, ...(anyBoot && !gpt ? [k.bootable ? "*" : ""] : []), String(st), String(st + sec - 1), String(sec), fdiskSize(k.size), ...(gpt ? [] : [k.ptype ?? "83"]), typeName(d, k.ptype ?? "83")]);
  }
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  const left = new Set([0, rows[0].indexOf("Boot"), rows[0].length - 1]);
  const lines = rows.map((r) => r.map((cell, c) => (left.has(c) ? cell.padEnd(widths[c]) : cell.padStart(widths[c]))).join(" ").trimEnd());
  return "\n" + lines.join("\n") + "\n";
}

function fdiskList(w: World, d: BlockDev): string {
  return diskHeader(d) + partTable(d, w.storage.children(d.name).filter((k) => k.type === "part").sort((a, b) => (a.start ?? 0) - (b.start ?? 0))) ;
}

// ---------- fdisk ----------

interface WorkPart {
  no: number;
  start: number;
  size: number;
  ptype: string;
  bootable: boolean;
  dev?: BlockDev;
}

export function diskCommands(w: World): Command[] {
  const st = w.storage;

  const fdisk = defineCommand("fdisk", async (args, ctx) => {
    const list = args.includes("-l") || args.includes("--list");
    const devs = args.filter((a) => !a.startsWith("-"));
    if (args.includes("-V")) return ok("fdisk from util-linux 2.37.4\n");
    if (list) {
      const disks = devs.length ? devs.map((x) => st.resolveDev(x)) : st.devs.filter((d) => d.type === "disk");
      let out = "";
      let err = "";
      if (!isRoot(w)) return fail(`fdisk: cannot open ${devs[0] ?? "/dev/vda"}: Permission denied`, 1);
      for (const [i, d] of disks.entries()) {
        if (!d || d.type !== "disk") err += `fdisk: cannot open ${devs[i]}: ${d ? "Not a disk" : "No such file or directory"}\n`;
        else out += (out ? "\n\n" : "") + fdiskList(w, d);
      }
      if (!devs.length) for (const d of st.devs.filter((x) => x.type === "lvm")) out += "\n\n" + diskHeader(d, st.devPath(d));
      return { stdout: out, stderr: err, exitCode: err ? 1 : 0 };
    }
    if (!devs.length) return fail("fdisk: тренажёр: укажи диск, например fdisk /dev/vdb", 1);
    const disk = st.resolveDev(devs[0]);
    if (!disk || disk.type !== "disk") return fail(`fdisk: cannot open ${devs[0]}: No such file or directory`, 1);
    if (!isRoot(w)) return fail(`fdisk: cannot open ${devs[0]}: Permission denied`, 1);

    // рабочая копия: на диск попадёт только по команде w
    let label = disk.ptable;
    let parts: WorkPart[] = st.children(disk.name).filter((k) => k.type === "part").map((k) => ({ no: k.partNo!, start: k.start ?? MiB, size: k.size, ptype: k.ptype ?? "83", bootable: !!k.bootable, dev: k }));
    let out = "Welcome to fdisk (util-linux 2.37.4).\nChanges will remain in memory only, until you decide to write them.\nBe careful before using the write command.\n\n";
    let diskId = disk.diskId!;
    let guid = disk.guid;
    if (!label) {
      label = "dos";
      out += `Device does not contain a recognized partition table.\nCreated a new DOS disklabel with disk identifier 0x${diskId}.\n\n`;
    }
    const lines = bytesToText(ctx.stdin).split("\n");
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    let pos = 0;
    let pending = "";
    const interactive = !lines.length && !!w.readLine;
    const ask = async (q: string): Promise<string | null> => {
      if (interactive) {
        const a = await w.readLine!(pending + q);
        pending = "";
        return a;
      }
      out += pending + q;
      pending = "";
      return pos < lines.length ? lines[pos++] : null;
    };
    const say = (t: string) => {
      if (interactive) pending += t;
      else out += t;
    };
    const maxParts = label === "gpt" ? 128 : 4;
    const total = disk.size / SECTOR;
    const lastSec = () => (label === "gpt" ? total - 34 : total - 1);
    const range = (): { start: number; end: number }[] => {
      const used = [...parts].sort((a, b) => a.start - b.start);
      const r: { start: number; end: number }[] = [];
      let cur = 2048;
      for (const p of used) {
        if (p.start / SECTOR > cur) r.push({ start: cur, end: p.start / SECTOR - 1 });
        cur = Math.max(cur, (p.start + p.size) / SECTOR);
      }
      if (lastSec() >= cur) r.push({ start: Math.ceil(cur / 2048) * 2048, end: lastSec() });
      return r;
    };
    const parseSizeArg = (v: string, first: number, last: number): number | null => {
      const m = /^([+-]?)(\d+)([KMGTPs]?)$/i.exec(v.trim());
      if (!m) return null;
      const n = Number(m[2]);
      if (!m[1]) return m[3] === "" || m[3] === "s" ? n : null;
      const unit = m[3] === "" || m[3] === "s" ? 1 : { k: 2, m: 2048, g: 2097152, t: 2147483648, p: 2199023255552 }[m[3].toLowerCase() as "k"] ?? 1;
      return m[1] === "+" ? first + n * unit - 1 : last - n * unit;
    };
    const help = "\nHelp:\n\n  DOS (MBR)\n   a   toggle a bootable flag\n   b   edit nested BSD disklabel\n   c   toggle the dos compatibility flag\n\n  Generic\n   d   delete a partition\n   F   list free unpartitioned space\n   l   list known partition types\n   n   add a new partition\n   p   print the partition table\n   t   change a partition type\n   v   verify the partition table\n   i   print information about a partition\n\n  Misc\n   m   print this menu\n   u   change display/entry units\n   x   extra functionality (experts only)\n\n  Script\n   I   load disk layout from sfdisk script file\n   O   dump disk layout to sfdisk script file\n\n  Save & Exit\n   w   write table to disk and exit\n   q   quit without saving changes\n\n  Create a new label\n   g   create a new empty GPT partition table\n   G   create a new empty SGI (IRIX) partition table\n   o   create a new empty DOS partition table\n   s   create a new empty Sun partition table\n\n\n";
    for (;;) {
      const cmd = await ask("Command (m for help): ");
      if (cmd === null) break;
      const c = cmd.trim().toLowerCase();
      if (c === "") continue;
      if (c === "q") break;
      if (c === "m") say(help);
      else if (c === "p") {
        const tmp: BlockDev = { ...disk, ptable: label, diskId, guid };
        say("\n" + diskHeader(tmp).replace(/\n$/, "\n") + partTable(tmp, parts.map((p) => ({ name: `${disk.name}${p.no}`, start: p.start, size: p.size, ptype: p.ptype, bootable: p.bootable }) as BlockDev)) + "\n");
      } else if (c === "g") {
        label = "gpt";
        guid = st.newUuid();
        parts = [];
        say(`Created a new GPT disklabel (GUID: ${guid.toUpperCase()}).\n\n`);
      } else if (c === "o") {
        label = "dos";
        parts = [];
        diskId = st.newUuid().slice(0, 8);
        say(`Created a new DOS disklabel with disk identifier 0x${diskId}.\n\n`);
      } else if (c === "n") {
        if (parts.length >= maxParts) {
          say(`If you want to create more than four primary partitions, you must replace a primary partition with an extended partition first.\n\n`);
          continue;
        }
        if (label === "dos") {
          const prim = parts.length;
          const t = await ask(`Partition type\n   p   primary (${prim} primary, 0 extended, ${4 - prim} free)\n   e   extended (container for logical partitions)\nSelect (default p): `);
          if (t === null) break;
          if (t.trim() && t.trim().toLowerCase() !== "p") {
            say(t.trim().toLowerCase() === "e" ? "\nТренажёр: расширенные разделы не поддерживаются, используй primary или gpt.\n\n" : `\nInvalid value.\n`);
            continue;
          }
        }
        const free = Array.from({ length: maxParts }, (_, n) => n + 1).filter((n) => !parts.some((p) => p.no === n));
        const dflt = free[0];
        const noA = await ask(`Partition number (${Math.min(...free)}-${maxParts}, default ${dflt}): `);
        if (noA === null) break;
        const no = noA.trim() ? Number(noA.trim()) : dflt;
        if (!free.includes(no)) {
          say(`Value out of range.\n`);
          continue;
        }
        const regions = range();
        if (!regions.length) {
          say("No free sectors available.\n\n");
          continue;
        }
        const r0 = regions[0];
        const rs = await ask(`First sector (${r0.start}-${r0.end}, default ${r0.start}): `);
        if (rs === null) break;
        const startSec = rs.trim() ? Number(rs.trim()) : r0.start;
        const reg = regions.find((r) => startSec >= r.start && startSec <= r.end);
        if (!reg || Number.isNaN(startSec)) {
          say(`Value out of range.\n`);
          continue;
        }
        const le = await ask(`Last sector, +/-sectors or +/-size{K,M,G,T,P} (${startSec}-${reg.end}, default ${reg.end}): `);
        if (le === null) break;
        const endSec = le.trim() ? parseSizeArg(le, startSec, reg.end) : reg.end;
        if (endSec === null || endSec < startSec || endSec > reg.end) {
          say(`Value out of range.\n`);
          continue;
        }
        parts.push({ no, start: startSec * SECTOR, size: (endSec - startSec + 1) * SECTOR, ptype: "83", bootable: false });
        say(`\nCreated a new partition ${no} of type '${typeName({ ptable: label } as BlockDev, "83")}' and of size ${iecSize((endSec - startSec + 1) * SECTOR)}.\n\n`);
      } else if (c === "d") {
        if (!parts.length) {
          say("No partition is defined yet!\n\n");
          continue;
        }
        let no: number;
        if (parts.length === 1) {
          no = parts[0].no;
          say(`Selected partition ${no}\n`);
        } else {
          const nums = parts.map((p) => p.no).sort((a, b) => a - b);
          const a = await ask(`Partition number (${nums.join(",")}, default ${nums[nums.length - 1]}): `);
          if (a === null) break;
          no = a.trim() ? Number(a.trim()) : nums[nums.length - 1];
          if (!nums.includes(no)) {
            say(`Partition ${no} does not exist.\n\n`);
            continue;
          }
        }
        parts = parts.filter((p) => p.no !== no);
        say(`Partition ${no} has been deleted.\n\n`);
      } else if (c === "t" || c === "a") {
        if (!parts.length) {
          say("No partition is defined yet!\n\n");
          continue;
        }
        let no: number;
        if (parts.length === 1) {
          no = parts[0].no;
          say(`Selected partition ${no}\n`);
        } else {
          const nums = parts.map((p) => p.no).sort((a, b) => a - b);
          const a = await ask(`Partition number (${nums.join(",")}, default ${nums[nums.length - 1]}): `);
          if (a === null) break;
          no = a.trim() ? Number(a.trim()) : nums[nums.length - 1];
        }
        const part = parts.find((p) => p.no === no);
        if (!part) {
          say(`Partition ${no} does not exist.\n\n`);
          continue;
        }
        if (c === "a") {
          part.bootable = !part.bootable;
          say(`The bootable flag on partition ${no} is ${part.bootable ? "enabled" : "disabled"} now.\n\n`);
          continue;
        }
        const code = await ask("Hex code or alias (type L to list all): ");
        if (code === null) break;
        const alias: Record<string, string> = { lvm: "8e", swap: "82", linux: "83", raid: "fd", "8e": "8e", "82": "82", "83": "83", fd: "fd", "44": "8e", "19": "82", "1": "83", "20": "83" };
        const id = alias[code.trim().toLowerCase()];
        if (!id) {
          say(`Type of partition ${no} is unchanged: ${typeName({ ptable: label } as BlockDev, part.ptype)}.\n\n`);
          continue;
        }
        const was = typeName({ ptable: label } as BlockDev, part.ptype);
        part.ptype = id;
        say(`Changed type of partition '${was}' to '${typeName({ ptable: label } as BlockDev, id)}'.\n\n`);
      } else if (c === "w") {
        // применить рабочую копию к диску
        for (const k of st.children(disk.name)) if (!parts.some((p) => p.dev === k && p.start === k.start && p.size === k.size)) await st.removeDev(k.name);
        disk.ptable = label;
        disk.diskId = diskId;
        disk.guid = guid;
        for (const p of parts) {
          if (p.dev && st.dev(p.dev.name)) {
            p.dev.ptype = p.ptype;
            p.dev.bootable = p.bootable;
          } else {
            const nd = await st.createPartition(disk, p.start, p.size, p.ptype);
            nd.bootable = p.bootable;
          }
        }
        await st.syncDev();
        await st.syncProc();
        say("The partition table has been altered.\nCalling ioctl() to re-read partition table.\nSyncing disks.\n");
        break;
      } else say(`${cmd.trim()}: unknown command\n`);
    }
    if (interactive && pending) out += pending;
    return ok(out);
  });

  // ---------- parted ----------

  const parseLoc = (v: string, disk: BlockDev, isEnd: boolean): number | null => {
    const m = /^(-?\d+(?:\.\d+)?)\s*(%|s|B|kB|MB|GB|TB|KiB|MiB|GiB|TiB|k|K|M|G|T)?$/.exec(v.trim());
    if (!m) return null;
    const n = Number(m[1]);
    const u = m[2] ?? "MB";
    const units: Record<string, number> = { B: 1, s: 512, kB: 1000, k: 1024, K: 1024, KiB: 1024, MB: 1e6, M: MiB, MiB: MiB, GB: 1e9, G: GiB, GiB: GiB, TB: 1e12, T: GiB * 1024, TiB: GiB * 1024 };
    if (u === "%") return Math.round((disk.size * n) / 100);
    if (n < 0) return disk.size + n * units[u];
    void isEnd;
    return Math.round(n * units[u]);
  };

  const parted = defineCommand("parted", async (args) => {
    let script = false;
    let listAll = false;
    const rest: string[] = [];
    for (const a of args) {
      if (a === "-s" || a === "--script") script = true;
      else if (a === "-l" || a === "--list") listAll = true;
      else if (a === "-a" || a.startsWith("--align")) continue;
      else if (a === "-v" || a === "--version") return ok("parted (GNU parted) 3.5\nCopyright (C) 2022 Free Software Foundation, Inc.\n");
      else rest.push(a);
    }
    if (!isRoot(w)) return fail("Error: Could not stat device " + (rest[0] ?? "/dev/vda") + " - Permission denied.", 1);
    const printDisk = (d: BlockDev, free = false): string => {
      let t = "";
      if (!d.ptable) t += `Error: /dev/${d.name}: unrecognised disk label\n`;
      t += `Model: Virtio Block Device (virtblk)\nDisk /dev/${d.name}: ${partedSize(d.size)}\nSector size (logical/physical): 512B/512B\nPartition Table: ${d.ptable === "dos" ? "msdos" : (d.ptable ?? "unknown")}\nDisk Flags: \n`;
      const kids = st.children(d.name).filter((k) => k.type === "part").sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
      if (!d.ptable) return t;
      if (!kids.length && !free) return t + "\n";
      const rows: string[][] = [d.ptable === "gpt" ? ["Number", "Start", "End", "Size", "File system", "Name", "Flags"] : ["Number", "Start", "End", "Size", "Type", "File system", "Flags"]];
      const mk = (k: BlockDev) => {
        const s0 = k.start ?? MiB;
        const flags = [k.bootable ? "boot" : "", k.ptype === "8e" ? "lvm" : "", k.ptype === "82" ? "swap" : ""].filter(Boolean).join(", ");
        const fsn = k.fs?.type === "LVM2_member" ? "" : (k.fs?.type ?? "");
        return d.ptable === "gpt"
          ? [` ${k.partNo}`, partedSize(s0), partedSize(s0 + k.size - 1), partedSize(k.size), fsn, k.pname ?? "", flags]
          : [` ${k.partNo}`, partedSize(s0), partedSize(s0 + k.size - 1), partedSize(k.size), "primary", fsn, flags];
      };
      for (const k of kids) rows.push(mk(k));
      const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
      const lines = rows.map((r) => r.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd());
      return t + "\n" + lines.join("\n") + "\n\n";
    };
    if (listAll) {
      let o = "";
      for (const d of st.devs.filter((x) => x.type === "disk")) o += printDisk(d);
      return ok(o);
    }
    const devArg = rest.shift();
    if (!devArg) return fail("parted: тренажёр: укажи диск, например parted /dev/vdb print", 1);
    const disk = st.resolveDev(devArg);
    if (!disk || disk.type !== "disk") return fail(`Error: Could not stat device ${devArg} - No such file or directory.`, 1);
    if (!rest.length) return fail("parted: тренажёр: интерактивный режим не поддерживается, передай команду: parted /dev/vdb print", 1);
    let out = "";
    let i = 0;
    const err = (m: string) => ({ stdout: out, stderr: m, exitCode: 1 });
    while (i < rest.length) {
      const cmd = rest[i++];
      if (cmd === "print" || cmd === "p") {
        const free = rest[i] === "free";
        if (free) i++;
        out += printDisk(disk, free);
      } else if (cmd === "unit") i++;
      else if (cmd === "mklabel" || cmd === "mktable") {
        const t = rest[i++];
        if (t !== "gpt" && t !== "msdos") return err(`Error: Expecting a disk label type.`);
        if (!script && st.children(disk.name).length) return err("Warning: The existing disk label on " + devArg + " will be destroyed and all data on this disk will be lost. Do you want to continue?\nYes/No? тренажёр: используй parted -s");
        for (const k of st.children(disk.name)) await st.removeDev(k.name);
        disk.ptable = t === "gpt" ? "gpt" : "dos";
        if (t === "gpt") disk.guid = st.newUuid();
      } else if (cmd === "mkpart") {
        if (!disk.ptable) return err(`Error: /dev/${disk.name}: unrecognised disk label`);
        const words: string[] = [];
        while (i < rest.length && !["print", "p", "mklabel", "mkpart", "rm", "name", "set", "unit", "resizepart"].includes(rest[i]) && words.length < 4) words.push(rest[i++]);
        // dos: [primary] [fstype] start end; gpt: [name] [fstype] start end
        const [endW, startW] = [words[words.length - 1], words[words.length - 2]];
        if (words.length < 2) return err("Error: Expecting a start/end position.");
        const pre = words.slice(0, -2);
        const startB = parseLoc(startW, disk, false);
        let endB = parseLoc(endW, disk, true);
        if (startB === null || endB === null) return err(`Error: Invalid number.`);
        let s0 = Math.max(startB, MiB);
        s0 = Math.round(s0 / MiB) * MiB;
        if (endB === disk.size) endB = disk.size - (disk.ptable === "gpt" ? 34 * 512 : 0);
        if (endB <= s0) return err("Error: Can't have the end before the start! (start sector=" + s0 / 512 + " length=" + (endB - s0) / 512 + ")");
        const fsHint = pre.find((x) => ["xfs", "ext4", "ext3", "ext2", "linux-swap", "btrfs", "fat32"].includes(x));
        const name = disk.ptable === "gpt" ? pre.find((x) => x !== fsHint) : undefined;
        if (pre.length > 2 || (disk.ptable === "dos" && pre[0] && !["primary", "extended", "logical"].includes(pre[0]))) return err(`Error: Expecting a partition type.`);
        const overlap = st.children(disk.name).some((k) => s0 < (k.start ?? 0) + k.size && endB > (k.start ?? 0));
        if (overlap) return err("Error: Can't have overlapping partitions.");
        if (st.children(disk.name).length >= (disk.ptable === "gpt" ? 128 : 4)) return err("Error: Too many primary partitions.");
        const nd = await st.createPartition(disk, s0, Math.floor((endB - s0) / 512) * 512, fsHint === "linux-swap" ? "82" : "83", name);
        void nd;
      } else if (cmd === "rm") {
        const no = Number(rest[i++]);
        const k = st.children(disk.name).find((x) => x.partNo === no);
        if (!k) return err(`Error: Partition doesn't exist.`);
        await st.removeDev(k.name);
      } else if (cmd === "name") {
        const no = Number(rest[i++]);
        const nm = rest[i++];
        const k = st.children(disk.name).find((x) => x.partNo === no);
        if (!k) return err(`Error: Partition doesn't exist.`);
        k.pname = nm;
      } else if (cmd === "set") {
        const no = Number(rest[i++]);
        const flag = rest[i++];
        const onoff = rest[i++];
        const k = st.children(disk.name).find((x) => x.partNo === no);
        if (!k) return err(`Error: Partition doesn't exist.`);
        if (flag === "lvm") k.ptype = onoff === "on" ? "8e" : "83";
        else if (flag === "swap") k.ptype = onoff === "on" ? "82" : "83";
        else if (flag === "boot") k.bootable = onoff === "on";
      } else return err(`Error: Expecting a command (${cmd}): тренажёр умеет print, mklabel, mkpart, rm, name, set.`);
    }
    await st.syncDev();
    await st.syncProc();
    return ok(out);
  });

  const partprobe = defineCommand("partprobe", async () => (isRoot(w) ? ok() : fail("Error: Could not stat device /dev/vda - Permission denied.", 1)));
  const udevadm = defineCommand("udevadm", async (args) => {
    const sub = args[0];
    if (sub === "settle" || sub === "trigger" || sub === "control") return ok();
    return fail(`udevadm: тренажёр умеет только settle и trigger (запрошено ${sub ?? ""})`, 1);
  });

  // ---------- mkswap, метки ----------

  const mkswap = defineCommand("mkswap", async (args) => {
    let label = "";
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-L") label = args[++i] ?? "";
      else if (args[i] === "-f" || args[i] === "--force") continue;
      else if (args[i].startsWith("-")) return fail(`mkswap: invalid option -- '${args[i].replace(/^-+/, "")}'\nTry 'mkswap --help' for more information.`, 1);
      else rest.push(args[i]);
    }
    if (!rest.length) return fail("mkswap: error: no device specified\nUsage:\n mkswap [options] device [size]", 1);
    const d = st.resolveDev(rest[0]);
    if (!d) return fail(`mkswap: cannot open ${rest[0]}: No such file or directory`, 1);
    if (!isRoot(w)) return fail(`mkswap: cannot open ${rest[0]}: Permission denied`, 1);
    if (st.swaps.has(d.name) || st.mountsOf(d.name).length) return fail(`mkswap: ${rest[0]}: warning: ${st.swaps.has(d.name) ? "swap in use" : "is mounted"}\nmkswap: cannot create swap on a device in use`, 1);
    for (const k of st.children(d.name)) await st.removeDev(k.name);
    const uuid = st.newUuid();
    d.fs = newFs("swap", d.size, uuid, label);
    await st.syncDev();
    const size = d.size - 4096;
    return ok(`Setting up swapspace version 1, size = ${iecSize(size).replace(/ (\w)iB/, " $1iB")} (${size} bytes)\n${label ? `LABEL=${label}, ` : "no label, "}UUID=${uuid}\n`);
  });

  const labelOf = (name: string, args: string[], kind: "ext" | "xfs") => {
    return async (): Promise<ReturnType<typeof ok>> => {
      void name; void args; void kind;
      return ok();
    };
  };
  void labelOf;

  const e2label = defineCommand("e2label", async (args) => {
    const dev = args[0];
    if (!dev) return fail("Usage: e2label device [newlabel]", 1);
    const d = st.resolveDev(dev);
    if (!d) return fail(`e2label: No such file or directory while trying to open ${dev}\nCouldn't find valid filesystem superblock.`, 1);
    if (d.fs?.type !== "ext4") return fail(`e2label: Bad magic number in super-block while trying to open ${dev}\nCouldn't find valid filesystem superblock.`, 1);
    if (args[1] === undefined) return ok((d.fs.label ?? "") + "\n");
    if (!isRoot(w)) return fail(`e2label: Permission denied while trying to open ${dev}\nCouldn't find valid filesystem superblock.`, 1);
    if (args[1].length > 16) return { stdout: "", stderr: "Warning: label too long, truncating.\n", exitCode: 0 };
    d.fs.label = args[1];
    await st.syncDev();
    return ok();
  });

  const tune2fs = defineCommand("tune2fs", async (args) => {
    let label: string | undefined;
    let uuid: string | undefined;
    const rest: string[] = [];
    let list = false;
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-L") label = args[++i];
      else if (args[i] === "-U") uuid = args[++i];
      else if (args[i] === "-l") list = true;
      else if (args[i].startsWith("-")) continue;
      else rest.push(args[i]);
    }
    const dev = rest[0];
    if (!dev) return fail("Usage: tune2fs [-c max_mounts_count] [-e errors_behavior] [-f] [-g group]\n\t[-i interval[d|m|w]] [-j] [-J journal_options] [-l]\n\t[-m reserved_blocks_percent] [-o [^]mount_options[,...]]\n\t[-r reserved_blocks_count] [-u user] [-C mount_count]\n\t[-L volume_label] [-M last_mounted_dir]\n\t[-O [^]feature[,...]] [-Q quota_options]\n\t[-E extended-option[,...]] [-T last_check_time] [-U UUID]\n\t[-I new_inode_size] [-z undo_file] device", 1);
    const d = st.resolveDev(dev);
    if (!d) return fail(`tune2fs: No such file or directory while trying to open ${dev}\nCouldn't find valid filesystem superblock.`, 1);
    if (d.fs?.type !== "ext4") return fail(`tune2fs: Bad magic number in super-block while trying to open ${dev}\n${dev} contains a ${d.fs?.type ?? "unknown"} file system`.replace(/\n.* contains a unknown file system/, "\nCouldn't find valid filesystem superblock."), 1);
    if (!isRoot(w)) return fail(`tune2fs: Permission denied while trying to open ${dev}\nCouldn't find valid filesystem superblock.`, 1);
    if (label !== undefined) d.fs.label = label;
    if (uuid !== undefined) d.fs.uuid = uuid === "random" || uuid === "time" ? st.newUuid() : uuid;
    await st.syncDev();
    void list;
    return ok("tune2fs 1.46.5 (30-Dec-2021)\n");
  });

  const xfsAdmin = defineCommand("xfs_admin", async (args) => {
    let label: string | undefined;
    let showLabel = false;
    let uuid: string | undefined;
    let showUuid = false;
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-L") label = args[++i];
      else if (args[i] === "-l") showLabel = true;
      else if (args[i] === "-u") showUuid = true;
      else if (args[i] === "-U") uuid = args[++i];
      else if (args[i].startsWith("-")) return fail(`xfs_admin: invalid option -- '${args[i].replace(/^-+/, "")}'\nUsage: xfs_admin [-efjlpuV] [-c 0|1] [-L label] [-O v5_feature] [-r rtdev] [-U uuid] device [logdev]`, 2);
      else rest.push(args[i]);
    }
    const dev = rest[0];
    if (!dev) return fail("Usage: xfs_admin [-efjlpuV] [-c 0|1] [-L label] [-O v5_feature] [-r rtdev] [-U uuid] device [logdev]", 2);
    const d = st.resolveDev(dev);
    if (!d || d.fs?.type !== "xfs") {
      return fail(`xfs_db: ${dev} is not a valid XFS filesystem (unexpected SB magic number 0x00000000)\nUsage: xfs_admin [-efjlpuV] [-c 0|1] [-L label] [-O v5_feature] [-r rtdev] [-U uuid] device [logdev]`.replace(/^xfs_db: .*\n/, d ? `xfs_admin: ${dev} is not a valid XFS filesystem (unexpected SB magic number 0x00000000)\nxfs_admin: cannot open ${dev}\n` : `xfs_admin: ${dev}: No such file or directory\n`), 1);
    }
    if (!isRoot(w)) return fail(`xfs_admin: cannot open ${dev}: Permission denied`, 1);
    let out = "";
    if (showLabel) out += `label = "${d.fs.label}"\n`;
    if (showUuid) out += `UUID = ${d.fs.uuid}\n`;
    if (label !== undefined) {
      if (label.length > 12) return fail(`label (${label}) too long (max 12)`, 1);
      if (st.mountsOf(d.name).length === 0 || true) d.fs.label = label === "--" ? "" : label;
      out += `writing all SBs\nnew label = "${d.fs.label}"\n`;
    }
    if (uuid !== undefined) {
      if (st.mountsOf(d.name).length) return fail(`xfs_admin: ${dev}: unable to change UUID of a mounted filesystem`.replace("xfs_admin", "xfs_db"), 1);
      d.fs.uuid = uuid === "generate" ? st.newUuid() : uuid;
      out += `writing all SBs\nnew UUID = ${d.fs.uuid}\n`;
    }
    await st.syncDev();
    return ok(out);
  });

  void parseSize;
  void KiB;
  return [fdisk, parted, partprobe, udevadm, mkswap, e2label, tune2fs, xfsAdmin];
}
