import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const bytes = (n: number) => "x".repeat(n - 1) + "\n";
/** Содержимое /root/answer без краевых пробелов; null — файла нет. */
async function answer(w: World): Promise<string | null> {
  const a = await w.read("/root/answer");
  return a === null ? null : a.trim();
}
async function ls(w: World, dir: string): Promise<string[] | null> {
  try {
    return await w.base.readdir(dir);
  } catch {
    return null;
  }
}
/** Добавить пользователей в (новую) группу и обновить /etc/group. */
async function groupWith(w: World, name: string, members: string[]) {
  const g = w.group(name) ?? w.addGroup(name);
  for (const m of members) w.user(m)!.groups.push(name);
  await w.syncEtc();
  return g;
}
/** Отдельный диск 1 ГиБ (XFS) под /srv: на нём видно, освободилось ли место. */
async function srvDisk(w: World) {
  await w.storage.addDisk("vdd", "1G");
  await w.storage.mkfs("/dev/vdd", "xfs");
  await w.storage.mount("/dev/vdd", "/srv");
}
const usedMiB = async (w: World, p: string) => (await w.storage.usageAt(p)).used / 2 ** 20;
/** pid процесса, державшего файл, — по миру (у каждого прогона свой). */
const pidAtSetup = new WeakMap<World, number>();

/** Удалённый, но открытый лог: /srv/app/logs/debug.log 700 МБ держит служба svc. */
async function leakedLog(w: World, svc: string) {
  await srvDisk(w);
  await w.storage.createFile("/srv/app/logs/debug.log", "700M");
  await w.write("/srv/app/logs/access.log", "GET / 200\n");
  await w.write("/srv/app/app.conf", "listen = 8080\n");
  const { pid } = await w.holdOpen({ service: svc, cmd: `/usr/bin/${svc}` }, "/srv/app/logs/debug.log");
  await w.holdOpen({ service: "httpd", cmd: "/usr/sbin/httpd -DFOREGROUND" }, "/srv/app/logs/access.log");
  await w.fs.rm("/srv/app/logs/debug.log");
  pidAtSetup.set(w, pid);
}

const CONF_OLD = "listen = 8080\nworkers = 4\n";
const CONF_NEW = "listen = 8080\nworkers = 8\n";
const CONFD = "# confd\nbackend = etcd\ntoken = 7f3a9c\n";

// ---------- «соседи целы» (content-standard §4) ----------
// После setup запоминаем состояние деревьев keep; check сначала проверяет, что ничего из них не пострадало
// (кроме except — того, что задание и должно менять). Для файлов — содержимое, mtime, права, владелец;
// для каталогов и ссылок — тип, права, владелец (и цель ссылки). Новые файлы не мешают.
// Разрушительные решения для reject (по одному на задание минимум) — в GUARDS.reject, дописываются в reject задания.
interface Snap { kind: "f" | "d" | "l"; mode: number; uid: number; gid: number; content?: string; mtime?: number; target?: string }
const snaps = new WeakMap<World, Map<string, Snap>>();
async function snapOf(w: World, p: string): Promise<Snap | null> {
  const i = await w.info(p);
  if (!i) return null;
  const s: Snap = { kind: i.isLink ? "l" : i.isDir ? "d" : "f", mode: i.mode & 0o7777, uid: i.uid, gid: i.gid };
  if (s.kind === "f") {
    s.content = await w.base.readFile(p).catch(() => ""); // без w.read: тот сдвигает atime
    s.mtime = i.mtime.getTime();
  }
  if (s.kind === "l") s.target = await w.base.readlink(p).catch(() => "");
  return s;
}
async function keep(w: World, roots: string[]): Promise<void> {
  const m = new Map<string, Snap>();
  for (const r of roots) for (const p of w.subtree(r)) {
    const s = await snapOf(w, p);
    if (s) m.set(p, s);
  }
  snaps.set(w, m);
}
async function damaged(w: World, except: string[] = []): Promise<string | null> {
  for (const [p, s] of snaps.get(w) ?? []) {
    if (except.some((e) => p === e || p.startsWith(e + "/"))) continue;
    const now = await snapOf(w, p);
    if (!now) return `Пропал ${p} — его трогать было нельзя. Начни заново.`;
    if (now.kind !== s.kind) return `${p} подменён — его трогать было нельзя. Начни заново.`;
    if (now.mode !== s.mode || now.uid !== s.uid || now.gid !== s.gid)
      return `У ${p} изменились права или владелец — его трогать было нельзя. Начни заново.`;
    if (now.content !== s.content || now.mtime !== s.mtime || now.target !== s.target)
      return `Изменён ${p} — его трогать было нельзя. Начни заново.`;
  }
  return null;
}
interface Guard { keep: string[]; except?: string[]; reject?: string[] }
/** Навесить «соседи целы» на задания темы. */
function guarded(t: Topic, guards: Record<string, Guard>): Topic {
  for (const set of [...t.sets, t.exam])
    for (const e of set.exercises) {
      const g = guards[e.id];
      if (!g || e.type !== "terminal") continue;
      const setup = e.setup;
      const check = e.check;
      e.setup = async (w) => {
        if (setup) await setup(w);
        await keep(w, g.keep);
      };
      e.check = async (c) => (await damaged(c.world, g.except)) ?? check(c);
      if (g.reject) e.reject = [...(e.reject ?? []), ...g.reject];
    }
  return t;
}

const GUARDS: Record<string, Guard> = {
  "move-1-01": {
    keep: ["/etc/app"],
    except: ["/etc/app/app.conf", "/etc/app/app.conf.old"],
    reject: ["rm /etc/app/logging.conf\nmv /etc/app/app.conf /etc/app/app.conf.old\nmv /tmp/app.conf.new /etc/app/app.conf"],
  },
  "move-1-02": { keep: ["/srv/releases"], except: ["/srv/releases/v1"], reject: ["rm -r /srv/releases/v1 /srv/releases/v2"] },
  "move-1-03": { keep: ["/home/alice/uploads"], except: ["/home/alice/uploads/-rf"] },
  "move-2-01": { keep: ["/var/www"], except: ["/var/www/html"], reject: ["rm -rf /var/www/html\nmv /srv/build /var/www/html"] },
  "move-2-02": {
    keep: ["/srv/ci"],
    except: ["/srv/ci/work/build", "/srv/ci/work/.cache", "/srv/ci/work/.lock", "/srv/ci/work/log.txt"],
    reject: ["rm -rf /srv/ci/work/* /srv/ci/work/.[!.]* /srv/ci/agent.conf"],
  },
  "move-2-04": { keep: ["/srv/app"], reject: ["lsof +L1 | awk 'NR==2 {print $2}' > /root/answer\nkill $(pidof myapp)"] },
  "move-2-05": {
    keep: ["/srv/export"],
    except: ["/srv/export/a.txt", "/srv/export/b.txt", "/srv/export/q3 sales.txt"],
    reject: ["rm -f /srv/export/README.md\ncd /srv/export\nfor f in *.txt; do mv -- \"$f\" \"${f%.txt}.csv\"; done"],
  },
  "move-3-01": { keep: ["/srv/app"], reject: ["rm -rf /srv/app/logs\n: > /proc/$(pidof myapp)/fd/3"] },
  "move-3-02": { keep: ["/etc/confd"], except: ["/etc/confd/confd.conf"], reject: ["rm -f /etc/confd/confd.local\ncp /proc/$(pidof confd)/fd/3 /etc/confd/confd.conf"] },
  "move-3-03": {
    keep: ["/archive", "/srv/incoming"],
    except: ["/srv/incoming/2026-11"],
    reject: ["rm -rf /archive/2026-11\nmv /srv/incoming/2026-11 /archive/"],
  },
  "move-exam-01": { keep: ["/srv/inbox/keep"], reject: ["rm -rf /srv/inbox/*"] },
  "move-exam-02": { keep: ["/srv/app"], reject: ["rm -rf /srv/app/logs\nsystemctl restart logd"] },
  "move-exam-03": { keep: ["/srv/dev-share"], except: ["/srv/dev-share"], reject: ["chmod 777 /srv/dev-share"] },
  "move-exam-04": {
    keep: ["/var/cache/app"],
    except: ["/var/cache/app/tmp1", "/var/cache/app/tmp2"],
    reject: ["rm -rf /var/cache/app/*"],
  },
  "move-exam-05": {
    keep: ["/srv/photos"],
    except: ["/srv/photos/IMG_001.JPG", "/srv/photos/IMG_002.JPG", "/srv/photos/team photo.JPG"],
    reject: ["rm /srv/photos/notes.txt\ncd /srv/photos\nfor f in *.JPG; do mv -- \"$f\" \"${f%.JPG}.jpg\"; done"],
  },
};

