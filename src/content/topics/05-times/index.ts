import type { Topic } from "../../types";
import type { World } from "../../../engine/world";
import { guarded, type Guard } from "../../guard";
import theoryMd from "./theory.md?raw";

// ---------- помощники для setup/check ----------
const MIN = 60000;
const HOUR = 3600000;
const DAY = 86400000;
const ago = (ms: number) => new Date(Date.now() - ms);
/** Содержимое /root/answer без краевых пробелов; null — файла нет. */
async function answer(w: World): Promise<string | null> {
  const a = await w.read("/root/answer");
  return a === null ? null : a.trim();
}
const lines = (a: string) =>
  a
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
/** Ответ — ровно этот набор путей (порядок не важен). */
const sameSet = (got: string[], want: string[]) => [...got].sort().join(" ") === [...want].sort().join(" ");

/** Возраст в мс: m — mtime, a — atime, c — ctime (по умолчанию = m). Birth — самый старый из них. */
interface Age {
  m: number;
  a?: number;
  c?: number;
}
/** Поставить времена уже существующему файлу или каталогу. */
async function age(w: World, p: string, t: Age): Promise<void> {
  w.stampCreate(p, ago(Math.max(t.m, t.a ?? 0, t.c ?? t.m)));
  await w.setTimes(p, { mtime: ago(t.m), atime: ago(t.a ?? t.m) }, ago(t.c ?? t.m));
}
/** Создать файл и сразу «состарить». */
async function put(w: World, p: string, content: string, t: Age, mode?: number): Promise<void> {
  await w.write(p, content);
  if (mode !== undefined) await w.fs.chmod(p, mode);
  await age(w, p, t);
}
const mtimeOf = async (w: World, p: string) => (await w.info(p))?.mtime.getTime() ?? null;
const atimeOf = async (w: World, p: string) => (await w.info(p))?.atime.getTime() ?? null;
const fresh = (t: number | null) => t !== null && Date.now() - t < 10 * MIN;

/** Значения из setup, нужные check (у каждого прогона свой мир). */
const saved = new WeakMap<World, number>();

const APP = "listen = 8080\nworkers = 8\nlog = /var/log/myapp\n";
const APP16 = "listen = 8080\nworkers = 16\nlog = /var/log/myapp\n";
const DB = "host = db1\nworkers = 8\n";

/** /etc/myapp: четыре конфига с разной историей. */
async function myapp(w: World, ages: Record<string, Age>, modes: Record<string, number> = {}): Promise<void> {
  const body: Record<string, string> = { "app.conf": APP, "db.conf": DB, "routes.conf": "/api -> 127.0.0.1:9000\n", "cache.conf": "size = 256M\n", "log.conf": "level = info\n" };
  for (const [f, t] of Object.entries(ages)) await put(w, `/etc/myapp/${f}`, body[f], t, modes[f]);
}

const GUARDS: Record<string, Guard> = {
  "times-1-01": {
    keep: ["/etc/myapp"],
    except: ["/etc/myapp/app.conf"],
    reject: ["touch -r /etc/myapp/app.conf /etc/myapp/app.conf.orig"],
  },
  "times-1-02": { keep: ["/etc/myapp"], reject: ["chmod 640 /etc/myapp/*\necho /etc/myapp/db.conf > /root/answer"] },
  "times-1-04": {
    keep: ["/var/log/myapp"],
    except: ["/var/log/myapp/test.log"],
    reject: ['touch -d "2025-10-01 03:00" /var/log/myapp/*'],
  },
  "times-2-01": {
    keep: ["/var/log/myapp"],
    except: ["/var/log/myapp/app.log.3.gz", "/var/log/myapp/app.log.4.gz"],
    reject: ["find /var/log/myapp -mtime +30 -delete"],
  },
  "times-2-02": { keep: ["/etc/myapp"], reject: ["find /etc/myapp -type f -mmin -15 -delete"] },
  "times-2-03": { keep: ["/etc/myapp"], reject: ["mv /etc/myapp /backup/myapp"] },
  "times-2-05": { keep: ["/opt/legacy"], reject: ["find /opt/legacy/conf -type f -atime +90 -delete"] },
  "times-2-06": { keep: ["/srv/cache"], except: ["/srv/cache/keep.dat"], reject: ["rm /srv/cache/junk1.tmp /srv/cache/junk2.tmp\ntouch -a /srv/cache/keep.dat"] },
  "times-3-01": {
    keep: ["/etc/myapp"],
    except: ["/etc/myapp/app.conf"],
    reject: ["touch -r /etc/myapp/app.conf /tmp/ts\nsed -i 's/workers = 8/workers = 16/' /etc/myapp/*.conf\ntouch -r /tmp/ts /etc/myapp/app.conf"],
  },
  "times-3-02": { keep: ["/etc/myapp"], reject: ["touch -d '100 days ago' /etc/myapp/*\necho /etc/myapp/db.conf > /root/answer"] },
  "times-3-03": { keep: ["/srv/spool"], reject: ["rm -rf /srv/spool/print\necho /srv/spool/print > /root/answer"] },
  "times-4-01": {
    keep: ["/srv/backup"],
    except: ["/srv/backup/db.dump.4", "/srv/backup/db.dump.5", "/srv/backup/db.dump.6", "/srv/backup/db.dump.7"],
    reject: ["find /srv/backup -type f -mtime +0 -delete"],
  },
  "times-4-03": { keep: ["/data/ref"], reject: ["rm /data/ref/regions.csv\necho noatime > /root/answer"] },
  "times-exam-01": {
    keep: ["/var/tmp/reports"],
    except: ["/var/tmp/reports/r3.csv", "/var/tmp/reports/r4.csv"],
    reject: ["find /var/tmp/reports -mtime +7 -delete"],
  },
  "times-exam-02": { keep: ["/srv/www"], reject: ["find /srv/www -type f -newer /srv/www/.deployed -delete"] },
  "times-exam-03": { keep: ["/etc/ssh"], reject: ["mv /etc/ssh/sshd_config /etc/ssh/sshd_config.bak"] },
  "times-exam-04": {
    keep: ["/srv/data"],
    except: ["/srv/data/fixture.dat"],
    reject: ["touch -m -d 2025-01-01 /srv/data/*"],
  },
};

export const times: Topic = guarded(
  {
    id: "times",
    n: 5,
    title: "Три времени файла",
    summary: "atime, mtime, ctime и birth, что двигает каждое, relatime и noatime, ls -lu/-lc, stat -c, touch -d/-t/-r/-a/-m, cp -p, find -mtime/-mmin/-cmin/-newer и округление суток",
    level: "base",
    theory: theoryMd,
    sets: [
      {
        id: "1",
        title: "Разминка: какое время что значит",
        exercises: [
          {
            id: "times-1-01",
            type: "terminal",
            theory: "touch",
            prompt:
              "Ты поменял в **/etc/myapp/app.conf** только комментарий. Мониторинг конфигов смотрит на mtime и поднимет тревогу. Верни app.conf время изменения, как у **/etc/myapp/app.conf.orig** (копия, снятая перед правкой через `cp -p`). Правку не откатывай.",
            setup: async (w) => {
              await put(w, "/etc/myapp/app.conf.orig", APP, { m: 40 * DAY });
              await put(w, "/etc/myapp/app.conf", "# tuned by ops\n" + APP, { m: 5 * MIN });
            },
            check: async ({ world }) => {
              const body = await world.base.readFile("/etc/myapp/app.conf").catch(() => null);
              if (body !== "# tuned by ops\n" + APP) return "Содержимое app.conf изменилось — правка должна остаться как есть.";
              const m = await mtimeOf(world, "/etc/myapp/app.conf");
              if (fresh(m)) return false;
              return m === (await mtimeOf(world, "/etc/myapp/app.conf.orig")) || "mtime поменялся, но не совпадает с app.conf.orig. Возьми время прямо у него.";
            },
            hint: "touch умеет взять время у другого файла.",
            solution: "touch -r /etc/myapp/app.conf.orig /etc/myapp/app.conf",
            accept: ["cd /etc/myapp\ntouch -r app.conf.orig app.conf", "touch -m -r /etc/myapp/app.conf.orig /etc/myapp/app.conf"],
            reject: ["cp -p /etc/myapp/app.conf.orig /etc/myapp/app.conf", "touch /etc/myapp/app.conf"],
            explain:
              "`touch -r образец файл` ставит atime и mtime как у образца, содержимое не трогает. Порядок аргументов важен: `touch -r app.conf app.conf.orig` испортил бы время эталона. А `stat` всё равно покажет свежий ctime — ctime руками не выставить.",
          },
          {
            id: "times-1-02",
            type: "terminal",
            theory: "three",
            prompt:
              "Сегодня кто-то открыл на чтение всем один из конфигов в **/etc/myapp** — содержимое при этом не менял. Найди, у какого файла меняли права за последние сутки, и запиши его полный путь в **/root/answer**.",
            setup: async (w) => {
              await myapp(
                w,
                { "app.conf": { m: 30 * DAY }, "db.conf": { m: 30 * DAY, c: 3 * HOUR }, "cache.conf": { m: 20 * DAY }, "log.conf": { m: 30 * DAY } },
                { "app.conf": 0o640, "db.conf": 0o644, "cache.conf": 0o640, "log.conf": 0o640 },
              );
              await age(w, "/etc/myapp", { m: 30 * DAY });
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a);
              if (sameSet(got, ["/etc/myapp/db.conf"])) return true;
              if (got.length === 0) return "Ответ пуст. Содержимое не меняли — значит, mtime старый. Смена прав двигает другое время.";
              if (got.includes("/etc/myapp")) return "В ответе каталог — нужны только файлы (-type f).";
              return "Не тот файл. Права — поле inode: смотри ctime (ls -lc, find -ctime).";
            },
            hint: "chmod не трогает mtime. Какое время меняется при изменении inode?",
            solution: "find /etc/myapp -type f -ctime -1 > /root/answer",
            accept: ["find /etc/myapp -type f -cmin -1440 > /root/answer", "ls -ltc /etc/myapp\necho /etc/myapp/db.conf > /root/answer", "find /etc/myapp -ctime -1 > /root/answer"],
            reject: ["find /etc/myapp -type f -mtime -1 > /root/answer", "ls -lt /etc/myapp | head -2\necho /etc/myapp/log.conf > /root/answer"],
            explain:
              "`chmod` меняет inode, а не данные: mtime стоит на месте, сдвигается только ctime. Поэтому «кто трогал права» ищут через `ls -lc` / `find -ctime`, а `ls -l` тут ничего не покажет.",
          },
          {
            id: "times-1-03",
            type: "choice",
            kind: "predict",
            theory: "three",
            prompt: "Что покажет последняя команда?",
            code: "$ stat -c '%y | %z' app.conf\n2026-10-28 16:40:00.000000000 +0000 | 2026-10-28 16:40:00.000000000 +0000\n$ chmod 600 app.conf\n$ mv app.conf app.conf.bak\n$ stat -c '%y | %z' app.conf.bak",
            options: [
              "Modify прежний (28 октября, 16:40), Change — текущее время",
              "Оба — текущее время: файл переименовали и сменили ему права",
              "Оба прежние: содержимое не менялось, а %z — время создания",
              "Modify — текущее время (mv записал файл под новым именем), Change прежний",
            ],
            answer: 0,
            explain:
              "`chmod` меняет поле inode (права), `mv` — запись в каталоге; данные не трогает ни то, ни другое. Поэтому сдвигается только ctime. mtime двигает лишь запись содержимого. И `%z` — это change, а не creation: время создания — `%w`.",
          },
          {
            id: "times-1-04",
            type: "terminal",
            theory: "touch",
            prompt:
              "Проверяешь ротацию, нужен лог «из прошлого». Поставь **/var/log/myapp/test.log** время изменения **1 октября 2025 года, 03:00** (сервер в UTC). Содержимое не меняй, остальные логи не трогай.",
            setup: async (w) => {
              await put(w, "/var/log/myapp/test.log", "2025-10-01 03:00:01 test entry\n", { m: 2 * MIN });
              await put(w, "/var/log/myapp/app.log", "started\n", { m: 1 * HOUR });
            },
            check: async ({ world }) => {
              const body = await world.base.readFile("/var/log/myapp/test.log").catch(() => null);
              if (body !== "2025-10-01 03:00:01 test entry\n") return "Содержимое test.log изменилось, а менять нужно было только время.";
              const m = await mtimeOf(world, "/var/log/myapp/test.log");
              if (fresh(m)) return false;
              if (m === Date.UTC(2025, 9, 1, 3, 0, 0)) return true;
              const d = new Date(m ?? 0);
              if (d.getUTCFullYear() === 2025 && d.getUTCMonth() === 9 && d.getUTCDate() === 1) return "День верный, а время нет — нужно ровно 03:00.";
              return "Время изменения не то. Проверь stat test.log.";
            },
            hint: "touch -d понимает строку вида «ГГГГ-ММ-ДД ЧЧ:ММ», а у -t свой компактный формат.",
            solution: 'touch -d "2025-10-01 03:00" /var/log/myapp/test.log',
            accept: ["touch -t 202510010300 /var/log/myapp/test.log", "touch -m -d '2025-10-01 03:00:00' /var/log/myapp/test.log"],
            reject: ['echo > /var/log/myapp/test.log\ntouch -d "2025-10-01 03:00" /var/log/myapp/test.log', 'touch -d "2025-10-01" /var/log/myapp/test.log'],
            explain:
              "`touch -d` принимает почти любую дату, `-t` — формат `[[CC]YY]MMDDhhmm[.ss]`. Без `-a`/`-m` меняются оба времени, atime и mtime. Содержимое `touch` не трогает никогда.",
          },
        ],
      },
      {
        id: "2",
        title: "Средние: искать по времени, копировать с временем",
        exercises: [
          {
            id: "times-2-01",
            type: "terminal",
            theory: "find",
            prompt:
              "В **/var/log/myapp** копятся архивы логов. Удали архивы `*.gz`, которые не менялись больше 30 дней. Свежие архивы, текущий лог и README не трогай.",
            setup: async (w) => {
              await put(w, "/var/log/myapp/app.log", "running\n", { m: 2 * HOUR });
              await put(w, "/var/log/myapp/app.log.1.gz", "gz1\n", { m: 2 * DAY });
              await put(w, "/var/log/myapp/app.log.2.gz", "gz2\n", { m: 20 * DAY });
              await put(w, "/var/log/myapp/app.log.3.gz", "gz3\n", { m: 45 * DAY });
              await put(w, "/var/log/myapp/app.log.4.gz", "gz4\n", { m: 75 * DAY });
              await put(w, "/var/log/myapp/README", "logs of myapp\n", { m: 200 * DAY });
            },
            check: async ({ world }) => {
              const left = [];
              for (const f of ["app.log.3.gz", "app.log.4.gz"]) if (await world.info(`/var/log/myapp/${f}`)) left.push(f);
              if (left.length === 2) return false;
              return left.length === 0 || `Ещё остался ${left[0]} — он тоже старше 30 дней.`;
            },
            hint: "find: шаблон имени плюс возраст по mtime в сутках.",
            solution: "find /var/log/myapp -name '*.gz' -mtime +30 -delete",
            accept: [
              "find /var/log/myapp -name '*.gz' -mtime +30 -exec rm {} \\;",
              "find /var/log/myapp -type f -name \"*.gz\" -mtime +30 -exec rm -f {} +",
              "rm /var/log/myapp/app.log.3.gz /var/log/myapp/app.log.4.gz",
            ],
            reject: ["find /var/log/myapp -name '*.gz' -mtime -30 -delete"],
            explain:
              "`-mtime +30` — «больше 30 полных суток назад». Без `-name '*.gz'` под раздачу попал бы и древний README. Перед `-delete` полезно запустить ту же команду без него и посмотреть список.",
          },
          {
            id: "times-2-02",
            type: "terminal",
            theory: "find",
            prompt:
              "10 минут назад прошёл деплой, и приложение упало. Найди в **/etc/myapp** файлы, у которых **содержимое** менялось за последние 15 минут, и запиши полные пути в **/root/answer**, по одному в строке.",
            setup: async (w) => {
              await myapp(w, {
                "app.conf": { m: 5 * MIN },
                "routes.conf": { m: 9 * MIN },
                "db.conf": { m: 3 * HOUR },
                "cache.conf": { m: 10 * DAY, c: 4 * MIN },
                "log.conf": { m: 30 * DAY },
              });
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a);
              if (sameSet(got, ["/etc/myapp/app.conf", "/etc/myapp/routes.conf"])) return true;
              if (got.includes("/etc/myapp/cache.conf")) return "У cache.conf содержимое не меняли — ему сменили права (сдвинулся ctime). Смотри mtime.";
              if (got.includes("/etc/myapp/db.conf")) return "db.conf правили 3 часа назад, до деплоя. Нужна точность в минутах.";
              if (got.includes("/etc/myapp")) return "В ответе каталог — нужны только файлы.";
              return "Список не тот. Нужны файлы с mtime моложе 15 минут.";
            },
            hint: "У find есть тест возраста в минутах. Какое из трёх времён — «содержимое»?",
            solution: "find /etc/myapp -type f -mmin -15 > /root/answer",
            accept: [
              "find /etc/myapp -mmin -15 -type f > /root/answer",
              "ls -lt /etc/myapp\necho /etc/myapp/app.conf > /root/answer\necho /etc/myapp/routes.conf >> /root/answer",
            ],
            reject: ["find /etc/myapp -type f -cmin -15 > /root/answer", "find /etc/myapp -type f -mtime -1 > /root/answer"],
            explain:
              "`-mmin -15` — mtime моложе 15 минут. `-cmin` прихватил бы cache.conf, которому только сменили права, а `-mtime -1` — всё за сутки, включая правку до деплоя.",
          },
          {
            id: "times-2-03",
            type: "terminal",
            theory: "touch",
            prompt:
              "Сделай резервную копию каталога **/etc/myapp** в **/backup/myapp**. Время изменения файлов должно сохраниться: дальше бэкап обновляет rsync, а он сравнивает файлы по размеру и mtime.",
            setup: async (w) => {
              await myapp(w, { "app.conf": { m: 40 * DAY }, "db.conf": { m: 12 * DAY } });
              await put(w, "/etc/myapp/conf.d/cache.conf", "size = 256M\n", { m: 70 * DAY });
              await w.mkdir("/backup");
            },
            check: async ({ world }) => {
              let stale = false;
              for (const f of ["app.conf", "db.conf", "conf.d/cache.conf"]) {
                const src = `/etc/myapp/${f}`;
                const dst = `/backup/myapp/${f}`;
                if (!(await world.info(dst))) return false;
                if ((await world.base.readFile(dst).catch(() => "")) !== (await world.base.readFile(src).catch(() => null))) return `${dst} отличается от оригинала.`;
                if ((await mtimeOf(world, dst)) !== (await mtimeOf(world, src))) stale = true;
              }
              return !stale || "Копия есть, но у файлов сегодняшний mtime — rsync сочтёт изменённым всё. Нужен ключ, сохраняющий время.";
            },
            hint: "Обычный cp ставит копиям время «сейчас». У cp есть ключи, которые сохраняют атрибуты.",
            solution: "cp -a /etc/myapp /backup/",
            accept: ["cp -rp /etc/myapp /backup/myapp", "cp -r --preserve=timestamps /etc/myapp /backup/myapp"],
            reject: ["cp -r /etc/myapp /backup/myapp"],
            explain:
              "`cp -p` сохраняет права, владельца и времена, `cp -a` — то же плюс ссылки и рекурсию. Без них mtime копий — «сейчас», и следующий rsync перегонит каждый файл. `mv` время бы сохранил, но оригинала бы не осталось.",
          },
          {
            id: "times-2-04",
            type: "choice",
            kind: "predict",
            theory: "relatime",
            prompt: "Что покажет последняя команда?",
            code:
              "$ findmnt -no OPTIONS /srv\nrw,relatime,seclabel,attr2,inode64,logbufs=8,logbsize=32k,noquota\n$ date\nSun Nov 22 09:30:00 UTC 2026\n$ stat -c '%x | %y | %z' /srv/app/app.conf\n2026-11-22 08:00:00.000000000 +0000 | 2026-11-20 10:00:00.000000000 +0000 | 2026-11-20 10:00:00.000000000 +0000\n$ cat /srv/app/app.conf > /dev/null\n$ stat -c '%x' /srv/app/app.conf",
            options: [
              "`2026-11-22 08:00:00.000000000 +0000` — atime не сдвинется",
              "`2026-11-22 09:30:00…` — чтение всегда обновляет atime, relatime лишь откладывает запись на диск",
              "`2026-11-22 09:30:00…` — atime отстоит от mtime больше чем на сутки, поэтому обновится",
              "`2026-11-20 10:00:00.000000000 +0000` — при relatime atime приравнивается к mtime",
            ],
            answer: 0,
            explain:
              "relatime обновляет atime, только если он не новее mtime/ctime или если ему больше суток. Здесь atime (08:00 сегодня) уже новее обоих и ему полтора часа — чтение его не трогает. Сутки отсчитываются от самого atime, а не от mtime.",
          },
          {
            id: "times-2-05",
            type: "terminal",
            theory: "find",
            prompt:
              "Перед чисткой **/opt/legacy/conf** выясни, какие файлы никто не **читал** больше 90 дней. Запиши их полные пути в **/root/answer**, по одному в строке. Удалять пока ничего не нужно.",
            setup: async (w) => {
              await put(w, "/opt/legacy/conf/a.conf", "a = 1\n", { m: 300 * DAY, a: 200 * DAY });
              await put(w, "/opt/legacy/conf/b.conf", "b = 1\n", { m: 300 * DAY, a: 2 * DAY });
              await put(w, "/opt/legacy/conf/c.xml", "<c/>\n", { m: 120 * DAY });
              await put(w, "/opt/legacy/conf/d.conf", "d = 1\n", { m: 10 * DAY });
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a);
              if (sameSet(got, ["/opt/legacy/conf/a.conf", "/opt/legacy/conf/c.xml"])) return true;
              if (got.includes("/opt/legacy/conf/b.conf")) return "b.conf старый по mtime, но его читали пару дней назад — смотри atime, а не mtime.";
              return "Список не тот. Нужны файлы с atime старше 90 дней.";
            },
            hint: "Время последнего чтения — atime. У find для него свой тест.",
            solution: "find /opt/legacy/conf -type f -atime +90 > /root/answer",
            accept: [
              "ls -lu /opt/legacy/conf\necho /opt/legacy/conf/a.conf > /root/answer\necho /opt/legacy/conf/c.xml >> /root/answer",
              "find /opt/legacy/conf -atime +90 -type f > /root/answer",
            ],
            reject: ["find /opt/legacy/conf -type f -mtime +90 > /root/answer"],
            explain:
              "«Не читали» — вопрос про atime: `find -atime +90`. При relatime atime обновляется хотя бы раз в сутки при чтении, так что для порога в 90 дней ему можно верить. При `noatime` — нельзя.",
          },
          {
            id: "times-2-06",
            type: "terminal",
            theory: "touch",
            prompt:
              "Каждую ночь в **/srv/cache** работает `find /srv/cache -atime +30 -delete`. Справочник **keep.dat** нужен, но его давно не читали — ночью он удалится. Спаси его: обнови время доступа, а время изменения оставь прежним (по нему отслеживают версию). Остальные файлы пусть удалятся, как обычно.",
            setup: async (w) => {
              await put(w, "/srv/cache/keep.dat", "v=17\n", { m: 60 * DAY, a: 40 * DAY, c: 40 * DAY });
              await put(w, "/srv/cache/junk1.tmp", "tmp\n", { m: 50 * DAY });
              await put(w, "/srv/cache/junk2.tmp", "tmp\n", { m: 45 * DAY });
            },
            check: async ({ world }) => {
              const i = await world.info("/srv/cache/keep.dat");
              if (!i) return "keep.dat пропал.";
              if (Date.now() - i.mtime.getTime() < 59 * DAY) return "У keep.dat сдвинулся mtime, а его нужно было сохранить. Есть ключ, меняющий только atime.";
              for (const j of ["junk1.tmp", "junk2.tmp"]) {
                const a = await atimeOf(world, `/srv/cache/${j}`);
                if (a !== null && Date.now() - a < 30 * DAY) return `Ты освежил и ${j} — мусор теперь тоже переживёт очистку.`;
              }
              return Date.now() - i.atime.getTime() < DAY;
            },
            hint: "touch умеет менять только одно из двух времён.",
            solution: "touch -a /srv/cache/keep.dat",
            accept: ["cat /srv/cache/keep.dat > /dev/null", "touch -a -c /srv/cache/keep.dat"],
            reject: ["touch /srv/cache/keep.dat", "touch -a /srv/cache/*"],
            explain:
              "`touch -a` двигает только atime. Сработал бы и простой `cat`: atime старше суток, и relatime его обновит. А вот повторное чтение через час atime уже не тронет.",
          },
        ],
      },
      {
        id: "3",
        title: "Сложные: правка без следов и следы правки",
        exercises: [
          {
            id: "times-3-01",
            type: "terminal",
            theory: "touch",
            prompt:
              "Подними в **/etc/myapp/app.conf** `workers = 8` до `workers = 16` так, чтобы mtime файла остался прежним: по нему инструмент учёта решает, что файл руками не трогали (с владельцем инструмента договорились). Остальные строки и файлы не меняй.",
            setup: async (w) => {
              await myapp(w, { "app.conf": { m: 25 * DAY }, "db.conf": { m: 25 * DAY } });
              saved.set(w, (await mtimeOf(w, "/etc/myapp/app.conf")) ?? 0);
            },
            check: async ({ world }) => {
              const body = await world.base.readFile("/etc/myapp/app.conf").catch(() => null);
              const m = await mtimeOf(world, "/etc/myapp/app.conf");
              if (body === APP) return m === saved.get(world) ? false : "Содержимое прежнее, а mtime уже другой. Начни заново.";
              if (body !== APP16) return "Содержимое app.conf не то: должна измениться только строка workers.";
              if (fresh(m)) return "Правка есть, но mtime теперь «сейчас». Запомни время до правки и верни его после.";
              return m === saved.get(world) || "mtime в прошлом, но не тот, что был до правки.";
            },
            hint: "Время до правки можно сохранить в файл-метку через touch -r — и потом взять обратно.",
            solution: "touch -r /etc/myapp/app.conf /tmp/ts\nsed -i 's/workers = 8/workers = 16/' /etc/myapp/app.conf\ntouch -r /tmp/ts /etc/myapp/app.conf",
            accept: [
              "cp -p /etc/myapp/app.conf /tmp/app.conf.orig\nsed -i 's/^workers = 8$/workers = 16/' /etc/myapp/app.conf\ntouch -r /tmp/app.conf.orig /etc/myapp/app.conf",
              'T=$(stat -c %y /etc/myapp/app.conf)\nsed -i "s/workers = 8/workers = 16/" /etc/myapp/app.conf\ntouch -d "$T" /etc/myapp/app.conf',
            ],
            reject: ["sed -i 's/workers = 8/workers = 16/' /etc/myapp/app.conf", "echo 'workers = 16' > /tmp/ts\ntouch -r /etc/myapp/app.conf /tmp/ts\ncp /tmp/ts /etc/myapp/app.conf\ntouch -r /tmp/ts /etc/myapp/app.conf"],
            explain:
              "Метка `touch -r app.conf /tmp/ts` запоминает время до правки, `touch -r /tmp/ts app.conf` возвращает его. `ls -l` покажет старую дату, но ctime в `stat` — сегодняшний: эту правку видно всегда.",
          },
          {
            id: "times-3-02",
            type: "terminal",
            theory: "touch",
            prompt:
              "Ночью кто-то поправил один из конфигов в **/etc/myapp** и вернул ему старую дату через `touch`, чтобы в `ls -l` правка не бросалась в глаза. Честные свежие правки (с новым mtime) не в счёт. Найди замаскированный файл и запиши его полный путь в **/root/answer**.",
            setup: async (w) => {
              await myapp(w, {
                "app.conf": { m: 100 * DAY },
                "db.conf": { m: 100 * DAY, c: 5 * HOUR },
                "routes.conf": { m: 3 * HOUR },
                "cache.conf": { m: 50 * DAY },
              });
              await age(w, "/etc/myapp", { m: 100 * DAY });
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a);
              if (sameSet(got, ["/etc/myapp/db.conf"])) return true;
              if (got.includes("/etc/myapp/routes.conf")) return "routes.conf правили честно — mtime у него свежий. Нужен файл со старым mtime, но свежим ctime.";
              return "Не тот файл. touch -d двигает ctime в «сейчас» — сравни mtime и ctime.";
            },
            hint: "touch может поставить любой mtime, но не ctime. Ищи расхождение между ними.",
            solution: "find /etc/myapp -type f -ctime -1 -mtime +0 > /root/answer",
            accept: ["find /etc/myapp -type f -ctime 0 ! -mtime 0 > /root/answer", "ls -ltc /etc/myapp\necho /etc/myapp/db.conf > /root/answer"],
            reject: ["find /etc/myapp -type f -ctime -1 > /root/answer", "find /etc/myapp -type f -mtime -1 > /root/answer"],
            explain:
              "Любое изменение inode, включая `touch -d`, ставит ctime в «сейчас», а выставить ctime руками нельзя. Старый mtime при свежем ctime — признак: сегодня с файлом что-то делали. Это может быть и `chmod`, так что дальше смотрят содержимое и аудит.",
          },
          {
            id: "times-3-03",
            type: "terminal",
            theory: "three",
            prompt:
              "Монитор очереди поднял тревогу: за последний час в одном из каталогов **/srv/spool** удалили задание. Файла уже нет, но каталог это помнит. Найди этот каталог и запиши его полный путь в **/root/answer**.",
            setup: async (w) => {
              await put(w, "/srv/spool/mail/msg1", "From: a\n", { m: 3 * DAY });
              await put(w, "/srv/spool/print/old.ps", "%!PS\n", { m: 5 * DAY });
              await put(w, "/srv/spool/jobs/j1", "job 1\n", { m: 2 * DAY });
              // в msg1 дописали 10 минут назад (каталог от этого не меняется), из print удалили файл 25 минут назад
              await w.setTimes("/srv/spool/mail/msg1", { mtime: ago(10 * MIN) }, ago(10 * MIN));
              await age(w, "/srv/spool/mail", { m: 3 * DAY });
              await age(w, "/srv/spool/print", { m: 25 * MIN, c: 25 * MIN });
              await age(w, "/srv/spool/jobs", { m: 2 * DAY });
              await age(w, "/srv/spool", { m: 10 * DAY });
            },
            check: async ({ world }) => {
              const a = await answer(world);
              if (a === null) return false;
              const got = lines(a);
              if (sameSet(got, ["/srv/spool/print"])) return true;
              if (got.includes("/srv/spool/mail/msg1")) return "msg1 — файл: его дописали, это двигает mtime файла, а не каталога. Нужен каталог.";
              if (got.includes("/srv/spool/mail")) return "В mail правили содержимое файла — таблица имён каталога от этого не меняется.";
              return "Не тот каталог. Удаление имени меняет mtime каталога.";
            },
            hint: "Каталог — таблица имён. Когда имя исчезает, у каталога меняется mtime.",
            solution: "find /srv/spool -mindepth 1 -type d -mmin -60 > /root/answer",
            accept: ["ls -lt /srv/spool\necho /srv/spool/print > /root/answer", "find /srv/spool/* -maxdepth 0 -type d -mmin -60 > /root/answer"],
            reject: ["find /srv/spool -mmin -60 > /root/answer"],
            explain:
              "Создание, удаление и переименование файла меняют таблицу имён каталога — и его mtime. Правка содержимого файла каталог не трогает, поэтому mail «старый», хотя в нём есть свежий файл. Без `-type d` в ответ попал бы и msg1.",
          },
        ],
      },
      {
        id: "4",
        title: "На подумать: округление, подделка, noatime",
        exercises: [
          {
            id: "times-4-01",
            type: "terminal",
            theory: "find",
            prompt:
              "Политика: бэкапы в **/srv/backup** храним 48 часов. Коллега поставил в cron `find /srv/backup -type f -mtime +2 -delete`, а бэкапы двух-трёхсуточной давности всё равно копятся. Удали все бэкапы старше 48 часов, более свежие оставь.",
            setup: async (w) => {
              const hours = [10, 30, 46, 50, 60, 75, 100];
              for (let i = 0; i < hours.length; i++) await put(w, `/srv/backup/db.dump.${i + 1}`, `dump ${i + 1}\n`, { m: hours[i] * HOUR });
            },
            check: async ({ world }) => {
              const left = [];
              for (const n of [4, 5, 6, 7]) if (await world.info(`/srv/backup/db.dump.${n}`)) left.push(n);
              if (left.length === 4) return false;
              if (left.length) return `Остались бэкапы старше 48 часов (db.dump.${left.join(", db.dump.")}). find отбрасывает дробную часть суток — посчитай, что значит +N.`;
              return true;
            },
            hint: "find делит возраст на 24 часа и отбрасывает остаток. +N — «больше N», то есть от N+1 полных суток.",
            solution: "find /srv/backup -type f -mtime +1 -delete",
            accept: ["find /srv/backup -type f -mmin +2880 -delete", "find /srv/backup -type f -mmin +2880 -exec rm {} +"],
            reject: ["find /srv/backup -type f -mtime +2 -delete"],
            explain:
              "Возраст 50 и 60 часов — это «2 суток», а `+2` значит «больше двух», от 72 часов. «Старше 48 часов» — `-mtime +1` или точнее `-mmin +2880`. `-mtime +0` удалил бы всё старше суток, включая свежие бэкапы.",
          },
          {
            id: "times-4-02",
            type: "choice",
            kind: "choice",
            theory: "touch",
            prompt: "Коллега: «app.conf не трогали с марта прошлого года, смотри ls -l». Что на самом деле говорит stat?",
            code:
              "$ ls -l /etc/myapp/app.conf\n-rw-r--r--. 1 root root 270 Mar 10  2025 /etc/myapp/app.conf\n$ stat /etc/myapp/app.conf | tail -4\nAccess: 2026-11-22 03:12:40.118250311 +0000\nModify: 2025-03-10 09:00:00.000000000 +0000\nChange: 2026-11-22 03:12:40.106250311 +0000\n Birth: 2026-11-22 03:12:40.106250311 +0000",
            options: [
              "Этот файл создан сегодня в 03:12, а мартовскую дату ему перенесли (cp -p, tar, touch -d). Что в нём было в марте — отсюда не узнать",
              "Файл не менялся с марта; Change сегодня — потому что в 03:12 его кто-то прочитал",
              "Файл лежит с марта, а сегодня в 03:12 ему только сменили права — содержимое мартовское",
              "Ничего определённого: ctime и birth тоже выставляются через touch -d, так что все даты ненадёжны",
            ],
            answer: 0,
            explain:
              "Birth сегодня — значит, это новый inode: файл создан в 03:12. Mtime в марте ему поставили при копировании с сохранением времени или через `touch -d`. Чтение меняет только atime, а ctime и birth руками не выставить.",
          },
          {
            id: "times-4-03",
            type: "terminal",
            theory: "relatime",
            prompt:
              "Ночной `find /data -atime +30 -delete` удалил справочник, который приложение читает каждый день. Выясни, почему: с какой опцией обновления atime смонтирован **/data**? Запиши её (`relatime`, `noatime` или `strictatime`) в **/root/answer**. Ничего не перемонтируй и не удаляй.",
            setup: async (w) => {
              await w.storage.addDisk("vdd", "1G");
              await w.storage.mkfs("/dev/vdd", "xfs");
              await w.mkdir("/data");
              await w.storage.mount("/dev/vdd", "/data", { options: "noatime" });
              await put(w, "/data/ref/regions.csv", "id,name\n1,north\n", { m: 90 * DAY });
            },
            check: async ({ world }) => {
              const m = world.storage.mountAt("/data");
              if (!m || !m.vfs.includes("noatime")) return "/data перемонтирован или отмонтирован — а нужно было только выяснить опцию.";
              const a = await answer(world);
              if (a === null) return false;
              if (a === "noatime") return true;
              if (a.includes("noatime")) return "Запиши только название опции: noatime.";
              return "Не та опция. Посмотри параметры монтирования /data.";
            },
            hint: "Опции монтирования показывает findmnt.",
            solution: "findmnt -no OPTIONS /data | tr , '\\n' | grep atime > /root/answer",
            accept: ["findmnt /data\necho noatime > /root/answer", "mount | grep /data\necho noatime > /root/answer"],
            reject: ["echo relatime > /root/answer", "umount /data\necho noatime > /root/answer"],
            explain:
              "При `noatime` atime не обновляется вообще: справочник читают каждый день, а atime застыл в момент последнего `touch`. Очистка по atime на такой ФС удаляет живые файлы — для неё нужен mtime или отдельный учёт.",
          },
        ],
      },
    ],
    exam: {
      id: "exam",
      title: "Зачёт",
      exercises: [
        {
          id: "times-exam-01",
          type: "terminal",
          theory: "find",
          prompt: "В **/var/tmp/reports** удали отчёты `*.csv` старше 7 дней. Свежие отчёты и сводный PDF оставь.",
          setup: async (w) => {
            await put(w, "/var/tmp/reports/r1.csv", "r1\n", { m: 1 * DAY });
            await put(w, "/var/tmp/reports/r2.csv", "r2\n", { m: 5 * DAY });
            await put(w, "/var/tmp/reports/r3.csv", "r3\n", { m: 12 * DAY });
            await put(w, "/var/tmp/reports/r4.csv", "r4\n", { m: 40 * DAY });
            await put(w, "/var/tmp/reports/summary.pdf", "%PDF\n", { m: 60 * DAY });
          },
          check: async ({ world }) => {
            const left = [];
            for (const f of ["r3.csv", "r4.csv"]) if (await world.info(`/var/tmp/reports/${f}`)) left.push(f);
            if (left.length === 2) return false;
            return left.length === 0 || `Остался ${left[0]} — он старше 7 дней.`;
          },
          hint: "Шаблон имени и возраст по mtime.",
          solution: "find /var/tmp/reports -name '*.csv' -mtime +7 -delete",
          accept: ["find /var/tmp/reports -type f -name '*.csv' -mtime +7 -exec rm {} +", "rm /var/tmp/reports/r3.csv /var/tmp/reports/r4.csv"],
          reject: ["find /var/tmp/reports -name '*.csv' -mtime -7 -delete"],
          explain: "`-mtime +7` — старше 7 полных суток. Без `-name '*.csv'` ушёл бы и сводный PDF.",
        },
        {
          id: "times-exam-02",
          type: "terminal",
          theory: "find",
          prompt:
            "Момент выкладки сайта записан временем изменения файла **/srv/www/.deployed**. Собери в **/root/answer** полные пути файлов в /srv/www, изменённых **после** выкладки, по одному в строке.",
          setup: async (w) => {
            await put(w, "/srv/www/.deployed", "", { m: 2 * HOUR });
            await put(w, "/srv/www/index.html", "<h1>shop</h1>\n", { m: 1 * HOUR });
            await put(w, "/srv/www/css/site.css", "body{}\n", { m: 30 * MIN });
            await put(w, "/srv/www/about.html", "<p>about</p>\n", { m: 3 * DAY });
            await put(w, "/srv/www/img/logo.png", "PNG\n", { m: 10 * DAY });
            for (const d of ["/srv/www/css", "/srv/www/img", "/srv/www"]) await age(w, d, { m: 3 * DAY });
          },
          check: async ({ world }) => {
            const a = await answer(world);
            if (a === null) return false;
            const got = lines(a);
            if (sameSet(got, ["/srv/www/index.html", "/srv/www/css/site.css"])) return true;
            if (got.includes("/srv/www/.deployed")) return "Сама метка в ответ не входит — нужны файлы, изменённые позже неё.";
            return "Список не тот. Сравни mtime файлов с mtime метки.";
          },
          hint: "У find есть тест «новее, чем такой-то файл».",
          solution: "find /srv/www -type f -newer /srv/www/.deployed > /root/answer",
          accept: ["find /srv/www -newer /srv/www/.deployed -type f > /root/answer", "cd /srv/www\nfind /srv/www -type f -newer .deployed > /root/answer"],
          reject: ["find /srv/www -type f -mtime -1 > /root/answer"],
          explain: "`-newer метка` сравнивает mtime с mtime метки — удобно, когда «с какого момента» записано файлом. `-mtime -1` захватил бы и саму метку.",
        },
        {
          id: "times-exam-03",
          type: "terminal",
          theory: "touch",
          prompt: "Перед правкой сделай копию **/etc/ssh/sshd_config** рядом — **/etc/ssh/sshd_config.bak**, сохранив права и время изменения оригинала.",
          setup: async (w) => {
            await put(w, "/etc/ssh/sshd_config", "PermitRootLogin no\nPasswordAuthentication no\n", { m: 200 * DAY }, 0o600);
          },
          check: async ({ world }) => {
            const b = await world.info("/etc/ssh/sshd_config.bak");
            if (!b) return false;
            const o = await world.info("/etc/ssh/sshd_config");
            if (!o) return false;
            if ((await world.base.readFile("/etc/ssh/sshd_config.bak").catch(() => "")) !== (await world.base.readFile("/etc/ssh/sshd_config").catch(() => null))) return "Копия отличается от оригинала.";
            if ((b.mode & 0o7777) !== 0o600) return "У копии другие права — нужны как у оригинала.";
            return b.mtime.getTime() === o.mtime.getTime() || "Копия есть, но mtime у неё сегодняшний. Нужен ключ, сохраняющий время.";
          },
          hint: "Ключ cp, сохраняющий атрибуты.",
          solution: "cp -p /etc/ssh/sshd_config /etc/ssh/sshd_config.bak",
          accept: ["cp -a /etc/ssh/sshd_config /etc/ssh/sshd_config.bak", "cp --preserve=mode,timestamps /etc/ssh/sshd_config /etc/ssh/sshd_config.bak"],
          reject: ["cp /etc/ssh/sshd_config /etc/ssh/sshd_config.bak"],
          explain: "`cp -p` сохраняет права, владельца и времена. Обычный `cp` ставит mtime «сейчас», `mv` унёс бы оригинал.",
        },
        {
          id: "times-exam-04",
          type: "terminal",
          theory: "touch",
          prompt:
            "Тест ожидает, что **/srv/data/fixture.dat** изменён **1 января 2025 года в 00:00** (UTC). Поставь такое время изменения, а время доступа не трогай — по нему другой тест проверяет кеш.",
          setup: async (w) => {
            await put(w, "/srv/data/fixture.dat", "fixture\n", { m: 2 * DAY, a: 1 * HOUR });
            await put(w, "/srv/data/other.dat", "other\n", { m: 2 * DAY });
            saved.set(w, (await atimeOf(w, "/srv/data/fixture.dat")) ?? 0);
          },
          check: async ({ world }) => {
            const i = await world.info("/srv/data/fixture.dat");
            if (!i) return false;
            if (i.mtime.getTime() !== Date.UTC(2025, 0, 1)) return Date.now() - i.mtime.getTime() < 3 * DAY ? false : "mtime не тот — нужно ровно 2025-01-01 00:00.";
            return i.atime.getTime() === saved.get(world) || "mtime верный, но atime тоже сдвинулся. Есть ключ, меняющий только mtime.";
          },
          hint: "touch без ключей меняет оба времени. Ограничь его одним.",
          solution: "touch -m -d 2025-01-01 /srv/data/fixture.dat",
          accept: ["touch -m -t 202501010000 /srv/data/fixture.dat", "touch -m -d '2025-01-01 00:00' /srv/data/fixture.dat"],
          reject: ["touch -d 2025-01-01 /srv/data/fixture.dat"],
          explain: "`-m` ограничивает `touch` временем изменения, `-a` — временем доступа. Без них меняются оба.",
        },
        {
          id: "times-exam-05",
          type: "choice",
          kind: "predict",
          theory: "view",
          prompt: "Хочешь узнать, какой конфиг читали последним, и запускаешь `ls -lu`. Что верно про этот вывод?",
          code:
            "$ ls -lu\n-rw-r--r--. 1 root root 12 Nov 22 09:10 a.conf\n-rw-r--r--. 1 root root 12 Nov 20 14:00 b.conf\n-rw-r--r--. 1 root root 12 Nov 22 09:40 c.conf",
          options: [
            "Время — atime, но список отсортирован по имени: последним читали c.conf, а сверху он окажется только в ls -ltu",
            "Список отсортирован по atime, сверху — то, что читали последним: a.conf",
            "Время — ctime: -u показывает последнее изменение inode",
            "Время — mtime, а -u только сортирует список по atime",
          ],
          answer: 0,
          explain:
            "По `ls --help`: «-u with -lt: sort by, and show, access time; with -l: show access time and sort by name». С `-l` ключ `-u` меняет колонку времени, но не порядок. Для сортировки нужен ещё `-t`.",
        },
      ],
    },
  },
  GUARDS,
);
