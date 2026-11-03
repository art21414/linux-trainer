// systemctl restart/start/stop/reload/is-active для служб, которые есть в модели мира (World.services).
// Остальные подкоманды systemctl пока не поддерживаются (см. systemctlStub в storage.ts).
import type { World } from "../world";

const ACTIONS = ["restart", "try-restart", "condrestart", "reload", "reload-or-restart", "try-reload-or-restart", "start", "stop", "is-active"];

/** Служебные процессы сервера по умолчанию: их можно перезапустить. */
export function registerBaseServices(w: World): void {
  const map: [string, string][] = [
    ["sshd", "sshd"], ["crond", "crond"], ["chronyd", "chronyd"], ["NetworkManager", "NetworkManager"], ["tuned", "tuned"],
    ["polkit", "polkitd"], ["dbus-broker", "dbus-broker-launch"], ["systemd-logind", "systemd-logind"], ["rsyslog", "rsyslogd"], ["auditd", "auditd"],
    ["systemd-journald", "systemd-journald"], ["systemd-udevd", "systemd-udevd"],
  ];
  for (const [unit, comm] of map) {
    const p = w.procs.byName(comm)[0];
    if (p) w.services.set(unit, { unit, cmd: p.cmd, user: p.uid, pid: p.pid, comm: p.comm });
  }
}

/** Вернуть результат или null, если подкоманда не наша. */
export function serviceAction(w: World, sub: string, units: string[]): { out: string; err: string; code: number } | null {
  if (!ACTIONS.includes(sub)) return null;
  if (!units.length) return { out: "", err: "Too few arguments.\n", code: 1 };
  let out = "";
  let err = "";
  let code = 0;
  const verb = sub === "condrestart" ? "try-restart" : sub;
  for (const raw of units) {
    const unit = raw.replace(/\.service$/, "");
    const svc = w.services.get(unit);
    if (sub === "is-active") {
      const alive = !!svc && w.procs.isAlive(svc.pid);
      out += (alive ? "active" : "inactive") + "\n";
      if (!alive) code = 3;
      continue;
    }
    if (w.cur.uid !== 0) {
      err += `Failed to ${verb} ${unit}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${unit}.service' for details.\n`;
      code = 1;
      continue;
    }
    if (!svc) {
      err += `Failed to ${verb} ${unit}.service: Unit ${unit}.service not found.\n`;
      code = 5;
      continue;
    }
    const alive = w.procs.isAlive(svc.pid);
    const spawn = () => {
      svc.pid = w.procs.spawn({ cmd: svc.cmd, user: svc.user, ppid: 1, handlesHup: true, leader: true, comm: svc.comm });
    };
    if (sub === "stop") {
      if (alive) w.procs.exit(svc.pid, 15);
    } else if (sub === "start") {
      if (!alive) spawn();
    } else if (sub === "reload") {
      if (!alive) {
        err += `Failed to reload ${unit}.service: Job type reload is not applicable for inactive unit.\n`;
        code = 1;
      } else w.procs.kill(svc.pid, 1, 0);
    } else {
      // restart / try-restart / reload-or-restart: процесс завершается (его дескрипторы закрываются), запускается новый с новым PID
      if (alive) w.procs.exit(svc.pid, 15);
      else if (sub.startsWith("try")) continue;
      spawn();
    }
  }
  return { out, err, code };
}
