// rm (защита корня), man и заглушки для команд, которых ещё нет в тренажёре.
import { defineCommand } from "just-bash";
import type { Command } from "just-bash";
import type { World } from "../world";
import { resolve } from "../path";
import { fail } from "../util";

/** Команды, которые есть в RHEL, но тренажёр их пока не умеет. Пополняем по журналу. */
export const UNSUPPORTED = [
  "systemctl", "journalctl", "dnf", "yum", "rpm", "ip", "ss", "nmcli", "nmtui", "firewall-cmd", "ping", "curl", "wget",
  "ps", "top", "htop", "kill", "killall", "pkill", "pgrep", "nice", "renice", "free", "uptime", "df", "mount", "umount",
  "lsblk", "blkid", "fdisk", "parted", "mkfs", "mkfs.xfs", "mkfs.ext4", "pvcreate", "vgcreate", "lvcreate", "lvextend",
  "getfacl", "setfacl", "getenforce", "setenforce", "semanage", "restorecon", "chcon", "sestatus", "chage", "crontab",
  "at", "tuned-adm", "podman", "ssh", "scp", "rsync", "vi", "vim", "nano", "less", "more", "lsof", "dmesg",
  "last", "w", "who", "lscpu", "timedatectl", "chronyc", "localectl", "visudo", "sudoedit", "newgrp", "gpasswd",
];

export function miscCommands(w: World, onUnsupported: (name: string) => void): Command[] {
  const rm = defineCommand("rm", async (args, ctx) => {
    const recursive = args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive");
    const noPreserve = args.includes("--no-preserve-root");
    const targets = args.filter((a) => !a.startsWith("-"));
    if (recursive && !noPreserve && targets.some((t) => resolve(ctx.cwd, t) === "/")) {
      return fail("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe");
    }
    if (recursive && targets.length > 3 && targets.every((t) => /^\/[^/]+$/.test(t)) && w.cur.uid === 0) {
      // rm -rf /* — сервер жалко, просто не даём
      return fail("тренажёр: rm -rf /* заблокирован. Палыч упал в обморок, но сервер жив.");
    }
    return ctx.origCommand!(args);
  });

  const man = defineCommand("man", async (args) => {
    if (!args.length) return fail("What manual page do you want?\nFor example, try 'man man'.");
    return fail(`тренажёр: man пока не завезли. Попробуй ${args[args.length - 1]} --help — у многих команд работает.`, 16);
  });

  const stubs = UNSUPPORTED.map((name) =>
    defineCommand(name, async () => {
      onUnsupported(name);
      w.unsupported.push(name);
      return fail(`${name}: в RHEL такая команда есть, но тренажёр её пока не умеет (записал в журнал)`, 127);
    }),
  );

  const uname = defineCommand("uname", async (args) => {
    const kernel = "5.14.0-570.17.1.el9_6.x86_64";
    const host = w.hostname;
    const all = `Linux ${host} ${kernel} #1 SMP PREEMPT_DYNAMIC Wed May 21 10:08:46 UTC 2025 x86_64 x86_64 x86_64 GNU/Linux`;
    const f = args.join("");
    if (f.includes("a")) return { stdout: all + "\n", stderr: "", exitCode: 0 };
    const parts: string[] = [];
    if (!f || f.includes("s")) parts.push("Linux");
    if (f.includes("n")) parts.push(host);
    if (f.includes("r")) parts.push(kernel);
    if (f.includes("m")) parts.push("x86_64");
    return { stdout: parts.join(" ") + "\n", stderr: "", exitCode: 0 };
  });

  return [rm, man, uname, ...stubs];
}
