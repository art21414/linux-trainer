import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const DAY = 24 * 60;
const ago = (min: number) => new Date(Date.now() - min * 60_000);
const stamp = (w: World, path: string, min: number) => w.setTimes(path, { mtime: ago(min), atime: ago(min) });
const OLD = new Date("2024-05-05T10:00:00Z");
const sameSecond = (a: Date, b: Date) => Math.floor(a.getTime() / 1000) === Math.floor(b.getTime() / 1000);

/** Номер inode, запомненный в setup (по миру — у каждого прогона свой). */
const inoAtSetup = new WeakMap<World, number>();

/** Права (без типа) или null, если объекта нет. */
async function modeOf(w: World, p: string): Promise<number | null> {
  const i = await w.info(p);
  return i ? i.mode & 0o7777 : null;
}

/** Есть ли в дереве каталога файл с таким содержимым (кроме указанного пути). */
async function hasCopyOf(w: World, dir: string, content: string, except: string): Promise<boolean> {
  for (const p of w.subtree(dir)) {
    if (p === except) continue;
    const i = await w.info(p);
    if (i?.isFile && (await w.read(p)) === content) return true;
  }
  return false;
}

/** Сайт alice: index.html 640 от мая 2024, скрытый .htaccess, css/. */
async function aliceSite(w: World, dir: string) {
  const a = w.user("alice")!;
  await w.mkdir(dir, 0o755, a.uid, a.gid);
  await w.mkdir(`${dir}/css`, 0o755, a.uid, a.gid);
  await w.write(`${dir}/index.html`, "<h1>Shop</h1>\n", 0o640, a.uid, a.gid);
  await w.write(`${dir}/.htaccess`, "Require all denied\n", 0o644, a.uid, a.gid);
  await w.write(`${dir}/css/style.css`, "body{margin:0}\n", 0o644, a.uid, a.gid);
  await w.setTimes(`${dir}/index.html`, { mtime: OLD, atime: OLD });
}

const APP_NEW = "listen = 8080\nworkers = 8\n";
const APP_OLD = "listen = 8080\nworkers = 4\n";

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
  "copy-1-01": { keep: ["/opt"], reject: ["chmod 777 /opt\nmkdir -p /opt/billing/releases/2026-11/conf"] },
  "copy-1-02": { keep: ["/srv/inbox"], reject: ["rm -f /srv/inbox/*\ntouch -- -lock"] },
  "copy-1-03": { keep: ["/srv/scans", "/srv/legal"], reject: ['mv "contract 2026.pdf" /srv/legal/'] },
  "copy-1-04": { keep: ["/var/log/app"], except: ["/var/log/app/debug.log"], reject: ["truncate -s 0 /var/log/app/*"] },
  "copy-2-01": { keep: ["/srv/app"], reject: ["rm -rf /backup/app\nmv /srv/app /backup/app"] },
  "copy-2-02": { keep: ["/etc/ssh"], reject: ["mv /etc/ssh/sshd_config /root/sshd_config.orig"] },
  "copy-2-04": {
    keep: ["/usr/share/app/defaults", "/etc/app"],
    except: ["/etc/app/cache.conf", "/etc/app/log.conf"],
    reject: ["mv /usr/share/app/defaults/cache.conf /usr/share/app/defaults/log.conf /etc/app/"],
  },
  "copy-2-05": { keep: ["/etc/app"], except: ["/etc/app/app.conf"], reject: ["chmod 777 /etc/app\ncp -b /tmp/app.conf /etc/app/app.conf"] },
  "copy-2-06": { keep: ["/srv"], reject: ["chmod 777 /srv\nmkdir -p -m 700 /srv/secrets/vault"] },
  "copy-3-01": {
    keep: ["/etc/nginx"],
    reject: [
      "rm -rf /root/nginx.bak\nmv /etc/nginx /root/nginx.bak",
      "rm -rf /root/nginx.bak/nginx\ncp -r /etc/nginx/. /root/nginx.bak/\nchmod 777 /root/nginx.bak/.htpasswd",
    ],
  },
  "copy-3-02": {
    keep: ["/home/alice/site"],
    reject: [
      "mv /home/alice/site/* /home/alice/site/.htaccess /var/www/html/",
      "cp -a /home/alice/site/. /var/www/html/\nchmod 777 /var/www/html/.htaccess",
    ],
  },
  "copy-3-03": { keep: ["/tmp/repo", "/etc/app"], except: ["/etc/app/a.conf", "/etc/app/c.conf"], reject: ["mv -u /tmp/repo/* /etc/app/"] },
  "copy-exam-01": { keep: ["/etc/nginx"], reject: ["rm -rf /root/nginx.bak\nmv /etc/nginx /root/nginx.bak"] },
  "copy-exam-02": { keep: ["/home/alice/site"], reject: ["mv /home/alice/site /root/site.orig"] },
  "copy-exam-03": { keep: ["/var/log/worker"], except: ["/var/log/worker/worker.log"], reject: ["truncate -s 0 /var/log/worker/*"] },
  "copy-exam-04": { keep: ["/srv/inbox"], reject: ["mv -- -config.yml /etc/app/config.yml"] },
  "copy-exam-05": { keep: ["/srv"], reject: ["chmod 777 /srv\nmkdir -p -m 733 /srv/ftp/upload/incoming"] },
};

export const createCopy: Topic = guarded({
  id: "copy",
  n: 2,
  title: "Создание и копирование файлов",
  summary: "> и noclobber, обнулить лог на месте, mkdir -p -m, имена с пробелом и дефисом, cp -r в существующий каталог, -n/-u/-b, -p и -a",
  level: "base",
  theory: theoryMd,
  sets: [
    {
      id: "1",
      title: "Разминка: создаём",
      exercises: [
        {
          id: "copy-1-01",
          type: "terminal",
          theory: "mkdir",
          prompt:
            "Под новый релиз биллинга нужен каталог **/opt/billing/releases/2026-11/conf**. Пока нет даже /opt/billing. Создай всю цепочку одной командой.",
          check: async ({ world }) => !!(await world.info("/opt/billing/releases/2026-11/conf"))?.isDir,
          hint: "mkdir без ключей создаёт только один уровень.",
          solution: "mkdir -p /opt/billing/releases/2026-11/conf",
          accept: ["mkdir -pv /opt/billing/releases/2026-11/conf", "cd /opt\nmkdir -p billing/releases/2026-11/conf"],
          reject: ["mkdir /opt/billing/releases/2026-11/conf"],
          explain:
            "`-p` создаёт недостающих родителей и не ругается, если каталог уже есть, — поэтому в скриптах пишут именно `mkdir -p`: повторный запуск не падает.",
        },
        {
          id: "copy-1-02",
          type: "terminal",
          theory: "names",
          cwd: "/srv/inbox",
          prompt:
            "Скрипт загрузки считает каталог занятым, если в нём лежит пустой файл **-lock**. Ты в **/srv/inbox** — создай этот файл.",
          setup: async (w) => {
            await w.write("/srv/inbox/order-1001.csv", "id,sum\n1001,500\n");
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/inbox/-lock");
            if (!i) return false;
            if (!i.isFile) return "-lock должен быть файлом, а не каталогом.";
            return true;
          },
          hint: "touch примет -lock за ключи. Как сказать команде, что дальше идут только имена?",
          solution: "touch -- -lock",
          accept: ["touch ./-lock", "touch /srv/inbox/-lock", ": > -lock"],
          reject: ["touch '-lock'"],
          explain:
            "`touch -lock` пытается разобрать `-lock` как ключи и спотыкается на первом же: `invalid option -- 'l'`. Кавычки не помогают — их снимает bash, и touch всё равно видит `-lock`. Работают `--` (конец ключей) и `./-lock`. Перенаправление `> -lock` ключей не разбирает вовсе.",
        },
        {
          id: "copy-1-03",
          type: "terminal",
          theory: "names",
          cwd: "/srv/scans",
          prompt:
            "Юрист просит скан **contract 2026.pdf** из **/srv/scans** в свой каталог **/srv/legal**. Скопируй его — и только его.",
          setup: async (w) => {
            await w.write("/srv/scans/contract 2026.pdf", "%PDF contract 2026\n");
            await w.write("/srv/scans/contract", "%PDF old contract draft\n");
            await w.write("/srv/scans/2026.pdf", "%PDF 2026 price list\n");
            await w.mkdir("/srv/legal");
          },
          check: async ({ world }) => {
            if ((await world.exists("/srv/legal/contract")) || (await world.exists("/srv/legal/2026.pdf")))
              return "В /srv/legal попали чужие файлы (contract или 2026.pdf): либо bash разрезал имя по пробелу, либо шаблон захватил соседей. Начни заново.";
            return (await world.read("/srv/legal/contract 2026.pdf")) === "%PDF contract 2026\n";
          },
          hint: "Пробел для bash — граница между аргументами.",
          solution: 'cp "contract 2026.pdf" /srv/legal/',
          accept: ["cp contract\\ 2026.pdf /srv/legal/", "cp '/srv/scans/contract 2026.pdf' /srv/legal"],
          reject: ["cp contract 2026.pdf /srv/legal/"],
          explain:
            "Без кавычек `cp` получил три аргумента и скопировал `contract` и `2026.pdf` — оба файла существуют, так что ошибки не было. Имя с пробелом берут в кавычки или экранируют `\\ `. В скриптах то же правило: `\"$f\"`.",
        },
        {
          id: "copy-1-04",
          type: "terminal",
          theory: "create",
          prompt:
            "**/var/log/app/debug.log** съел почти весь /var, а приложение пишет в него не переставая и держит открытым. Освободи место: файл должен стать пустым, но остаться **тем же файлом**, чтобы приложение продолжило в него писать.",
          setup: async (w) => {
            await w.write("/var/log/app/debug.log", "DEBUG cache miss key=user:42\n".repeat(4000));
            await w.write("/var/log/app/app.log", "INFO started\n");
            await w.holdOpen("rsyslogd", "/var/log/app/debug.log");
            inoAtSetup.set(w, w.inodes.ino("/var/log/app/debug.log"));
          },
          check: async ({ world }) => {
            const i = await world.info("/var/log/app/debug.log");
            if (!i) return "Файла нет. Приложение по-прежнему пишет в удалённый — место не освободится. Начни заново.";
            if (world.inodes.ino("/var/log/app/debug.log") !== inoAtSetup.get(world))
              return "Файл пуст, но это уже другой файл (новый inode): приложение пишет в старый, удалённый. Нужно обрезать на месте.";
            if (i.size === 1) return "В файле остался перевод строки: echo без аргументов выводит \\n.";
            return i.size === 0;
          },
          hint: "Перенаправление > обрезает файл до нуля, не создавая новый.",
          solution: ": > /var/log/app/debug.log",
          accept: ["truncate -s 0 /var/log/app/debug.log", "cat /dev/null > /var/log/app/debug.log"],
          reject: ["rm -f /var/log/app/debug.log\ntouch /var/log/app/debug.log", "echo > /var/log/app/debug.log"],
          explain:
            "`> file` открывает существующий файл с обрезкой: inode тот же, процесс пишет дальше в него же. `rm` убирает только имя: место занято, пока файл открыт, а новый `debug.log` приложение не видит.",
        },
      ],
    },
    {
      id: "2",
      title: "Средние: cp без сюрпризов",
      exercises: [
        {
          id: "copy-2-01",
          type: "terminal",
          theory: "cp",
          prompt:
            "Вчера сделали копию **/srv/app** в **/backup/app**. Сегодня конфиг в /srv/app обновили. Обнови копию: в /backup/app должны лежать те же файлы, что в /srv/app, на тех же местах.",
          setup: async (w) => {
            await w.write("/srv/app/app.conf", "version=2\n");
            await w.write("/srv/app/.env", "DB_PASS=s3cret\n", 0o600);
            await w.write("/srv/app/lib/util.sh", "#!/bin/bash\n", 0o755);
            await w.write("/backup/app/app.conf", "version=1\n");
            await w.write("/backup/app/lib/util.sh", "#!/bin/bash\n", 0o755);
          },
          check: async ({ world }) => {
            if (!(await world.exists("/srv/app/app.conf"))) return "Исходник /srv/app пострадал — нужна копия, а не перенос. Начни заново.";
            if (await world.exists("/backup/app/app"))
              return "Появился /backup/app/app: если цель — существующий каталог, cp -r кладёт источник внутрь. Убери вложенный каталог и копируй содержимое.";
            if ((await world.read("/backup/app/app.conf")) !== "version=2\n") return false;
            if (!(await world.exists("/backup/app/.env")))
              return "app.conf свежий, но .env не скопировался: * не видит скрытые файлы.";
            if (!(await world.exists("/backup/app/lib/util.sh"))) return "Пропал lib/util.sh — копируй рекурсивно.";
            return true;
          },
          hint: "cp -r в существующий каталог кладёт источник внутрь него. Нужно скопировать содержимое — и скрытые файлы тоже.",
          solution: "cp -r /srv/app/. /backup/app/",
          accept: ["cp -rT /srv/app /backup/app", "rm -rf /backup/app\ncp -r /srv/app /backup/app", "cp -r /srv/app /backup/"],
          reject: ["cp -r /srv/app /backup/app", "cp -r /srv/app/* /backup/app/"],
          explain:
            "`cp -r /srv/app /backup/app` при существующем /backup/app создаёт /backup/app/app, а старые файлы не трогает. `/srv/app/.` — «содержимое, включая скрытые», `-T` — «цель и есть каталог назначения». `/srv/app/*` пропустит .env.",
        },
        {
          id: "copy-2-02",
          type: "terminal",
          theory: "preserve",
          prompt:
            "Перед правкой сохрани оригинал **/etc/ssh/sshd_config** как **/root/sshd_config.orig**. Потом по времени изменения будут понимать, когда конфиг правили в последний раз до тебя, — у копии оно должно остаться как у оригинала.",
          setup: async (w) => {
            await w.write("/etc/ssh/sshd_config", "Port 22\nPermitRootLogin no\nPasswordAuthentication no\n", 0o600);
            await w.setTimes("/etc/ssh/sshd_config", { mtime: OLD, atime: OLD });
          },
          check: async ({ world }) => {
            const src = (await world.info("/etc/ssh/sshd_config"))!;
            const c = await world.info("/root/sshd_config.orig");
            if (!c) return false;
            if ((await world.read("/root/sshd_config.orig")) !== (await world.read("/etc/ssh/sshd_config"))) return "Содержимое копии не совпадает с оригиналом.";
            if (!sameSecond(c.mtime, src.mtime)) return "Копия есть, но её mtime — сейчас. Обычный cp создаёт новый файл со своим временем.";
            if (!sameSecond(src.mtime, OLD)) return "Изменилось время самого оригинала. Начни заново.";
            return true;
          },
          hint: "У cp есть ключ, сохраняющий права, владельца и время.",
          solution: "cp -p /etc/ssh/sshd_config /root/sshd_config.orig",
          accept: ["cp -a /etc/ssh/sshd_config /root/sshd_config.orig", "cp --preserve=timestamps /etc/ssh/sshd_config /root/sshd_config.orig"],
          reject: ["cp /etc/ssh/sshd_config /root/sshd_config.orig"],
          explain:
            "Обычная копия — новый файл: mtime — сейчас, владелец — тот, кто копирует. `-p` сохраняет права, владельца и время, `-a` — ещё и xattr, SELinux-контекст и ссылки (для деревьев).",
        },
        {
          id: "copy-2-03",
          type: "choice",
          kind: "predict",
          theory: "preserve",
          prompt:
            "Файл `/home/alice/site/index.html`: владелец alice, права `640`, mtime — 5 мая 2024. root выполняет команду ниже, umask `022`. Что будет у копии `/var/www/site/index.html`?",
          code: "# cp -r /home/alice/site /var/www/",
          options: [
            "root, права 640, mtime — сейчас",
            "alice, права 640, mtime — 5 мая 2024",
            "root, права 644, mtime — 5 мая 2024",
            "root, права 644, mtime — сейчас",
          ],
          answer: 0,
          explain:
            "Без `-p`/`-a` cp создаёт новый файл: владелец — тот, кто копирует, mtime — сейчас, права — исходные минус umask (640 и 022 дают 640). Права не «сбрасываются» в 644: umask только убирает биты. Сохранить владельца и время — `cp -a`.",
        },
        {
          id: "copy-2-04",
          type: "terminal",
          theory: "cp",
          prompt:
            "Добавь в **/etc/app** недостающие конфиги из **/usr/share/app/defaults**. Те, что в /etc/app уже есть, правили руками — их не трогай.",
          setup: async (w) => {
            await w.write("/usr/share/app/defaults/app.conf", "workers = 2\n");
            await w.write("/usr/share/app/defaults/cache.conf", "size = 64M\n");
            await w.write("/usr/share/app/defaults/log.conf", "level = info\n");
            await w.write("/etc/app/app.conf", "workers = 16  # tuned by ops\n");
          },
          check: async ({ world }) => {
            const app = await world.read("/etc/app/app.conf");
            if (app !== "workers = 16  # tuned by ops\n") return "Ручные правки в /etc/app/app.conf затёрты дефолтом. Начни заново.";
            const cache = await world.read("/etc/app/cache.conf");
            const log = await world.read("/etc/app/log.conf");
            if (cache === "size = 64M\n" && log === "level = info\n") return true;
            if (cache || log) return "Скопированы не все недостающие конфиги.";
            return false;
          },
          hint: "Есть ключ cp, который никогда не перезаписывает существующие файлы.",
          solution: "cp -n /usr/share/app/defaults/* /etc/app/",
          accept: [
            "cp /usr/share/app/defaults/cache.conf /usr/share/app/defaults/log.conf /etc/app/",
            "cp -rn /usr/share/app/defaults/. /etc/app/",
          ],
          reject: ["cp /usr/share/app/defaults/* /etc/app/"],
          explain:
            "По умолчанию cp перезаписывает молча. `-n` (no-clobber) пропускает существующие файлы — тоже молча и с кодом возврата 0, так что в логе скрипта не видно, что что-то не скопировалось.",
        },
        {
          id: "copy-2-05",
          type: "terminal",
          theory: "cp",
          prompt:
            "Новая версия конфига лежит в **/tmp/app.conf**. Обнови **/etc/app/app.conf**, но старую версию оставь рядом, в /etc/app, — на случай отката. Имя для старой версии — любое.",
          setup: async (w) => {
            await w.write("/etc/app/app.conf", APP_OLD);
            await w.write("/tmp/app.conf", APP_NEW);
          },
          check: async ({ world }) => {
            const cur = await world.read("/etc/app/app.conf");
            const saved = await hasCopyOf(world, "/etc/app", APP_OLD, "/etc/app/app.conf");
            if (cur === APP_NEW && saved) return true;
            if (cur === APP_NEW) return "Конфиг обновлён, но старой версии рядом нет — откатываться не на что.";
            if (saved) return "Старая версия сохранена, а конфиг ещё не обновлён.";
            return false;
          },
          hint: "Можно сделать копию вручную, а можно попросить cp сохранить старый файл перед перезаписью.",
          solution: "cp -b /tmp/app.conf /etc/app/app.conf",
          accept: [
            "cp /etc/app/app.conf /etc/app/app.conf.bak\ncp /tmp/app.conf /etc/app/app.conf",
            "cp --backup=numbered /tmp/app.conf /etc/app/app.conf",
          ],
          reject: ["cp /tmp/app.conf /etc/app/app.conf"],
          explain:
            "`cp -b` перед перезаписью сохраняет старый файл как `app.conf~`, `--backup=numbered` — как `app.conf.~1~`, `.~2~`… Ручной `cp … .bak` — тоже честный способ.",
        },
        {
          id: "copy-2-06",
          type: "terminal",
          theory: "mkdir",
          prompt:
            "Создай **/srv/secrets/vault**: vault — только для root (700), а **/srv/secrets** — обычный проходимый каталог (755), через него ходят и в другие подкаталоги.",
          check: async ({ world }) => {
            const v = await modeOf(world, "/srv/secrets/vault");
            const s = await modeOf(world, "/srv/secrets");
            if (v === null) return false;
            if (s !== 0o755) return `У /srv/secrets права ${s?.toString(8)}, а должны быть 755 — через него ходят другие.`;
            if (v !== 0o700) return `У vault права ${v.toString(8)}, а нужны 700.`;
            return true;
          },
          hint: "mkdir умеет задать права при создании. Посмотри в теории, какому каталогу цепочки.",
          solution: "mkdir -p -m 700 /srv/secrets/vault",
          accept: ["mkdir -p /srv/secrets/vault\nchmod 700 /srv/secrets/vault", "mkdir -m 755 /srv/secrets\nmkdir -m 700 /srv/secrets/vault"],
          reject: ["mkdir -p /srv/secrets/vault", "mkdir -p /srv/secrets/vault\nchmod -R 700 /srv/secrets"],
          explain:
            "`-m` задаёт права только последнему каталогу, промежуточные от `-p` получают обычные по umask (755). Здесь это ровно то, что нужно. `chmod -R 700` на верх закрыл бы всю ветку.",
        },
      ],
    },
    {
      id: "3",
      title: "Сложные: бэкапы и выкладка",
      exercises: [
        {
          id: "copy-3-01",
          type: "terminal",
          theory: "cp",
          prompt:
            "Ночной бэкап делает `cp -r /etc/nginx /root/nginx.bak`, и после второй ночи в бэкапе что-то не так. Приведи **/root/nginx.bak** в порядок: он должен повторять текущий /etc/nginx, без лишних вложенных копий.",
          setup: async (w) => {
            await w.write("/etc/nginx/nginx.conf", "worker_processes 4;\n");
            await w.write("/etc/nginx/conf.d/site.conf", "server { listen 443 ssl; }\n");
            await w.write("/etc/nginx/.htpasswd", "admin:$apr1$xyz\n", 0o640);
            // первая ночь — старая копия; вторая ночь легла внутрь
            await w.write("/root/nginx.bak/nginx.conf", "worker_processes 2;\n");
            await w.write("/root/nginx.bak/conf.d/site.conf", "server { listen 80; }\n");
            await w.write("/root/nginx.bak/nginx/nginx.conf", "worker_processes 4;\n");
            await w.write("/root/nginx.bak/nginx/conf.d/site.conf", "server { listen 443 ssl; }\n");
          },
          check: async ({ world }) => {
            if (!(await world.exists("/etc/nginx/nginx.conf"))) return "Пострадал сам /etc/nginx. Начни заново.";
            if (await world.exists("/root/nginx.bak/nginx")) return "Внутри бэкапа всё ещё лежит вложенный nginx — его оставила вторая ночь.";
            const main = await world.read("/root/nginx.bak/nginx.conf");
            const site = await world.read("/root/nginx.bak/conf.d/site.conf");
            if (main !== "worker_processes 4;\n" || site !== "server { listen 443 ssl; }\n")
              return "Вложенного каталога нет, но файлы бэкапа старые. Обнови содержимое /root/nginx.bak.";
            const hp = await world.info("/root/nginx.bak/.htpasswd");
            if (!hp) return "Нет .htpasswd: звёздочка не видит скрытые файлы.";
            if ((hp.mode & 0o7777) !== 0o640) return "У .htpasswd в бэкапе права не 640, как у оригинала, — пароли не должны быть видны всем.";
            return true;
          },
          hint: "Сначала посмотри, что лежит в /root/nginx.bak. Потом — копия содержимого, а не каталога.",
          solution: "rm -rf /root/nginx.bak/nginx\ncp -r /etc/nginx/. /root/nginx.bak/",
          accept: [
            "rm -rf /root/nginx.bak\ncp -r /etc/nginx /root/nginx.bak",
            "rm -rf /root/nginx.bak/nginx\ncp -rT /etc/nginx /root/nginx.bak",
            "rm -rf /root/nginx.bak/nginx\ncp -a /etc/nginx/. /root/nginx.bak/",
          ],
          reject: [
            "cp -r /etc/nginx /root/nginx.bak",
            "rm -rf /root/nginx.bak/nginx\ncp -r /etc/nginx/* /root/nginx.bak/",
            "rm -rf /root/nginx.bak/nginx",
          ],
          explain:
            "Первая ночь создала /root/nginx.bak, вторая — /root/nginx.bak/nginx, а верхние файлы так и остались старыми. Правильная команда для скрипта — `cp -r /etc/nginx/. /root/nginx.bak/` (или `cp -rT`): она одинаково работает и в первый, и в сотый раз.",
        },
        {
          id: "copy-3-02",
          type: "terminal",
          theory: "preserve",
          prompt:
            "Выкладываем сайт alice из **/home/alice/site** в уже существующий пустой **/var/www/html**. Файлы должны остаться её (владелец alice, те же права и время), а `.htaccess` обязательно доехать — без него откроется закрытый раздел.",
          setup: async (w) => {
            await aliceSite(w, "/home/alice/site");
            await w.mkdir("/var/www/html");
          },
          check: async ({ world }) => {
            const alice = world.user("alice")!;
            if (await world.exists("/var/www/html/site")) return "Сайт лёг в /var/www/html/site: цель существует, и cp положил каталог внутрь. Нужно содержимое.";
            const i = await world.info("/var/www/html/index.html");
            if (!i) return false;
            const ht = await world.info("/var/www/html/.htaccess");
            if (!ht) return "Нет .htaccess: * не видит скрытые файлы.";
            if ((ht.mode & 0o7777) !== 0o644 || ht.uid !== alice.uid) return "У .htaccess не те права или владелец, что у оригинала (alice, 644).";
            if (!(await world.exists("/var/www/html/css/style.css"))) return "Не доехал css/ — копируй рекурсивно.";
            if (i.uid !== alice.uid) return "Файлы теперь принадлежат root: обычный cp делает владельцем того, кто копирует.";
            if ((i.mode & 0o7777) !== 0o640 || !sameSecond(i.mtime, OLD)) return "Владелец верный, но права или время изменились.";
            return true;
          },
          hint: "Два вопроса: что сохраняет владельца и время, и как скопировать содержимое каталога со скрытыми файлами.",
          solution: "cp -a /home/alice/site/. /var/www/html/",
          accept: ["cp -aT /home/alice/site /var/www/html", "cp -rp /home/alice/site/. /var/www/html/"],
          reject: [
            "cp -a /home/alice/site/* /var/www/html/",
            "cp -r /home/alice/site/. /var/www/html/",
            "cp -a /home/alice/site /var/www/html",
          ],
          explain:
            "`-a` сохраняет владельца, права, время (и SELinux-контекст — а значит, после выкладки из home нужен `restorecon`). `/.` или `-T` копируют содержимое в существующий каталог вместе со скрытыми.",
        },
        {
          id: "copy-3-03",
          type: "terminal",
          theory: "cp",
          prompt:
            "Раскатай конфиги из выгрузки репозитория **/tmp/repo** в **/etc/app**. Но на сервере кто-то уже сделал хотфикс: файлы в /etc/app, изменённые **позже**, чем их версия в репозитории, не затирай. Остальные — обнови или добавь.",
          setup: async (w) => {
            await w.write("/tmp/repo/a.conf", "a = repo-v5\n");
            await w.write("/tmp/repo/b.conf", "b = repo-v5\n");
            await w.write("/tmp/repo/c.conf", "c = repo-v5\n");
            await w.write("/etc/app/a.conf", "a = v4\n");
            await w.write("/etc/app/b.conf", "b = hotfix\n");
            await stamp(w, "/etc/app/a.conf", 10 * DAY);
            await stamp(w, "/tmp/repo/a.conf", 2 * DAY);
            await stamp(w, "/tmp/repo/b.conf", 2 * DAY);
            await stamp(w, "/tmp/repo/c.conf", 2 * DAY);
            await stamp(w, "/etc/app/b.conf", 60);
          },
          check: async ({ world }) => {
            const a = await world.read("/etc/app/a.conf");
            const b = await world.read("/etc/app/b.conf");
            const c = await world.read("/etc/app/c.conf");
            if (b !== "b = hotfix\n") return "Хотфикс в b.conf затёрт: он был новее версии из репозитория. Начни заново.";
            if (a === "a = v4\n") return "a.conf не обновлён, хотя в репозитории он новее. -n не перезаписывает вообще ничего — нужен другой ключ.";
            return a === "a = repo-v5\n" && c === "c = repo-v5\n";
          },
          hint: "Нужен ключ cp, который сравнивает время источника и цели.",
          solution: "cp -u /tmp/repo/* /etc/app/",
          accept: ["cp -uv /tmp/repo/* /etc/app/", "cp /tmp/repo/a.conf /tmp/repo/c.conf /etc/app/"],
          reject: ["cp /tmp/repo/* /etc/app/", "cp -n /tmp/repo/* /etc/app/"],
          explain:
            "`-u` копирует, только если источник новее цели или цели нет: a.conf обновился, c.conf появился, хотфикс в b.conf уцелел. `-n` пропускает любой существующий файл, даже устаревший.",
        },
      ],
    },
    {
      id: "4",
      title: "На подумать: тихие ловушки",
      exercises: [
        {
          id: "copy-4-01",
          type: "choice",
          kind: "predict",
          theory: "create",
          prompt: "Что произойдёт?",
          code: "$ echo one > log\n$ set -o noclobber\n$ echo two >> log\n$ echo three > log\n$ echo four >| log\n$ cat log",
          options: [
            "Ошибка на `three`, затем `cat` выводит `four`",
            "Ошибка на `two` и на `three`, затем `cat` выводит `four`",
            "Ошибка на `three`, затем `cat` выводит `one`, `two`, `four`",
            "Ошибок нет: `cat` выводит `four`",
          ],
          answer: 0,
          explain:
            "noclobber запрещает только `>` поверх существующего файла: `bash: log: cannot overwrite existing file`. `>>` дописывает как обычно. `>|` — явная перезапись в обход защиты, поэтому в файле остаётся одна строка `four`.",
        },
        {
          id: "copy-4-02",
          type: "choice",
          kind: "predict",
          theory: "cp",
          prompt:
            "root на свежем RHEL 9 вставил в терминал строку из инструкции. `/etc/app/app.conf` существует. Что будет?",
          code: "# cp -f /tmp/app.conf /etc/app/app.conf",
          options: [
            "Спросит `cp: overwrite '/etc/app/app.conf'?`: алиас добавил `-i`, а `-f` вопрос не отменяет",
            "Молча перезапишет: `-f` отменяет `-i` из алиаса",
            "Молча перезапишет: алиасы во вставленных командах не работают",
            "Откажется перезаписывать: `cp: not replacing '/etc/app/app.conf'`",
          ],
          answer: 0,
          explain:
            "В `/root/.bashrc` есть `alias cp='cp -i'`, и строка превращается в `cp -i -f …`. У `cp` ключ `-f` значит «если цель не открывается на запись, удали и попробуй снова» и вопрос не отключает (у `rm` и `mv` — отключает). Без вопроса: `\\cp` или `command cp`.",
        },
        {
          id: "copy-4-03",
          type: "choice",
          kind: "predict",
          theory: "preserve",
          prompt: "`bob.txt` принадлежит bob, права 644, mtime — 1 января 2025. alice (не root) выполняет команду. Что получится?",
          code: "$ cp -p /tmp/share/bob.txt ~/\n$ echo $?",
          options: [
            "Копия alice:alice, права 644, дата 1 января 2025; код 0",
            "`cp: failed to preserve ownership`… `Operation not permitted`; код 1",
            "Копия bob:bob: `-p` сохранил владельца",
            "Копия alice:alice с текущей датой: без права на chown `-p` не сохраняет ничего",
          ],
          answer: 0,
          explain:
            "Отдать файл другому может только root, поэтому у обычного пользователя `cp -p` молча делает копию его собственной: ни ошибки, ни ненулевого кода. Права и время при этом сохраняются. Проверено на Rocky 9.",
        },
      ],
    },
  ],
  exam: {
    id: "exam",
    title: "Зачёт",
    exercises: [
      {
        id: "copy-exam-01",
        type: "terminal",
        theory: "cp",
        prompt:
          "Перед правкой обнови резервную копию **/etc/nginx** в **/root/nginx.bak** — она уже есть, вчерашняя. В итоге /root/nginx.bak должен повторять текущий /etc/nginx.",
        setup: async (w) => {
          await w.write("/etc/nginx/nginx.conf", "worker_processes 4;\n");
          await w.write("/etc/nginx/conf.d/site.conf", "server { listen 443 ssl; }\n");
          await w.write("/root/nginx.bak/nginx.conf", "worker_processes 2;\n");
          await w.write("/root/nginx.bak/conf.d/site.conf", "server { listen 80; }\n");
        },
        check: async ({ world }) => {
          if (await world.exists("/root/nginx.bak/nginx"))
            return "Получился /root/nginx.bak/nginx: cp -r в существующий каталог кладёт источник внутрь. Убери его и копируй содержимое.";
          if (await world.exists("/root/nginx")) return "Копия легла в /root/nginx, а нужна /root/nginx.bak.";
          const main = await world.read("/root/nginx.bak/nginx.conf");
          const site = await world.read("/root/nginx.bak/conf.d/site.conf");
          if (main === "worker_processes 4;\n" && site === "server { listen 443 ssl; }\n") return true;
          if (main === "worker_processes 4;\n") return "nginx.conf свежий, а conf.d/site.conf — нет. Копируй рекурсивно.";
          return false;
        },
        hint: "Цель уже существует — значит, cp -r положит каталог внутрь неё.",
        solution: "cp -r /etc/nginx/. /root/nginx.bak/",
        accept: ["cp -rT /etc/nginx /root/nginx.bak", "rm -rf /root/nginx.bak\ncp -r /etc/nginx /root/nginx.bak"],
        reject: ["cp -r /etc/nginx /root/nginx.bak"],
        explain:
          "Если /root/nginx.bak существует, `cp -r /etc/nginx /root/nginx.bak` создаст /root/nginx.bak/nginx, а старые файлы останутся. `/etc/nginx/.` или `-T` копируют содержимое.",
      },
      {
        id: "copy-exam-02",
        type: "terminal",
        theory: "preserve",
        prompt:
          "Перед миграцией сохрани каталог сайта **/home/alice/site** целиком в **/root/site.orig** (такого каталога ещё нет) — с владельцами, правами, временем и скрытыми файлами.",
        setup: async (w) => aliceSite(w, "/home/alice/site"),
        check: async ({ world }) => {
          const alice = world.user("alice")!;
          if (await world.exists("/root/site.orig/site")) return "Получился /root/site.orig/site — лишний уровень.";
          const i = await world.info("/root/site.orig/index.html");
          if (!i) return false;
          if (!(await world.exists("/root/site.orig/.htaccess"))) return "Нет .htaccess — скрытые файлы потерялись.";
          if (!(await world.exists("/root/site.orig/css/style.css"))) return "Не скопирован css/.";
          if (i.uid !== alice.uid) return "Владелец копий — root. Нужен ключ, который сохраняет владельца.";
          if ((i.mode & 0o7777) !== 0o640 || !sameSecond(i.mtime, OLD)) return "Права или время у копии не как у оригинала.";
          return true;
        },
        hint: "Ключ для бэкапа деревьев сохраняет всё сразу.",
        solution: "cp -a /home/alice/site /root/site.orig",
        accept: ["cp -rp /home/alice/site /root/site.orig", "mkdir /root/site.orig\ncp -a /home/alice/site/. /root/site.orig/"],
        reject: ["cp -r /home/alice/site /root/site.orig", "mkdir /root/site.orig\ncp -a /home/alice/site /root/site.orig"],
        explain:
          "`cp -a` = `-dR --preserve=all`: рекурсивно, с владельцем, правами, временем, ссылками и контекстом. Цели нет — копия становится ею; если бы была, легла бы внутрь.",
      },
      {
        id: "copy-exam-03",
        type: "terminal",
        theory: "create",
        prompt:
          "**/var/log/worker/worker.log** разросся, а worker держит его открытым. Сделай файл пустым так, чтобы worker продолжил писать в тот же файл.",
        setup: async (w) => {
          await w.write("/var/log/worker/worker.log", "job done id=1\n".repeat(5000));
          await w.write("/var/log/worker/worker.err.log", "WARN retry id=7\n");
          await w.holdOpen("rsyslogd", "/var/log/worker/worker.log");
          inoAtSetup.set(w, w.inodes.ino("/var/log/worker/worker.log"));
        },
        check: async ({ world }) => {
          const i = await world.info("/var/log/worker/worker.log");
          if (!i) return "Файл удалён — worker пишет в удалённый, место не освободится. Начни заново.";
          if (world.inodes.ino("/var/log/worker/worker.log") !== inoAtSetup.get(world)) return "Это уже новый файл (другой inode), worker о нём не знает.";
          return i.size === 0;
        },
        hint: "Обрезать файл можно перенаправлением или truncate.",
        solution: "truncate -s 0 /var/log/worker/worker.log",
        accept: [": > /var/log/worker/worker.log"],
        reject: ["rm /var/log/worker/worker.log\ntouch /var/log/worker/worker.log"],
        explain: "`> file` и `truncate -s 0` обрезают тот же inode. `rm` + `touch` создают новый файл, а место старого занято, пока его держит процесс.",
      },
      {
        id: "copy-exam-04",
        type: "terminal",
        theory: "names",
        cwd: "/srv/inbox",
        prompt:
          "Клиент прислал конфиг под именем **-config.yml**, он лежит в **/srv/inbox** (ты там). Скопируй его в **/etc/app/config.yml**.",
        setup: async (w) => {
          await w.write("/srv/inbox/-config.yml", "db: db1\nport: 5432\n");
          await w.mkdir("/etc/app");
        },
        check: async ({ world }) => (await world.read("/etc/app/config.yml")) === "db: db1\nport: 5432\n",
        hint: "Имя начинается с дефиса. Кавычки тут не помогут.",
        solution: "cp -- -config.yml /etc/app/config.yml",
        accept: ["cp ./-config.yml /etc/app/config.yml", "cp /srv/inbox/-config.yml /etc/app/config.yml"],
        reject: ["cp '-config.yml' /etc/app/config.yml"],
        explain: "`cp -config.yml` cp разбирает как ключи. `--` объявляет конец ключей, `./-config.yml` и полный путь не начинаются с дефиса.",
      },
      {
        id: "copy-exam-05",
        type: "terminal",
        theory: "mkdir",
        prompt:
          "Для загрузок подготовь **/srv/ftp/upload/incoming**: incoming — права 733 (писать могут все, а список видит только владелец), промежуточные каталоги — обычные 755. Пока нет даже /srv/ftp.",
        check: async ({ world }) => {
          const inc = await modeOf(world, "/srv/ftp/upload/incoming");
          if (inc === null) return false;
          for (const p of ["/srv/ftp", "/srv/ftp/upload"]) {
            const m = await modeOf(world, p);
            if (m !== 0o755) return `У ${p} права ${m?.toString(8)}, а должны быть 755.`;
          }
          if (inc !== 0o733 && inc !== 0o1733) return `У incoming права ${inc.toString(8)}, нужны 733 (можно 1733 — со sticky).`;
          return true;
        },
        hint: "mkdir создаёт цепочку и задаёт права последнему каталогу одной командой.",
        solution: "mkdir -p -m 733 /srv/ftp/upload/incoming",
        accept: ["mkdir -p /srv/ftp/upload/incoming\nchmod 733 /srv/ftp/upload/incoming", "mkdir -p -m 1733 /srv/ftp/upload/incoming"],
        reject: ["mkdir -p /srv/ftp/upload/incoming", "mkdir -p /srv/ftp/upload/incoming\nchmod -R 733 /srv/ftp"],
        explain: "`-m` действует только на последний каталог цепочки; промежуточные получают права по umask (755). `-m` не зависит от umask: 733 получится ровно 733. Со sticky-битом (1733) ещё лучше — загрузившие не смогут удалять чужие файлы; это тоже засчитывается.",
      },
    ],
  },
}, GUARDS);
